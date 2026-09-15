// IF Imgen - final prompt compiler. Pure module.
// Order: [front LoRAs] quality, style tags, [after_style LoRAs], character tags, persona tags, scene, [end LoRAs]
import { joinTags } from './util.js';
import { PARAM_DEFAULTS } from './settings.js';

const LORA_RE = /<lora:[^>]+>/gi;

function lorasAt(entities, pos) {
    return entities.filter(e => (e.loraPosition || 'front') === pos).flatMap(e => e.loras ?? []);
}

/** Strip "$keyword" tokens from the planner prompt (compiler attaches entity tags itself). */
export function stripKeywordTokens(scene, entities) {
    let s = String(scene ?? '');
    for (const e of entities) {
        for (const k of [e.keyword, ...(e.aliases ?? [])]) {
            if (!k) continue;
            s = s.replace(new RegExp(`\\$${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), e.name || '');
        }
    }
    return s.replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').trim();
}

/**
 * @param {{ scene:string, characters:object[], personas:object[], style:object|null, settings:object, backend:'sd'|'nai', merged?:boolean }} a
 *   merged=true: `scene` already contains the cast (refine mode) -> character/persona fragments are NOT prepended;
 *   their LoRAs and negatives still apply. Quality prefix and style are always handled here.
 * @returns {{ prompt:string, negative:string }}
 */
export function compilePrompt(a) {
    const g = a.settings.generate;
    const ents = [...a.characters, ...a.personas];
    const styleList = a.style ? [a.style] : [];
    const all = [...styleList, ...ents];
    const natural = g.dialect === 'natural';
    const scene = stripKeywordTokens(a.scene, ents);

    const pick = e => natural ? (e.natural || e.tags) : (e.tags || e.natural);
    const useQuality = g.useQualityPrefix !== false && !natural;

    let prompt = joinTags(
        lorasAt(all, 'front'),
        useQuality ? g.qualityPrefix : '',
        styleList.map(pick),
        lorasAt(all, 'after_style'),
        a.merged ? [] : a.characters.map(pick),
        a.merged ? [] : a.personas.map(pick),
        scene,
        lorasAt(all, 'end'),
    );
    // Negative disabled -> send nothing at all (entity negatives included), for models that take no negative.
    let negative = g.useNegative === false ? '' : joinTags(g.negative, all.map(e => e.negative));

    if (a.backend === 'nai') {
        // NovelAI has no LoRA syntax.
        prompt = prompt.replace(LORA_RE, '').replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim();
    }
    return { prompt, negative };
}

/** Parameters for one model: saved profile > backend fallback profile ('*') > built-in defaults. */
export function modelParams(settings, backend, model) {
    const prof = settings.connection.profiles?.[backend] ?? {};
    return { ...PARAM_DEFAULTS[backend], ...(prof['*'] ?? {}), ...(model && prof[model] ? prof[model] : {}) };
}

export function hasProfile(settings, backend, model) {
    return Boolean(model && settings.connection.profiles?.[backend]?.[model]);
}

/** Effective numeric params for the backend's default model: overrides (non-zero) win over the model profile. */
export function effectiveParams(settings, backend) {
    const base = settings.connection[backend];
    const p = modelParams(settings, backend, base.model);
    const o = settings.generate.overrides ?? {};
    return {
        steps: o.steps > 0 ? o.steps : p.steps,
        cfg: o.cfg > 0 ? o.cfg : p.cfg,
        width: o.width > 0 ? o.width : p.width,
        height: o.height > 0 ? o.height : p.height,
        sampler: p.sampler,
        scheduler: p.scheduler,
        model: base.model,
    };
}
