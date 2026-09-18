// IF Imgen - per-message pipeline:
//   step 1  scene planner  : paragraphs + context + previous scene documents -> ONE scene document (message.extra.ifimgen_scene)
//   step 2  translator     : scene document + paragraphs -> N image prompts, each in two versions: raw "prompt" with
//                            $tokens and smooth "final" (tokens written out, only the traits the shot shows) (JSON)
//   step 3  refine (opt.)  : ONE batch call polishing the N prompts against the document (mode 'refine')
//   compile: refined > final > expanded raw prompt; with final / refined the compiler adds LoRA + style + negative only.
//   render each prompt -> insert in place. Each image is recorded in message.extra.ifimgen so it can be regenerated later.
// Regenerate (one image / all images) re-runs step 2 (+3) from the STORED document; "regen scene" / Generate re-run step 1.
import { splitParagraphs, insertAfterParagraphs, imageSnippet, stripImages, stripImagesLoose, stripForeignImages, countImages, replaceImageUrl, removeImageByUrl, migrateLegacyImages, safeImageUrl } from './paragraphs.js';
import { renderPlannerPrompt, parsePlan, isTruncatedReply, findPreset, effectiveDialect } from './presets.js';
import { resolveEntities, rosterText, isBound } from './entities.js';
import { mergeLedger, ledgerTokens, ledgerBlock, removeLedgerToken, markLedgerSaved, bootstrapLedger } from './ledger.js';
import { compilePrompt, effectiveParams } from './prompt.js';
import { expandScene, expandSceneDoc, buildScenePrompt, buildRefinePrompt, parseRefined, parseDocTokens } from './scene.js';
import { buildProfilePrompt, parseProfilePrompt, profileDraft } from './profile.js';
import { normalizeProfile, PROFILE_VERSIONS } from './entities.js';
import { clamp } from './util.js';

/** @typedef {{ url:string, p:number, scene:string, final:string, expanded:string, setting:string, refined:string, prompt:string, negative:string, mode:string, backend:string, model:string, at:number }} ImageRecord  (scene = raw $token prompt, final = its smooth version from step 2, setting = the scene document the image was written from) */
/** @typedef {{ text:string, at:number }} SceneDoc  stored in message.extra.ifimgen_scene */
/** @typedef {{ url:string, scene:string, prompt:string, negative:string, mode:string, backend:string, model:string, at:number }} TestRecord */

const MAX_TEST_IMAGES = 60;
/** Safety net: a render whose reply never arrives is released after this long (renderRaw watchdog). */
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
/** Per-step stopwatch: `const tm = timer(); ...; tm.lap('scene'); ...; tm.summary()` -> "scene 38s · prompts 12s · render 21s". */
function timer() {
    const laps = [];
    let t0 = Date.now();
    return {
        lap(name) { const now = Date.now(); laps.push([name, now - t0]); t0 = now; return laps[laps.length - 1][1]; },
        summary() { return laps.map(([n, ms]) => `${n} ${fmtMs(ms)}`).join(' · '); },
        total() { return laps.reduce((a, [, ms]) => a + ms, 0); },
    };
}
const fmtMs = ms => ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
// Regenerate keeps the replaced image as an older VERSION of the same slot (rec.history, newest first).
const MAX_VERSIONS = 8;
const stripHistory = r => { const { history, ...rest } = r; return rest; };

/** Settle with p, but reject with AbortError the moment signal fires, even if p never settles. */
export function abortable(p, signal) {
    if (!signal) return p;
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(p).then(
            v => { signal.removeEventListener('abort', onAbort); resolve(v); },
            e => { signal.removeEventListener('abort', onAbort); reject(e); });
    });
}

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
        // Root chat name: a branch / checkpoint stores its parent in chat_metadata.main_chat, so a binding made in the
        // parent follows every branch without re-binding.
        const current = (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId) ?? '';
        const root = ctx.chatMetadata?.main_chat ?? ctx.chat_metadata?.main_chat ?? '';
        const chatId = String(root || current);
        const charAvatar = ctx.characters?.[ctx.characterId]?.avatar ?? '';
        const personaAvatar = ctx.powerUserSettings?.persona_avatar ?? ctx.userAvatar ?? '';
        return { chatId, chatFile: String(current), charAvatar, personaAvatar, activeProfiles: settings.activeProfiles ?? {} };
    }

    function contextText(ctx, messageId, k) {
        const out = [];
        for (let i = messageId - 1; i >= 0 && out.length < k; i--) {
            const m = ctx.chat[i];
            if (!m || m.is_system) continue;
            out.unshift(`${m.is_user ? 'User' : m.name}: ${stripImagesLoose(m.mes).slice(0, 800)}`);
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

    /** Scene document of a message ('' when none). Falls back to the document stored on its images (older records). */
    function sceneDocOf(msg) {
        const d = msg?.extra?.ifimgen_scene;
        if (d && typeof d.text === 'string' && d.text.trim()) return d.text;
        return (msg?.extra?.ifimgen ?? []).find(r => r?.setting)?.setting ?? '';
    }
    function setSceneDoc(msg, text) {
        msg.extra ??= {};
        msg.extra.ifimgen_scene = { text: String(text ?? '').trim(), at: Date.now() };
    }
    /** Scene documents of the k most recent earlier character replies that have one, oldest first (continuity input of step 1). */
    function previousSceneDocs(ctx, messageId, k) {
        const out = [];
        for (let i = messageId - 1; i >= 0 && out.length < k; i--) {
            const m = ctx.chat[i];
            if (!m || m.is_user || m.is_system) continue;
            const text = sceneDocOf(m);
            if (text) out.unshift({ id: i, text });
        }
        return out;
    }
    // ---- chat token ledger (chat_metadata.ifimgen_tokens): every ad-hoc token the planner defined in this chat.
    const saveMeta = ctx => { try { (ctx.saveMetadataDebounced ?? ctx.saveMetadata)?.(); } catch { /* not available (tests) */ } };
    /** Tokens of this chat handed to the LLM steps: the newest N (settings.generate.ledgerLimit, 0 = all); tokens defined
     *  by documents AFTER `beforeId` are left out so a regenerate of an old message does not see the future. */
    function chatLedger(ctx, beforeId = Infinity) {
        bootstrapLedger(ctx, sceneDocOf);
        const lim = Number(settings.generate.ledgerLimit ?? 40);
        return ledgerTokens(ctx, 0).filter(tk => tk.at <= beforeId).slice(0, lim > 0 ? lim : undefined);
    }
    function recordDocTokens(ctx, messageId, doc) {
        if (mergeLedger(ctx, parseDocTokens(doc), messageId) > 0) { saveMeta(ctx); onChange?.(messageId); }
    }

    /** Refusal / empty-output check shared by the LLM steps. */
    function llmFailure(reply, what) {
        const head = String(reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
        const refused = /(can(?:'|no)t|unable to|not able to|won't|will not|decline|refus|cannot assist|outside what I can)/i.test(reply) && !String(reply).includes('[');
        console.warn('[IF Imgen] full LLM reply that could not be used:', reply);
        if (isTruncatedReply(reply)) {
            return new Error(`The ${what} LLM reply was cut off before the closing ] (max tokens reached or the provider stopped early) and nothing complete could be salvaged. Raise Max tokens in Connection, lower Images per reply, or use a shorter preset. Reply started with: ${head}`);
        }
        return new Error(refused
            ? `The ${what} LLM refused this reply (${head}…). Use a less strict model / connection profile for IF Imgen, or a SFW preset.`
            : `The ${what} LLM returned nothing usable. Reply started with: ${head || '(empty)'}`);
    }

    /** @returns {TestRecord[]} live array in extension settings */
    function testList() {
        settings.data ??= {};
        if (!Array.isArray(settings.data.testImages)) settings.data.testImages = [];
        return settings.data.testImages;
    }

    /**
     * Step 1: ONE LLM call writes the SCENE DOCUMENT of a reply (scene, location, layout, who is present, what each
     * wears / feels / does, poses, continuity with the previous documents). People and their stored details are
     * written as $keyword / $keyword.detail tokens (expanded by docWords() for steps 2 / 3). Stored on the message;
     * every image prompt of the reply is translated from it and the next reply's planner reads it again.
     */
    async function writeSceneDoc(ctx, messageId, { paragraphs, context }, signal) {
        const g = settings.generate;
        const ident = chatIdentity(ctx);
        const ents = resolveEntities(settings, { text: paragraphs.map(p => p.text).join('\n'), ...ident });
        const msgs = buildScenePrompt({
            system: g.sceneSystem, paragraphs, context,
            previous: previousSceneDocs(ctx, messageId, clamp(g.sceneHistory ?? 3, 0, 10)),
            characters: ents.characters, personas: ents.personas,
            ledger: ledgerBlock(chatLedger(ctx, messageId)),
        });
        const reply = await llm.chat({ ...msgs, signal });
        const doc = String(reply ?? '').trim();
        if (!doc || doc.length < 40) throw llmFailure(reply, 'scene planner');
        return doc;
    }

    /**
     * Scene document for message `messageId`: the stored one, or a fresh one (written from the message text and
     * stored) when none exists yet or `fresh` is set. Returns '' when the message has no usable paragraphs.
     */
    async function sceneDocFor(ctx, messageId, { fresh = false, paragraphs = null, signal, status }) {
        const msg = ctx.chat[messageId];
        if (!fresh) { const stored = sceneDocOf(msg); if (stored) return stored; }
        const paras = paragraphs ?? splitParagraphs(stripImages(msg?.mes ?? ''), settings.generate.minParagraphChars);
        if (!paras.length) return '';
        status('writing scene document…');
        const doc = await writeSceneDoc(ctx, messageId, { paragraphs: paras, context: contextText(ctx, messageId, settings.generate.contextMessages) }, signal);
        setSceneDoc(msg, doc);
        recordDocTokens(ctx, messageId, doc);
        log(`#${messageId} scene document`, doc);
        return doc;
    }

    /**
     * Scene document as the downstream LLMs read it: $keyword -> name, $keyword.detail -> stored text (current
     * entity data, so edited details reach old documents). The document on the message keeps its tokens.
     */
    function docWords(ctx, doc) {
        const text = String(doc ?? '');
        if (!text.includes('$')) return text;
        const ents = resolveEntities(settings, { text, ...chatIdentity(ctx) });
        const ex = expandSceneDoc({ doc: text, characters: ents.characters, personas: ents.personas, adhoc: chatLedger(ctx) });
        if (ex.unknown.length) log('scene document: unresolved tokens kept as written:', ex.unknown);
        return ex.text;
    }

    /**
     * Step 2: translate the scene document (+ the numbered paragraphs) into image prompts - raw `prompt` with $tokens
     * and smooth `final` (absent when the LLM left it out or it still carried a $ token).
     * `fixed` = write one prompt for every listed paragraph (regenerate keeps every image slot).
     * @returns {Promise<{p:number, prompt:string, final?:string, ar?:string}[]>}
     */
    async function planShots(ctx, { paragraphs, count, sceneDoc, presetId, fixed = false, context = '' }, signal) {
        const g = settings.generate;
        const preset = findPreset(settings, presetId ?? g.presetId);
        const dialect = effectiveDialect(settings, preset.id);
        const { system, user } = renderPlannerPrompt(preset, {
            paragraphs, count, dialect, sceneDoc: docWords(ctx, sceneDoc), fixed, context, autoAspect: g.autoAspect === true,
            // Roster carries the texts of base look + Details + World so the writer can produce the smooth "final".
            roster: rosterText(settings, chatIdentity(ctx), dialect),
        });
        const reply = await llm.chat({ system, user, signal });
        const plan = parsePlan(reply, paragraphs.map(p => p.index)).slice(0, count);
        if (!plan.length) throw llmFailure(reply, 'prompt translator');
        if (isTruncatedReply(reply)) log(`prompt translator: reply cut off by max tokens - ${plan.length}/${count} shot(s) salvaged; raise Max tokens in Connection`);
        return plan;
    }

    /**
     * Compile N translated prompts of ONE message -> N final prompts.
     * mode 'plan'   : the step-2 `final` (smooth, no tokens) when present, else the raw prompt with tokens expanded
     *                 verbatim and the cast's base look prepended by the compiler. No LLM.
     * mode 'refine' : ONE batch LLM call for all prompts (document + cast + N drafts -> N prompts), never one call per image,
     *                 so location / people / clothing stay identical across the images of a reply.
     * `finals[i]` = the smooth version of scenes[i] from step 2 ('' when none). Ad-hoc tokens of the scene document
     * (its TOKENS section) resolve in the raw prompts after Details / World.
     * @returns {Promise<{ prompt:string, negative:string, ents:object, expanded:string, final:string, refined:string, unknown:string[] }[]>}
     */
    async function compileScenes(ctx, scenes, backendId, signal, { setting = '', finals = [] } = {}) {
        const g = settings.generate;
        const ident = chatIdentity(ctx);
        // Entities are resolved on the union of all scenes so every image carries the same cast.
        const ents = resolveEntities(settings, { text: scenes.join('\n'), ...ident });
        // Ad-hoc tokens: this document's TOKENS first, then the chat ledger (tokens defined by earlier documents).
        const adhoc = [...parseDocTokens(setting), ...chatLedger(ctx)];
        const shots = scenes.map(scene => expandScene({ scene, characters: ents.characters, personas: ents.personas, adhoc }));
        for (const ex of shots) if (ex.unknown.length) log('unresolved tokens dropped:', ex.unknown);
        const dialect = effectiveDialect(settings);
        const final = scenes.map((_, i) => String(finals[i] ?? '').trim());
        let refined = scenes.map(() => '');
        if (g.mode === 'refine') {
            const msgs = buildRefinePrompt({ system: g.refineSystem, dialect, setting: docWords(ctx, setting), shots: shots.map(ex => ({ expanded: ex.text, used: ex.used })), characters: ents.characters, personas: ents.personas, style: ents.style });
            refined = parseRefined(await llm.chat({ ...msgs, signal }), scenes.length);
            if (refined.every(r => !r)) throw new Error('Refine LLM returned no usable prompts.');
            refined.forEach((r, i) => { if (!r) log(`refine: shot ${i + 1} missing in reply, falling back to the expanded draft`); });
        }
        return shots.map((ex, i) => {
            // refined (step 3) > final (step 2, smooth) > expanded raw prompt. The first two already carry the looks
            // the shot needs -> merged: the compiler adds LoRA + style + negative only, no duplicate base look.
            const text = refined[i] || final[i] || ex.text;
            const { prompt, negative } = compilePrompt({ scene: text, ...ents, settings, backend: backendId, merged: Boolean(refined[i] || final[i]), dialect });
            return { prompt, negative, ents, expanded: ex.text, final: final[i], refined: refined[i], unknown: ex.unknown };
        });
    }

    /** Single-scene convenience (regenerate / preview). */
    async function compileScene(ctx, scene, backendId, signal, opt) {
        return (await compileScenes(ctx, [scene], backendId, signal, opt))[0];
    }

    /**
     * Preview helper: compile the SAME scene both ways regardless of the active mode.
     * plan = no LLM; refine = one LLM call, no scene document (errors are returned, not thrown).
     */
    async function compileBoth(scene, signal) {
        const ctx = getContext();
        const backendId = backends.active().id;
        const g = settings.generate;
        const ident = chatIdentity(ctx);
        const ents = resolveEntities(settings, { text: scene, ...ident });
        const ex = expandScene({ scene, characters: ents.characters, personas: ents.personas });
        const dialect = effectiveDialect(settings);
        const plan = compilePrompt({ scene: ex.text, ...ents, settings, backend: backendId, merged: false, dialect });
        let refine = null;
        try {
            const msgs = buildRefinePrompt({ system: g.refineSystem, dialect, shots: [{ expanded: ex.text, used: ex.used }], characters: ents.characters, personas: ents.personas, style: ents.style });
            const refined = parseRefined(await llm.chat({ ...msgs, signal }), 1)[0];
            if (!refined) throw new Error('Refine LLM returned an empty prompt.');
            refine = { refined, ...compilePrompt({ scene: refined, ...ents, settings, backend: backendId, merged: true, dialect }) };
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
            refine = { error: e.message };
        }
        return { ents, expanded: ex.text, unknown: ex.unknown, plan, refine };
    }

    /** Send a final prompt to the active backend and save the PNG. No compile step. `folder` = image folder name (default: the open character). */
    async function renderRaw(ctx, { prompt, negative, ar = '' }, signal, status, folder = '') {
        const backend = backends.active();
        const params = effectiveParams(settings, backend.id, { ar });
        status('rendering…');
        const t0 = Date.now();
        // Watchdog: a response that never arrives (proxy queue stall, dropped connection, backend finished but the
        // reply was lost) must not leave the job in "rendering…" forever - that would keep the inflight slot busy and
        // block every Generate / Regenerate for this message / entity until the page is reloaded.
        const guard = new AbortController();
        const onAbort = () => guard.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const watchdog = setTimeout(() => guard.abort(), RENDER_TIMEOUT_MS);
        let b64;
        try {
            b64 = await abortable(backend.generate({ prompt, negative, params }, guard.signal), guard.signal);
        } catch (e) {
            if (e?.name === 'AbortError' && !signal?.aborted) {
                throw new Error(`Image backend (${backend.id}) did not answer within ${Math.round(RENDER_TIMEOUT_MS / 60000)} min - the job was released. Check the proxy / backend queue and try again.`);
            }
            throw e;
        } finally {
            clearTimeout(watchdog);
            signal?.removeEventListener('abort', onAbort);
        }
        const t1 = Date.now();
        const url = safeImageUrl(await saveImage(b64, folder || ctx.characters?.[ctx.characterId]?.name || 'IF_Imgen'));
        log(`render: backend ${fmtMs(t1 - t0)} (${backend.id} ${params.model || ''} ${params.width}x${params.height} ${params.steps} steps) · save ${fmtMs(Date.now() - t1)}`);
        return { url, backend: backend.id, model: params.model ?? '', ms: t1 - t0 };
    }

    /** Render one already-compiled shot and build its record. */
    async function renderCompiled(ctx, { scene, p, setting = '', ar = '' }, c, signal, status) {
        const backend = backends.active();
        const { url, model } = await renderRaw(ctx, { prompt: c.prompt, negative: c.negative, ar }, signal, status);
        /** @type {ImageRecord} */
        return { url, p, scene, ar, final: c.final ?? '', expanded: c.expanded, setting, refined: c.refined, prompt: c.prompt, negative: c.negative, mode: settings.generate.mode, backend: backend.id, model, at: Date.now() };
    }

    const logCompiled = (c, label = '') => log(`compiled${label} [chars: ${c.ents.characters.map(e => e.name).join(',') || '-'} | personas: ${c.ents.personas.map(e => e.name).join(',') || '-'} | style: ${c.ents.style?.name ?? '-'}]`, c.prompt);

    /** Compile + render ONE prompt (single regenerate). `setting` = scene document of the message. */
    async function render(ctx, { scene, p, setting = '', final = '' }, signal, status) {
        const backend = backends.active();
        if (settings.generate.mode === 'refine') status('refining prompt…');
        const c = await compileScene(ctx, scene, backend.id, signal, { setting, finals: [final] });
        logCompiled(c);
        return renderCompiled(ctx, { scene, p, setting }, c, signal, status);
    }

    /**
     * Full run: scene document (step 1, new unless `keepScene` and one is stored) -> choose paragraphs + prompts (step 2)
     * -> optional refine -> render -> insert.
     * @param {number} messageId
     * @param {{ count?: number, presetId?: string, force?: boolean, keepScene?: boolean, onStatus?: (s:string)=>void }} [opt]
     */
    async function run(messageId, opt = {}) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg || msg.is_user || msg.is_system) return { skipped: 'not a character message' };
        if (inflight.has(messageId)) return { skipped: 'already running' };

        // Echoed markdown: the chat LLM sometimes copies an OLDER reply's `<!--ifimgen-->\n![IF Imgen](url)` into a
        // new reply (the generate interceptor in index.js strips it from the prompt, but old chats / other
        // front-ends can still leak it). An image this message never generated is not its image: drop it from the
        // text first, otherwise the auto-run would see "already has images" and show a stale picture.
        const cleaned = stripForeignImages(msg.mes, records(msg).map(r => r.url));
        if (cleaned !== msg.mes) {
            log(`#${messageId} removed image markdown echoed by the chat LLM`);
            setMessageText(ctx, messageId, cleaned);
            await ctx.saveChat();
        }
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
        const originalText = msg.mes;
        const tm = timer();
        try {
            // Step 1: scene document (stored on the message, re-read by the next reply's planner).
            const context = contextText(ctx, messageId, g.contextMessages);
            const stored = opt.keepScene ? sceneDocOf(msg) : '';
            let setting = stored;
            if (!setting) {
                status('writing scene document…');
                setting = await writeSceneDoc(ctx, messageId, { paragraphs, context }, controller.signal);
                log(`#${messageId} scene document (${fmtMs(tm.lap('scene'))}, ${setting.length} chars)`, setting);
            }

            // Step 2: translate the document into N prompts (the translator also picks the paragraphs).
            status('writing prompts…');
            const plan = await planShots(ctx, { paragraphs, count, sceneDoc: setting, presetId: opt.presetId, context }, controller.signal);
            log(`plan (${fmtMs(tm.lap('prompts'))})`, plan);

            // Step 3 (mode 'refine'): ONE batch refine call for ALL images of this reply.
            if (g.mode === 'refine') status(`refining ${plan.length} prompt${plan.length > 1 ? 's' : ''} in one call…`);
            const compiled = await compileScenes(ctx, plan.map(x => x.prompt), backends.active().id, controller.signal, { setting, finals: plan.map(x => x.final ?? '') });
            if (g.mode === 'refine') tm.lap('refine');
            compiled.forEach((c, i) => logCompiled(c, ` #${i + 1}`));

            const made = [];
            for (let i = 0; i < plan.length; i++) {
                status(`image ${i + 1}/${plan.length} (paragraph ${plan[i].p})…`);
                made.push(await renderCompiled(ctx, { scene: plan[i].prompt, p: plan[i].p, setting, ar: plan[i].ar ?? '' }, compiled[i], controller.signal, status));
                tm.lap(`image ${i + 1}`);
            }

            // Stale check: the message may have been swiped/edited while generating.
            if (ctx.chat[messageId]?.mes !== originalText) return { skipped: 'message changed during generation', generated: made.length };
            if (!stored) setSceneDoc(msg, setting);
            if (replacing) records(msg).length = 0;
            records(msg).push(...made);
            setMessageText(ctx, messageId, insertAfterParagraphs(baseText, paragraphs, made.map(r => ({ p: r.p, snippet: imageSnippet(r.url) }))));
            await ctx.saveChat();
            status(`done (${made.length} image${made.length > 1 ? 's' : ''}) in ${fmtMs(tm.total())} — ${tm.summary()}`);
            return { generated: made.length, ms: tm.total() };
        } catch (e) {
            if (e?.name === 'AbortError') { status('cancelled'); return { skipped: 'cancelled' }; }
            status(`error: ${e.message}`);
            throw e;
        } finally {
            end(messageId);
        }
    }

    /**
     * Re-render one image in place = step 2 (+3) again for that paragraph from the STORED scene document
     * (a new translation of the same scene), never step 1. `scene` (Edit & regenerate) skips the translation and
     * is used as the prompt draft as-is; entities / style / settings are re-applied at compile time either way.
     */
    async function regenerate(messageId, url, { scene, onStatus } = {}) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) throw new Error('Message not found.');
        if (inflight.has(messageId)) throw new Error('This message is already generating.');
        const rec = findRecord(msg, url);
        const edited = String(scene ?? '').trim();
        const paragraphs = splitParagraphs(stripImages(msg.mes), settings.generate.minParagraphChars);
        const para = paragraphs.find(p => p.index === (rec?.p ?? 0)) ?? null;
        if (!edited && !para && !String(rec?.scene ?? '').trim()) throw new Error('No stored prompt for this image — use "Edit & regenerate" and type one.');
        const controller = new AbortController();
        begin(messageId, controller);
        const status = s => { log(`#${messageId} regen ${s}`); note(s); onStatus?.(s); };
        const tm = timer();
        try {
            const had = Boolean(sceneDocOf(msg));
            const setting = await sceneDocFor(ctx, messageId, { paragraphs, signal: controller.signal, status });
            if (!had && setting) tm.lap('scene');
            // An edited draft is drawn as typed (no smooth version); otherwise step 2 runs again and its `final` is used,
            // falling back to the stored raw prompt + stored final when the translation fails.
            let useScene = edited, useFinal = '';
            if (!useScene && para && setting) {
                status('writing prompt…');
                try { const hit = (await planShots(ctx, { paragraphs: [para], count: 1, sceneDoc: setting, fixed: true }, controller.signal))[0]; useScene = hit?.prompt ?? ''; useFinal = hit?.final ?? ''; }
                catch (e) { if (e?.name === 'AbortError') throw e; log('regen: translation failed, reusing the stored prompt', e.message); }
                tm.lap('prompt');
            }
            if (!useScene) { useScene = String(rec?.scene ?? '').trim(); useFinal = String(rec?.final ?? '').trim(); }
            const fresh = await render(ctx, { scene: useScene, p: rec?.p ?? 0, setting, final: useFinal }, controller.signal, status);
            tm.lap(settings.generate.mode === 'refine' ? 'refine+image' : 'image');
            if (rec) fresh.history = [stripHistory(rec), ...(rec.history ?? [])].slice(0, MAX_VERSIONS);
            const list = records(msg);
            const i = list.findIndex(r => r.url === url);
            if (i >= 0) list[i] = fresh; else list.push(fresh);
            setMessageText(ctx, messageId, replaceImageUrl(msg.mes, url, fresh.url));
            await ctx.saveChat();
            status(`done in ${fmtMs(tm.total())} — ${tm.summary()}`);
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
     * Re-render EVERY image of a message in its slot: step 2 (+3) again for the same paragraphs from the scene
     * document (stored, or written anew when `newScene` is set = "regen scene"). Prompts are translated in ONE call
     * and compiled in ONE batch. Images whose paragraph is gone and that have no stored prompt (legacy) are skipped.
     * @param {number} messageId
     * @param {{ newScene?: boolean, onStatus?: (s:string)=>void }} [opt]
     * @returns {Promise<{ regenerated:number, skipped:number }>}
     */
    async function regenerateAll(messageId, { newScene = false, onStatus } = {}) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) throw new Error('Message not found.');
        if (inflight.has(messageId)) throw new Error('This message is already generating.');
        const list = records(msg).filter(r => msg.mes.includes(r.url));
        if (!list.length) return { regenerated: 0, skipped: 0, none: true };
        const controller = new AbortController();
        begin(messageId, controller);
        const status = s => { log(`#${messageId} ${newScene ? 'regen-scene' : 'regen-all'} ${s}`); note(s); onStatus?.(s); };
        const paragraphs = splitParagraphs(stripImages(msg.mes), settings.generate.minParagraphChars);
        const paraOf = r => paragraphs.find(p => p.index === (r.p ?? 0)) ?? null;
        const todo = list.filter(r => paraOf(r) || String(r.scene ?? '').trim());
        let regenerated = 0;
        const skipped = list.length - todo.length;
        const tm = timer();
        try {
            if (!todo.length) { status('done (0)'); return { regenerated, skipped }; }
            const had = Boolean(sceneDocOf(msg));
            const setting = await sceneDocFor(ctx, messageId, { fresh: newScene, paragraphs, signal: controller.signal, status });
            if ((newScene || !had) && setting) tm.lap('scene');
            // Step 2 for every slot that still has its paragraph; slots without one keep their stored prompt.
            const prompts = todo.map(r => String(r.scene ?? '').trim());
            const finals = todo.map(r => String(r.final ?? '').trim());
            const slots = todo.map((r, i) => ({ i, para: paraOf(r) })).filter(x => x.para);
            if (slots.length && setting) {
                status(`writing ${slots.length} prompt${slots.length > 1 ? 's' : ''}…`);
                try {
                    const plan = await planShots(ctx, { paragraphs: slots.map(x => x.para), count: slots.length, sceneDoc: setting, fixed: true }, controller.signal);
                    for (const x of slots) { const hit = plan.find(y => y.p === x.para.index); if (hit) { prompts[x.i] = hit.prompt; finals[x.i] = hit.final ?? ''; } }
                } catch (e) { if (e?.name === 'AbortError') throw e; log('regen-all: translation failed, reusing the stored prompts', e.message); }
                tm.lap('prompts');
            }
            if (prompts.some(p => !p)) throw new Error('No prompt for one of the images — use "Edit & regenerate" on it.');
            if (settings.generate.mode === 'refine') status(`refining ${todo.length} prompt${todo.length > 1 ? 's' : ''} in one call…`);
            const compiled = await compileScenes(ctx, prompts, backends.active().id, controller.signal, { setting, finals });
            if (settings.generate.mode === 'refine') tm.lap('refine');
            for (let i = 0; i < todo.length; i++) {
                const rec = { ...todo[i], scene: prompts[i] };
                status(`image ${i + 1}/${todo.length}…`);
                const fresh = await renderCompiled(ctx, { scene: rec.scene, p: rec.p ?? 0, setting, ar: rec.ar ?? '' }, compiled[i], controller.signal, status);
                fresh.history = [stripHistory(todo[i]), ...(todo[i].history ?? [])].slice(0, MAX_VERSIONS);
                const all = records(msg);
                const j = all.findIndex(r => r.url === rec.url);
                if (j >= 0) all[j] = fresh; else all.push(fresh);
                setMessageText(ctx, messageId, replaceImageUrl(msg.mes, rec.url, fresh.url));
                regenerated++;
                tm.lap(`image ${i + 1}`);
            }
            await ctx.saveChat();
            status(`done (${regenerated}) in ${fmtMs(tm.total())} — ${tm.summary()}`);
            return { regenerated, skipped, ms: tm.total() };
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

    /** "Regen scene": step 1 again (new scene document), then every image of the message is re-translated and redrawn. */
    const regenerateScene = (messageId, opt = {}) => regenerateAll(messageId, { ...opt, newScene: true });

    async function clear(messageId) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) return;
        if (msg.extra) { msg.extra.ifimgen = []; delete msg.extra.ifimgen_scene; }
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

    // ---- profile / avatar image of one character or persona (src/profile.js). Stored on the entity, not in any chat.
    const PROFILE_KEY = id => `profile:${id}`;
    /** Folder of a profile picture = gallery folder of the ST card it belongs to (bound card, else the open card when bound to this chat), fallback entity name. */
    function profileFolder(ctx, e) {
        const cards = ctx.characters ?? [];
        const bound = (e.bind?.characters ?? []).map(av => cards.find(c => c?.avatar === av)).find(Boolean);
        if (bound?.name) return bound.name;
        const open = cards[ctx.characterId];
        if (open?.name && isBound(e, chatIdentity(ctx))) return open.name;
        return e.name;
    }
    /** Every profile image (current + older versions) of every character/persona, newest first. */
    function profileImages() {
        const out = [];
        for (const kind of ['characters', 'personas']) {
            for (const e of settings.data?.[kind] ?? []) {
                const prof = normalizeProfile(e.profile);
                const push = (r, current) => out.push({ url: r.url, kind, id: e.id, name: e.name, prompt: r.prompt, negative: r.negative, draft: r.draft, shot: r.shot, sfw: r.sfw, at: r.at, current });
                if (prof.current) push(prof.current, true);
                prof.history.forEach(r => push(r, false));
            }
        }
        return out.sort((a, b) => (b.at || 0) - (a.at || 0));
    }
    function entityOf(kind, id) {
        if (kind !== 'characters' && kind !== 'personas') throw new Error('Profile images exist for characters and personas only.');
        const e = (settings.data[kind] ?? []).find(x => x.id === id);
        if (!e) throw new Error('Entity not found - save it first.');
        e.profile = normalizeProfile(e.profile);
        return e;
    }

    /**
     * Prompt of a profile image without rendering (preview): LLM draft from the stored data, or the deterministic
     * draft when `useLlm` is false. Returns the compiled prompt too.
     * @param {{ kind:string, id:string, shot?:string, sfw?:boolean, useLlm?:boolean, signal?:AbortSignal }} a
     */
    async function profilePrompt({ kind, id, shot, sfw, useLlm = true, signal }) {
        const e = entityOf(kind, id);
        const g = settings.generate;
        const style = settings.data.styles.find(s => s.id === settings.defaultStyleId) ?? null;
        const opt = { entity: e, dialect: effectiveDialect(settings), shot: shot ?? e.profile.shot, sfw: sfw ?? e.profile.sfw };
        let draft = '', source = 'draft';
        if (useLlm) {
            const msgs = buildProfilePrompt({ system: g.profileSystem, style, label: kind === 'personas' ? 'user persona' : 'character', ...opt });
            const reply = await llm.chat({ ...msgs, signal });
            draft = parseProfilePrompt(reply);
            if (draft) source = 'llm'; else log('profile: LLM returned nothing usable, using the deterministic draft', String(reply ?? '').slice(0, 200));
        }
        if (!draft) draft = profileDraft(opt);
        // merged: the draft already carries the base look (LLM folded it in / profileDraft() starts with it) -> the compiler
        // must not prepend the entity tags again; LoRAs, negatives, style and quality prefix still apply.
        const ents = { characters: kind === 'characters' ? [e] : [], personas: kind === 'personas' ? [e] : [], style };
        // sceneFirst: the framing words open the final prompt, the style follows (a long style paragraph in front
        // made bust / full come out as head shots on prose models).
        const { prompt, negative } = compilePrompt({ scene: draft, ...ents, settings, backend: backends.active().id, merged: true, dialect: opt.dialect, sceneFirst: true });
        return { draft, prompt, negative, source, shot: opt.shot, sfw: opt.sfw };
    }

    /**
     * Generate (or regenerate) the profile image of an entity. The previous image becomes a version (entity.profile.history).
     * @param {{ kind:string, id:string, shot?:string, sfw?:boolean, draft?:string, useLlm?:boolean, onStatus?:(s:string)=>void }} a
     *   draft - prompt draft written by the user (Edit & regenerate): no LLM call, compiled as-is
     * @returns {Promise<object|null>} the new profile record, null when cancelled
     */
    async function profileImage({ kind, id, shot, sfw, draft, useLlm = true, onStatus } = {}) {
        const e = entityOf(kind, id);
        const key = PROFILE_KEY(id);
        const prev = inflight.get(key);
        if (prev && !prev.signal.aborted) throw new Error('A profile image for this entry is already rendering.');
        if (prev) end(key); // cancelled earlier but its request never settled: release the stale job
        const controller = new AbortController();
        begin(key, controller);
        const status = s => { log(`profile ${e.name}: ${s}`); note(s); onStatus?.(s); };
        const tm = timer();
        try {
            let p;
            const edited = String(draft ?? '').trim();
            if (edited) {
                const style = settings.data.styles.find(s => s.id === settings.defaultStyleId) ?? null;
                const ents = { characters: kind === 'characters' ? [e] : [], personas: kind === 'personas' ? [e] : [], style };
                const c = compilePrompt({ scene: edited, ...ents, settings, backend: backends.active().id, merged: true, dialect: effectiveDialect(settings), sceneFirst: true });
                p = { draft: edited, prompt: c.prompt, negative: c.negative, source: 'edited', shot: shot ?? e.profile.shot, sfw: sfw ?? e.profile.sfw };
            } else {
                if (useLlm) status('writing portrait prompt…');
                try { p = await abortable(profilePrompt({ kind, id, shot, sfw, useLlm, signal: controller.signal }), controller.signal); }
                catch (err) {
                    if (err?.name === 'AbortError') throw err;
                    log('profile: prompt LLM failed, using the deterministic draft', err.message);
                    p = await abortable(profilePrompt({ kind, id, shot, sfw, useLlm: false }), controller.signal);
                }
                tm.lap('prompt');
            }
            log(`profile prompt (${p.source})`, p.prompt);
            const ctx = getContext();
            const { url, backend, model } = await abortable(renderRaw(ctx, { prompt: p.prompt, negative: p.negative }, controller.signal, status, profileFolder(ctx, e)), controller.signal);
            tm.lap('image');
            // The picture exists from here on: release the job slot NOW so the entity panel flips back to
            // Generate / Regenerate the moment the image is in, whatever happens in the bookkeeping below.
            if (inflight.get(key) === controller) end(key);
            const rec = { url, prompt: p.prompt, negative: p.negative, draft: p.draft, shot: p.shot, sfw: p.sfw, backend, model, at: Date.now() };
            const prof = e.profile;
            if (prof.current) prof.history = [prof.current, ...prof.history].slice(0, PROFILE_VERSIONS);
            prof.current = rec; prof.shot = p.shot; prof.sfw = p.sfw;
            e.updatedAt = Date.now();
            save();
            try { onChange(key); } catch { /* ignore */ }
            status(`done in ${fmtMs(tm.total())} — ${tm.summary()}`);
            return rec;
        } catch (err) {
            if (err?.name === 'AbortError') { status('cancelled'); return null; }
            status(`error: ${err.message}`);
            throw err;
        } finally {
            if (inflight.get(key) === controller) end(key);
        }
    }

    /** Show an older profile version (`url` from profile.history) as the current one; the shown one moves into history. */
    function profileSwitch(kind, id, url) {
        const e = entityOf(kind, id);
        const prof = e.profile;
        const k = prof.history.findIndex(h => h.url === url);
        if (k < 0) return null;
        const next = prof.history[k];
        prof.history = [...(prof.current ? [prof.current] : []), ...prof.history.filter((_, j) => j !== k)].slice(0, PROFILE_VERSIONS);
        prof.current = next;
        save();
        return next;
    }

    /** Delete the shown profile image; the newest older version (if any) takes its place. Returns the new current or null. */
    function profileRemove(kind, id, url) {
        const e = entityOf(kind, id);
        const prof = e.profile;
        if (prof.current && (!url || prof.current.url === url)) {
            prof.current = prof.history.shift() ?? null;
        } else if (url) {
            prof.history = prof.history.filter(h => h.url !== url);
        }
        save();
        return prof.current;
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
            for (const { url, title } of r.recovered) if (!list.some(x => x.url === url)) list.push({ url, p: 0, scene: '', final: '', expanded: '', setting: '', refined: '', prompt: title, negative: '', mode: '', backend: '', model: '', at: 0 });
            setMessageText(ctx, id, r.mes);
            changed++;
        });
        if (changed) { await ctx.saveChat(); log(`migrated ${changed} message(s) to bare image form`); }
        return changed;
    }

    return {
        run, regenerate, regenerateAll, regenerateScene, removeImage, switchVersion, clear, migrateChat,
        runTest, regenerateTest, removeTest, testImages: () => testList().slice(),
        profileImage, profilePrompt, profileSwitch, profileRemove, profileImages,
        profileRunning: id => { const c = inflight.get(PROFILE_KEY(id)); return Boolean(c && !c.signal.aborted); },
        // Cancel releases the slot immediately (not when the request eventually settles), so Generate / Regenerate
        // is available again right away even if the backend never answers.
        cancelProfile: id => { const key = PROFILE_KEY(id); const c = inflight.get(key); if (!c) return; c.abort(); end(key); },
        sceneDoc: messageId => sceneDocOf(getContext().chat[messageId]),
        /** Ad-hoc tokens ($kw.key: text) defined in the stored scene document of a message (for "save tokens to entry"). */
        sceneDocTokens: messageId => parseDocTokens(sceneDocOf(getContext().chat[messageId])),
        /** Ad-hoc tokens of EVERY scene document in the chat, newest definition of each $kw.key wins (+ the message it came from).
         *  The latest document often has an empty TOKENS section (nothing new that reply) - tokens defined earlier must stay saveable. */
        /** Chat token ledger for the UI: list (newest first), remove one, mark one as saved into an entry. */
        ledger: () => { const ctx = getContext(); bootstrapLedger(ctx, sceneDocOf); return ledgerTokens(ctx, 0); },
        ledgerRemove(id) { const ctx = getContext(); if (removeLedgerToken(ctx, id)) saveMeta(ctx); },
        ledgerMarkSaved(id) { const ctx = getContext(); if (markLedgerSaved(ctx, id)) saveMeta(ctx); },
        sceneDocTokensAll() {
            const chat = getContext().chat ?? [];
            const seen = new Map();
            for (let i = chat.length - 1; i >= 0; i--) {
                const doc = sceneDocOf(chat[i]); if (!doc) continue;
                for (const tk of parseDocTokens(doc)) { const k = `${tk.key}.${tk.facet}`; if (!seen.has(k)) seen.set(k, { ...tk, at: i }); }
            }
            return [...seen.values()];
        },
        cancel(messageId) {
            if (messageId === undefined) { for (const c of inflight.values()) c.abort(); return; }
            inflight.get(messageId)?.abort();
        },
        isRunning: id => { const c = inflight.get(id); return Boolean(c && !c.signal.aborted); },
        onJobs,
        recordFor: (messageId, url) => findRecord(getContext().chat[messageId] ?? {}, url),
        compilePreview: (scene, signal) => compileScene(getContext(), scene, backends.active().id, signal),
        compileBoth,
    };
}
