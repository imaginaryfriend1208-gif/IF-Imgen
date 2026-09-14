// IF Imgen - per-message pipeline: paragraphs -> planner LLM -> N images -> insert in place.
import { splitParagraphs, insertAfterParagraphs, imageSnippet, stripImages, countImages } from './paragraphs.js';
import { renderPlannerPrompt, parsePlan, findPreset } from './presets.js';
import { resolveEntities, rosterText } from './entities.js';
import { compilePrompt, effectiveParams } from './prompt.js';
import { clamp } from './util.js';

export function createPipeline({ settings, getContext, backends, llm, saveImage, log = () => {} }) {
    const inflight = new Map(); // messageId -> AbortController

    function chatIdentity(ctx) {
        const charAvatar = ctx.characters?.[ctx.characterId]?.avatar ?? '';
        const personaAvatar = ctx.powerUserSettings?.persona_avatar ?? ctx.userAvatar ?? '';
        return { charAvatar, personaAvatar };
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

        const g = settings.generate;
        const count = clamp(opt.count ?? g.imagesPerResponse, 1, 8);
        const paragraphs = splitParagraphs(msg.mes, g.minParagraphChars);
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

            const backend = backends.active();
            const params = effectiveParams(settings, backend.id);
            const inserts = [];
            for (let i = 0; i < plan.length; i++) {
                const item = plan[i];
                status(`image ${i + 1}/${plan.length} (paragraph ${item.p})…`);
                const ents = resolveEntities(settings, { text: item.prompt, ...ident });
                const { prompt, negative } = compilePrompt({ scene: item.prompt, ...ents, settings, backend: backend.id });
                const b64 = await backend.generate({ prompt, negative, params }, controller.signal);
                const url = await saveImage(b64, ctx.characters?.[ctx.characterId]?.name || 'IF_Imgen');
                inserts.push({ p: item.p, snippet: imageSnippet(url, prompt) });
            }

            // Stale check: the message may have been swiped/edited while generating.
            if (ctx.chat[messageId]?.mes !== originalText) return { skipped: 'message changed during generation', generated: inserts.length };
            setMessageText(ctx, messageId, insertAfterParagraphs(originalText, paragraphs, inserts));
            await ctx.saveChat();
            status(`done (${inserts.length} image${inserts.length > 1 ? 's' : ''})`);
            return { generated: inserts.length };
        } catch (e) {
            if (e?.name === 'AbortError') { status('cancelled'); return { skipped: 'cancelled' }; }
            status(`error: ${e.message}`);
            throw e;
        } finally {
            inflight.delete(messageId);
        }
    }

    async function clear(messageId) {
        const ctx = getContext();
        const msg = ctx.chat[messageId];
        if (!msg) return;
        setMessageText(ctx, messageId, stripImages(msg.mes));
        await ctx.saveChat();
    }

    function cancel(messageId) {
        if (messageId === undefined) { for (const c of inflight.values()) c.abort(); return; }
        inflight.get(messageId)?.abort();
    }

    return { run, clear, cancel, isRunning: id => inflight.has(id) };
}
