// IF Imgen - per-message pipeline: paragraphs -> planner LLM -> N images -> insert in place.
// Each image is also recorded in message.extra.ifimgen so it can be regenerated later.
import { splitParagraphs, insertAfterParagraphs, imageSnippet, stripImages, countImages, replaceImageUrl, removeImageByUrl, migrateLegacyImages, safeImageUrl } from './paragraphs.js';
import { renderPlannerPrompt, parsePlan, findPreset } from './presets.js';
import { resolveEntities, rosterText } from './entities.js';
import { compilePrompt, effectiveParams } from './prompt.js';
import { expandScene, buildRefinePrompt } from './scene.js';
import { clamp } from './util.js';

/** @typedef {{ url:string, p:number, scene:string, expanded:string, refined:string, prompt:string, negative:string, mode:string, backend:string, model:string, at:number }} ImageRecord */
/** @typedef {{ url:string, scene:string, prompt:string, negative:string, mode:string, backend:string, model:string, at:number }} TestRecord */

const MAX_TEST_IMAGES = 60;

export function createPipeline({ settings, getContext, backends, llm, saveImage, save = () => {}, log = () => {}, onChange = () => {} }) {
    const inflight = new Map(); // messageId -> AbortController
    const TEST_KEY = -1;        // inflight key for test renders

    /**
     * Identity of the open chat, used ONLY to decide which IF Imgen entities are
     * bound (auto-loaded). Avatar filenames / chat id are opaque identifiers;
     * no card text (description, personality, scenario...) is ever read.
     */
    function chatIdentity(ctx) {
        const chatId = (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId) ?? '';
        const charAvatar = ctx.characters?.[ctx.characterId]?.avatar ?? '';
        const personaAvatar = ctx.powerUserSettings?.persona_avatar ?? ctx.userAvatar ?? '';
        return { chatId: String(chatId), charAvatar, personaAvatar };
    }

    function contextText(ctx, messageId, k) {
        const out = [];
        for (let i = messageId - 1; i >= 0 && out.length < k; i--) {
            const m = ctx.chat[i];
            if (!m || m.is_system) continue;
            out.unshift(`${m.is_user ? 'User' : m.name}: ${stripImages(m.mes).slice(0, 800)}`);
        }
        return out.join('\n\n');
    }

    function setMessageText(ctx, messageId, text) {
        const m = ctx.chat[messageId];
        m.mes = text;
        if (Array.isArray(m.swipes) && typeof m.swipe_id === 'number') m.swipes[m.swipe_id] = text;
        ctx.updateMessageBlock(messageId, m);
        try { onChange(messageId); } catch { /* UI hook must never break the pipeline */ }
    }

    /** @returns {ImageRecord[]} live array on message.extra */
    function records(msg) {
        msg.extra ??= {};
        if (!Array.isArray(msg.extra.ifimgen)) msg.extra.ifimgen = [];
        return msg.extra.ifimgen;
    }
    const findRecord = (msg, url) => records(msg).find(r => r.url === url) ?? null;

    /** @returns {TestRecord[]} live array in extension settings */
    function testList() {
        settings.data ??= {};
        if (!Array.isArray(settings.data.testImages)) settings.data.testImages = [];
        return settings.data.testImages;
    }

    /**
     * Compile a planner scene -> final prompt with the current entities/style/settings.
     * mode 'plan'   : tokens ($yenka, $yenka.back) expanded verbatim, cast fragments prepended by compiler.
     * mode 'refine' : second LLM call merges cast base + referenced details + scene into one prompt.
     */
    async function compileScene(ctx, scene, backendId, signal) {
        const g = settings.generate;
        const ident = chatIdentity(ctx);
        const ents = resolveEntities(settings, { text: scene, ...ident });
        const ex = expandScene({ scene, characters: ents.characters, personas: ents.personas });
        if (ex.unknown.length) log('unresolved tokens dropped:', ex.unknown);
        let refined = '';
        if (g.mode === 'refine') {
            const msgs = buildRefinePrompt({ system: g.refineSystem, dialect: g.dialect, scene, expanded: ex.text, used: ex.used, characters: ents.characters, personas: ents.personas, style: ents.style });
            refined = (await llm.chat({ ...msgs, signal })).replace(/^["'`\s]+|["'`\s]+$/g, '');
            if (!refined) throw new Error('Refine LLM returned an empty prompt.');
        }
        const { prompt, negative } = compilePrompt({ scene: refined || ex.text, ...ents, settings, backend: backendId, merged: Boolean(refined) });
        return { prompt, negative, ents, expanded: ex.text, refined, unknown: ex.unknown };
    }

    /**
     * Preview helper: compile the SAME scene both ways regardless of the active mode.
     * plan   = no LLM; refine = one LLM call (errors are returned, not thrown).
     */
    async function compileBoth(scene, signal) {
        const ctx = getContext();
        const backendId = backends.active().id;
        const g = settings.generate;
        const ident = chatIdentity(ctx);
        const ents = resolveEntities(settings, { text: scene, ...ident });
        const ex = expandScene({ scene, characters: ents.characters, personas: ents.personas });
        const plan = compilePrompt({ scene: ex.text, ...ents, settings, backend: backendId, merged: false });
        let refine = null;
        try {
            const msgs = buildRefinePrompt({ system: g.refineSystem, dialect: g.dialect, scene, expanded: ex.text, used: ex.used, characters: ents.characters, personas: ents.personas, style: ents.style });
            const refined = (await llm.chat({ ...msgs, signal })).replace(/^["'`\s]+|["'`\s]+$/g, '');
            if (!refined) throw new Error('Refine LLM returned an empty prompt.');
            refine = { refined, ...compilePrompt({ scene: refined, ...ents, settings, backend: backendId, merged: true }) };
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
            refine = { error: e.message };
        }
        return { ents, expanded: ex.text, unknown: ex.unknown, plan, refine };
    }

    /** Send a final prompt to the active backend and save the PNG. No compile step. */
    async function renderRaw(ctx, { prompt, negative }, signal, status) {
        const backend = backends.active();
        const params = effectiveParams(settings, backend.id);
        status('rendering…');
        const b64 = await backend.generate({ prompt, negative, params }, signal);
        const url = safeImageUrl(await saveImage(b64, ctx.characters?.[ctx.characterId]?.name || 'IF_Imgen'));
        return { url, backend: backend.id, model: params.model ?? '' };
    }

    async function render(ctx, { scene, p }, signal, status) {
        const backend = backends.active();
        if (settings.generate.mode === 'refine') status('refining prompt…');
        const { prompt, negative, ents, expanded, refined } = await compileScene(ctx, scene, backend.id, signal);
        log(`compiled [chars: ${ents.characters.map(e => e.name).join(',') || '-'} | personas: ${ents.personas.map(e => e.name).join(',') || '-'} | style: ${ents.style?.name ?? '-'}]`, prompt);
        const { url, model } = await renderRaw(ctx, { prompt, negative }, signal, status);
        /** @type {ImageRecord} */
        const rec = { url, p, scene, expanded, refined, prompt, negative, mode: settings.generate.mode, backend: backend.id, model, at: Date.now() };
        return rec;
    }

    /**
     * @param {number} messageId
     * @param {{ count?: number, presetId?: string, force?: boolean, onStatus?: (s:string)=>void }} [opt]
     */
    async function run(messageId, opt = {}) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg || msg.is_user || msg.is_system) return { skipped: 'not a character message' };
        if (inflight.has(messageId)) return { skipped: 'already running' };
        if (!opt.force && countImages(msg.mes) > 0) return { skipped: 'already has images' };

        // force on a message that already has images = full regenerate: plan again on the clean text.
        const replacing = opt.force && countImages(msg.mes) > 0;
        const baseText = replacing ? stripImages(msg.mes) : msg.mes;

        const g = settings.generate;
        const count = clamp(opt.count ?? g.imagesPerResponse, 1, 8);
        const paragraphs = splitParagraphs(baseText, g.minParagraphChars);
        if (!paragraphs.length) return { skipped: 'no usable paragraphs' };

        const controller = new AbortController();
        inflight.set(messageId, controller);
        const status = s => { log(`#${messageId} ${s}`); opt.onStatus?.(s); };
        const ident = chatIdentity(ctx);
        const originalText = msg.mes;
        try {
            status('planning…');
            const preset = findPreset(settings, opt.presetId ?? g.presetId);
            const { system, user } = renderPlannerPrompt(preset, {
                paragraphs, count, dialect: g.dialect,
                roster: rosterText(settings, ident),
                context: contextText(ctx, messageId, g.contextMessages),
            });
            const reply = await llm.chat({ system, user, signal: controller.signal });
            const plan = parsePlan(reply, paragraphs.map(p => p.index)).slice(0, count);
            if (!plan.length) throw new Error('Planner returned no usable JSON plan.');
            log('plan', plan);

            const made = [];
            for (let i = 0; i < plan.length; i++) {
                status(`image ${i + 1}/${plan.length} (paragraph ${plan[i].p})…`);
                made.push(await render(ctx, { scene: plan[i].prompt, p: plan[i].p }, controller.signal, status));
            }

            // Stale check: the message may have been swiped/edited while generating.
            if (ctx.chat[messageId]?.mes !== originalText) return { skipped: 'message changed during generation', generated: made.length };
            if (replacing) records(msg).length = 0;
            records(msg).push(...made);
            setMessageText(ctx, messageId, insertAfterParagraphs(baseText, paragraphs, made.map(r => ({ p: r.p, snippet: imageSnippet(r.url) }))));
            await ctx.saveChat();
            status(`done (${made.length} image${made.length > 1 ? 's' : ''})`);
            return { generated: made.length };
        } catch (e) {
            if (e?.name === 'AbortError') { status('cancelled'); return { skipped: 'cancelled' }; }
            status(`error: ${e.message}`);
            throw e;
        } finally {
            inflight.delete(messageId);
        }
    }

    /**
     * Re-render one image in place. `scene` overrides the stored planner scene;
     * entities/style/settings are re-applied at compile time, so edits to
     * characters or styles take effect without touching the chat by hand.
     */
    async function regenerate(messageId, url, { scene, onStatus } = {}) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) throw new Error('Message not found.');
        if (inflight.has(messageId)) throw new Error('This message is already generating.');
        const rec = findRecord(msg, url);
        const useScene = String(scene ?? rec?.scene ?? '').trim();
        if (!useScene) throw new Error('No stored prompt for this image — use "Edit & regenerate" and type one.');
        const controller = new AbortController();
        inflight.set(messageId, controller);
        const status = s => { log(`#${messageId} regen ${s}`); onStatus?.(s); };
        try {
            const fresh = await render(ctx, { scene: useScene, p: rec?.p ?? 0 }, controller.signal, status);
            const list = records(msg);
            const i = list.findIndex(r => r.url === url);
            if (i >= 0) list[i] = fresh; else list.push(fresh);
            setMessageText(ctx, messageId, replaceImageUrl(msg.mes, url, fresh.url));
            await ctx.saveChat();
            status('done');
            return fresh;
        } catch (e) {
            if (e?.name === 'AbortError') { status('cancelled'); return null; }
            status(`error: ${e.message}`);
            throw e;
        } finally {
            inflight.delete(messageId);
        }
    }

    /**
     * Re-render EVERY image of a message with its stored scene and position
     * (no new planning). Images without a stored scene (legacy) are skipped.
     * @returns {Promise<{ regenerated:number, skipped:number }>}
     */
    async function regenerateAll(messageId, { onStatus } = {}) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) throw new Error('Message not found.');
        if (inflight.has(messageId)) throw new Error('This message is already generating.');
        const list = records(msg).filter(r => msg.mes.includes(r.url));
        if (!list.length) return { regenerated: 0, skipped: 0, none: true };
        const controller = new AbortController();
        inflight.set(messageId, controller);
        const status = s => { log(`#${messageId} regen-all ${s}`); onStatus?.(s); };
        let regenerated = 0, skipped = 0;
        try {
            for (let i = 0; i < list.length; i++) {
                const rec = list[i];
                if (!String(rec.scene ?? '').trim()) { skipped++; continue; }
                status(`image ${i + 1}/${list.length}…`);
                const fresh = await render(ctx, { scene: rec.scene, p: rec.p ?? 0 }, controller.signal, status);
                const all = records(msg);
                const j = all.findIndex(r => r.url === rec.url);
                if (j >= 0) all[j] = fresh; else all.push(fresh);
                setMessageText(ctx, messageId, replaceImageUrl(msg.mes, rec.url, fresh.url));
                regenerated++;
            }
            await ctx.saveChat();
            status(`done (${regenerated})`);
            return { regenerated, skipped };
        } catch (e) {
            if (e?.name === 'AbortError') { status('cancelled'); return { regenerated, skipped, cancelled: true }; }
            status(`error: ${e.message}`);
            throw e;
        } finally {
            inflight.delete(messageId);
        }
    }

    async function removeImage(messageId, url) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) return;
        const list = records(msg);
        const i = list.findIndex(r => r.url === url);
        if (i >= 0) list.splice(i, 1);
        setMessageText(ctx, messageId, removeImageByUrl(msg.mes, url));
        await ctx.saveChat();
    }

    async function clear(messageId) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) return;
        if (msg.extra) msg.extra.ifimgen = [];
        setMessageText(ctx, messageId, stripImages(msg.mes));
        await ctx.saveChat();
    }

    // ---- test images (Prompt preview). Final prompt goes to the backend as-is; stored in extension settings, not in any chat.
    async function runTest({ prompt, negative, scene = '', mode = 'plan', onStatus } = {}) {
        const final = String(prompt ?? '').trim();
        if (!final) throw new Error('Prompt is empty.');
        if (inflight.has(TEST_KEY)) throw new Error('A test image is already rendering.');
        const controller = new AbortController();
        inflight.set(TEST_KEY, controller);
        const status = s => { log(`test ${s}`); onStatus?.(s); };
        try {
            const { url, backend, model } = await renderRaw(getContext(), { prompt: final, negative: String(negative ?? '') }, controller.signal, status);
            /** @type {TestRecord} */
            const rec = { url, scene, prompt: final, negative: String(negative ?? ''), mode, backend, model, at: Date.now() };
            const list = testList();
            list.unshift(rec);
            if (list.length > MAX_TEST_IMAGES) list.length = MAX_TEST_IMAGES;
            save();
            try { onChange(TEST_KEY); } catch { /* ignore */ }
            status('done');
            return rec;
        } catch (e) {
            if (e?.name === 'AbortError') { status('cancelled'); return null; }
            status(`error: ${e.message}`);
            throw e;
        } finally {
            inflight.delete(TEST_KEY);
        }
    }

    async function regenerateTest(url, { prompt, onStatus } = {}) {
        const list = testList();
        const i = list.findIndex(r => r.url === url);
        if (i < 0) throw new Error('Test image not found.');
        const old = list[i];
        const fresh = await runTest({ prompt: prompt ?? old.prompt, negative: old.negative, scene: old.scene, mode: old.mode, onStatus });
        if (!fresh) return null;
        // runTest() put the fresh record at index 0; drop the old one.
        const j = list.findIndex(r => r.url === url);
        if (j >= 0) list.splice(j, 1);
        save();
        return fresh;
    }

    function removeTest(url) {
        const list = testList();
        const i = list.findIndex(r => r.url === url);
        if (i >= 0) { list.splice(i, 1); save(); }
    }

    /**
     * Upgrade v0.1/v0.2 snippets (title form, raw URLs) in the current chat to the
     * bare form and keep their prompts in message.extra. Runs on chat load.
     */
    async function migrateChat() {
        const ctx = getContext();
        let changed = 0;
        (ctx.chat ?? []).forEach((m, id) => {
            if (!m?.mes || !m.mes.includes('![IF Imgen](')) return;
            const r = migrateLegacyImages(m.mes);
            if (!r.changed) return;
            const list = records(m);
            for (const { url, title } of r.recovered) if (!list.some(x => x.url === url)) list.push({ url, p: 0, scene: '', expanded: '', refined: '', prompt: title, negative: '', mode: '', backend: '', model: '', at: 0 });
            setMessageText(ctx, id, r.mes);
            changed++;
        });
        if (changed) { await ctx.saveChat(); log(`migrated ${changed} message(s) to bare image form`); }
        return changed;
    }

    return {
        run, regenerate, regenerateAll, removeImage, clear, migrateChat,
        runTest, regenerateTest, removeTest, testImages: () => testList().slice(),
        cancel(messageId) {
            if (messageId === undefined) { for (const c of inflight.values()) c.abort(); return; }
            inflight.get(messageId)?.abort();
        },
        isRunning: id => inflight.has(id),
        recordFor: (messageId, url) => findRecord(getContext().chat[messageId] ?? {}, url),
        compilePreview: (scene, signal) => compileScene(getContext(), scene, backends.active().id, signal),
        compileBoth,
    };
}
