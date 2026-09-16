// IF Imgen - per-message pipeline: paragraphs -> planner LLM -> N images -> insert in place.
// Each image is also recorded in message.extra.ifimgen so it can be regenerated later.
// Refine mode per reply: planner (1 call) -> scene setting (1 call) -> ONE batch refine for ALL images (1 call).
import { splitParagraphs, insertAfterParagraphs, imageSnippet, stripImages, countImages, replaceImageUrl, removeImageByUrl, migrateLegacyImages, safeImageUrl } from './paragraphs.js';
import { renderPlannerPrompt, parsePlan, findPreset } from './presets.js';
import { resolveEntities, rosterText } from './entities.js';
import { compilePrompt, effectiveParams } from './prompt.js';
import { expandScene, buildSettingPrompt, buildRefinePrompt, parseRefined } from './scene.js';
import { clamp } from './util.js';

/** @typedef {{ url:string, p:number, scene:string, expanded:string, setting:string, refined:string, prompt:string, negative:string, mode:string, backend:string, model:string, at:number }} ImageRecord */
/** @typedef {{ url:string, scene:string, prompt:string, negative:string, mode:string, backend:string, model:string, at:number }} TestRecord */

const MAX_TEST_IMAGES = 60;
// Regenerate keeps the replaced image as an older VERSION of the same slot (rec.history, newest first).
const MAX_VERSIONS = 8;
const stripHistory = r => { const { history, ...rest } = r; return rest; };

export function createPipeline({ settings, getContext, backends, llm, saveImage, save = () => {}, log = () => {}, onChange = () => {} }) {
    const inflight = new Map(); // messageId -> AbortController
    const TEST_KEY = -1;        // inflight key for test renders

    // Job observers (UI progress strip). Every start / end / status text of any image job goes through here.
    const watchers = new Set();
    let lastStatus = '';
    const jobState = () => ({ running: inflight.size, ids: [...inflight.keys()], status: lastStatus });
    const notify = () => { const st = jobState(); for (const fn of watchers) { try { fn(st); } catch { /* UI must not break the pipeline */ } } };
    const begin = (key, controller) => { inflight.set(key, controller); lastStatus = ''; notify(); };
    const end = key => { inflight.delete(key); if (!inflight.size) lastStatus = ''; notify(); };
    const note = s => { lastStatus = s; notify(); };
    /** Subscribe to job state; the callback fires immediately with the current state. Returns unsubscribe. */
    const onJobs = fn => { watchers.add(fn); fn(jobState()); return () => watchers.delete(fn); };

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
     * Refine step 1: ONE LLM call writes the shared SCENE SETTING of a reply
     * (location, who is present, what each wears, what they do, poses).
     * Every image prompt of that reply is later written against this text.
     */
    async function buildSetting(ctx, { paragraphs, context, ents }, signal) {
        const msgs = buildSettingPrompt({ system: settings.generate.settingSystem, paragraphs, context, characters: ents.characters, personas: ents.personas });
        const setting = (await llm.chat({ ...msgs, signal })).trim();
        if (!setting) throw new Error('Scene-setting LLM returned an empty setting.');
        return setting;
    }

    /**
     * Compile N planner scenes of ONE message -> N final prompts.
     * mode 'plan'   : tokens ($yenka, $yenka.back) expanded verbatim, cast fragments prepended by compiler. No LLM.
     * mode 'refine' : ONE batch LLM call for all scenes (setting + cast + N drafts -> N prompts), never one call per image,
     *                 so location / people / clothing stay identical across the images of a reply.
     * @returns {Promise<{ prompt:string, negative:string, ents:object, expanded:string, refined:string, unknown:string[] }[]>}
     */
    async function compileScenes(ctx, scenes, backendId, signal, { setting = '' } = {}) {
        const g = settings.generate;
        const ident = chatIdentity(ctx);
        // Entities are resolved on the union of all scenes so every image carries the same cast.
        const ents = resolveEntities(settings, { text: scenes.join('\n'), ...ident });
        const shots = scenes.map(scene => expandScene({ scene, characters: ents.characters, personas: ents.personas }));
        for (const ex of shots) if (ex.unknown.length) log('unresolved tokens dropped:', ex.unknown);
        let refined = scenes.map(() => '');
        if (g.mode === 'refine') {
            const msgs = buildRefinePrompt({ system: g.refineSystem, dialect: g.dialect, setting, shots: shots.map(ex => ({ expanded: ex.text, used: ex.used })), characters: ents.characters, personas: ents.personas, style: ents.style });
            refined = parseRefined(await llm.chat({ ...msgs, signal }), scenes.length);
            if (refined.every(r => !r)) throw new Error('Refine LLM returned no usable prompts.');
            refined.forEach((r, i) => { if (!r) log(`refine: shot ${i + 1} missing in reply, falling back to the expanded draft`); });
        }
        return shots.map((ex, i) => {
            const { prompt, negative } = compilePrompt({ scene: refined[i] || ex.text, ...ents, settings, backend: backendId, merged: Boolean(refined[i]) });
            return { prompt, negative, ents, expanded: ex.text, refined: refined[i], unknown: ex.unknown };
        });
    }

    /** Single-scene convenience (regenerate / preview). */
    async function compileScene(ctx, scene, backendId, signal, opt) {
        return (await compileScenes(ctx, [scene], backendId, signal, opt))[0];
    }

    /**
     * Preview helper: compile the SAME scene both ways regardless of the active mode.
     * plan = no LLM; refine = one LLM call, no setting step (errors are returned, not thrown).
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
            const msgs = buildRefinePrompt({ system: g.refineSystem, dialect: g.dialect, shots: [{ expanded: ex.text, used: ex.used }], characters: ents.characters, personas: ents.personas, style: ents.style });
            const refined = parseRefined(await llm.chat({ ...msgs, signal }), 1)[0];
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

    /** Render one already-compiled shot and build its record. */
    async function renderCompiled(ctx, { scene, p, setting = '' }, c, signal, status) {
        const backend = backends.active();
        const { url, model } = await renderRaw(ctx, { prompt: c.prompt, negative: c.negative }, signal, status);
        /** @type {ImageRecord} */
        return { url, p, scene, expanded: c.expanded, setting, refined: c.refined, prompt: c.prompt, negative: c.negative, mode: settings.generate.mode, backend: backend.id, model, at: Date.now() };
    }

    const logCompiled = (c, label = '') => log(`compiled${label} [chars: ${c.ents.characters.map(e => e.name).join(',') || '-'} | personas: ${c.ents.personas.map(e => e.name).join(',') || '-'} | style: ${c.ents.style?.name ?? '-'}]`, c.prompt);

    /**
     * Scene setting for a regenerate on message `messageId`: the one stored on its records, or (refine mode)
     * a fresh one written from the message text so old images / edited scenes still get continuity.
     */
    async function settingFor(ctx, messageId, stored, signal, status) {
        if (stored || settings.generate.mode !== 'refine') return stored || '';
        const msg = ctx.chat[messageId];
        const paragraphs = splitParagraphs(stripImages(msg?.mes ?? ''), settings.generate.minParagraphChars);
        if (!paragraphs.length) return '';
        status('writing scene setting…');
        const scenes = records(msg).map(r => r.scene).filter(Boolean).join('\n');
        const ents = resolveEntities(settings, { text: scenes, ...chatIdentity(ctx) });
        const setting = await buildSetting(ctx, { paragraphs, context: contextText(ctx, messageId, settings.generate.contextMessages), ents }, signal);
        log('scene setting (regen)', setting);
        return setting;
    }

    /** Compile + render ONE scene (single regenerate). `setting` = scene setting of the message, reused for continuity. */
    async function render(ctx, { scene, p, setting = '' }, signal, status) {
        const backend = backends.active();
        if (settings.generate.mode === 'refine') status('refining prompt…');
        const c = await compileScene(ctx, scene, backend.id, signal, { setting });
        logCompiled(c);
        return renderCompiled(ctx, { scene, p, setting }, c, signal, status);
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
        begin(messageId, controller);
        const status = s => { log(`#${messageId} ${s}`); note(s); opt.onStatus?.(s); };
        const ident = chatIdentity(ctx);
        const originalText = msg.mes;
        try {
            status('planning…');
            const preset = findPreset(settings, opt.presetId ?? g.presetId);
            const context = contextText(ctx, messageId, g.contextMessages);
            const { system, user } = renderPlannerPrompt(preset, {
                paragraphs, count, dialect: g.dialect,
                roster: rosterText(settings, ident),
                context,
            });
            const reply = await llm.chat({ system, user, signal: controller.signal });
            const plan = parsePlan(reply, paragraphs.map(p => p.index)).slice(0, count);
            if (!plan.length) {
                const head = reply.replace(/\s+/g, ' ').trim().slice(0, 220);
                const refused = /(can(?:'|no)t|unable to|not able to|won't|will not|decline|refus|cannot assist|outside what I can)/i.test(reply) && !reply.includes('[');
                throw new Error(refused
                    ? `The planner LLM refused this reply (${head}…). Use a less strict model / connection profile for IF Imgen, or a SFW planner preset.`
                    : `Planner returned no usable JSON plan. Reply started with: ${head || '(empty)'}`);
            }
            log('plan', plan);

            // Refine mode: ONE scene-setting call + ONE batch refine call for ALL images of this reply.
            let setting = '';
            if (g.mode === 'refine') {
                status('writing scene setting…');
                const ents = resolveEntities(settings, { text: plan.map(x => x.prompt).join('\n'), ...ident });
                setting = await buildSetting(ctx, { paragraphs, context, ents }, controller.signal);
                log('scene setting', setting);
                status(`refining ${plan.length} prompt${plan.length > 1 ? 's' : ''} in one call…`);
            }
            const compiled = await compileScenes(ctx, plan.map(x => x.prompt), backends.active().id, controller.signal, { setting });
            compiled.forEach((c, i) => logCompiled(c, ` #${i + 1}`));

            const made = [];
            for (let i = 0; i < plan.length; i++) {
                status(`image ${i + 1}/${plan.length} (paragraph ${plan[i].p})…`);
                made.push(await renderCompiled(ctx, { scene: plan[i].prompt, p: plan[i].p, setting }, compiled[i], controller.signal, status));
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
            end(messageId);
        }
    }

    /**
     * Re-render one image in place. `scene` overrides the stored planner scene;
     * entities/style/settings are re-applied at compile time, so edits to
     * characters or styles take effect without touching the chat by hand.
     * The stored scene setting of the image is reused so the regen keeps continuity.
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
        begin(messageId, controller);
        const status = s => { log(`#${messageId} regen ${s}`); note(s); onStatus?.(s); };
        try {
            const setting = await settingFor(ctx, messageId, rec?.setting ?? '', controller.signal, status);
            const fresh = await render(ctx, { scene: useScene, p: rec?.p ?? 0, setting }, controller.signal, status);
            if (rec) fresh.history = [stripHistory(rec), ...(rec.history ?? [])].slice(0, MAX_VERSIONS);
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
            end(messageId);
        }
    }

    /**
     * Re-render EVERY image of a message with its stored scene and position
     * (no new planning). All scenes are compiled in ONE batch (refine = one LLM call)
     * against the stored scene setting. Images without a stored scene (legacy) are skipped.
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
        begin(messageId, controller);
        const status = s => { log(`#${messageId} regen-all ${s}`); note(s); onStatus?.(s); };
        const todo = list.filter(r => String(r.scene ?? '').trim());
        let regenerated = 0;
        const skipped = list.length - todo.length;
        try {
            if (!todo.length) { status('done (0)'); return { regenerated, skipped }; }
            const setting = await settingFor(ctx, messageId, todo.find(r => r.setting)?.setting ?? '', controller.signal, status);
            if (settings.generate.mode === 'refine') status(`refining ${todo.length} prompt${todo.length > 1 ? 's' : ''} in one call…`);
            const compiled = await compileScenes(ctx, todo.map(r => r.scene), backends.active().id, controller.signal, { setting });
            for (let i = 0; i < todo.length; i++) {
                const rec = todo[i];
                status(`image ${i + 1}/${todo.length}…`);
                const fresh = await renderCompiled(ctx, { scene: rec.scene, p: rec.p ?? 0, setting }, compiled[i], controller.signal, status);
                fresh.history = [stripHistory(rec), ...(rec.history ?? [])].slice(0, MAX_VERSIONS);
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
            end(messageId);
        }
    }

    /**
     * Delete the SHOWN version of an image slot. If older versions exist, the newest of them takes its
     * place in the chat and is returned; otherwise the slot is removed entirely and null is returned.
     */
    async function removeImage(messageId, url) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) return null;
        const list = records(msg);
        const i = list.findIndex(r => r.url === url);
        const hist = i >= 0 ? (list[i].history ?? []) : [];
        if (hist.length) {
            const [next, ...rest] = hist;
            list[i] = { ...next, history: rest };
            setMessageText(ctx, messageId, replaceImageUrl(msg.mes, url, next.url));
            await ctx.saveChat();
            return list[i];
        }
        if (i >= 0) list.splice(i, 1);
        setMessageText(ctx, messageId, removeImageByUrl(msg.mes, url));
        await ctx.saveChat();
        return null;
    }

    /** Show an older version (`versionUrl`, one of rec.history[].url) in the chat; the shown one moves into history. */
    async function switchVersion(messageId, url, versionUrl) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) return null;
        const list = records(msg);
        const i = list.findIndex(r => r.url === url);
        if (i < 0) return null;
        const cur = list[i];
        const hist = cur.history ?? [];
        const k = hist.findIndex(h => h.url === versionUrl);
        if (k < 0) return null;
        list[i] = { ...hist[k], history: [stripHistory(cur), ...hist.filter((_, j) => j !== k)] };
        setMessageText(ctx, messageId, replaceImageUrl(msg.mes, url, list[i].url));
        await ctx.saveChat();
        return list[i];
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
        begin(TEST_KEY, controller);
        const status = s => { log(`test ${s}`); note(s); onStatus?.(s); };
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
            end(TEST_KEY);
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
            for (const { url, title } of r.recovered) if (!list.some(x => x.url === url)) list.push({ url, p: 0, scene: '', expanded: '', setting: '', refined: '', prompt: title, negative: '', mode: '', backend: '', model: '', at: 0 });
            setMessageText(ctx, id, r.mes);
            changed++;
        });
        if (changed) { await ctx.saveChat(); log(`migrated ${changed} message(s) to bare image form`); }
        return changed;
    }

    return {
        run, regenerate, regenerateAll, removeImage, switchVersion, clear, migrateChat,
        runTest, regenerateTest, removeTest, testImages: () => testList().slice(),
        cancel(messageId) {
            if (messageId === undefined) { for (const c of inflight.values()) c.abort(); return; }
            inflight.get(messageId)?.abort();
        },
        isRunning: id => inflight.has(id),
        onJobs,
        recordFor: (messageId, url) => findRecord(getContext().chat[messageId] ?? {}, url),
        compilePreview: (scene, signal) => compileScene(getContext(), scene, backends.active().id, signal),
        compileBoth,
    };
}
