// IF Imgen - final prompt compiler. Pure module.
// Order: [front LoRAs] quality, style tags, [after_style LoRAs], character tags, persona tags, scene, [end LoRAs]
import { joinTags } from './util.js';

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
 * @param {{ scene:string, characters:object[], personas:object[], style:object|null, settings:object, backend:'sd'|'nai' }} a
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

    let prompt = joinTags(
        lorasAt(all, 'front'),
        natural ? '' : g.qualityPrefix,
        styleList.map(pick),
        lorasAt(all, 'after_style'),
        a.characters.map(pick),
        a.personas.map(pick),
        scene,
        lorasAt(all, 'end'),
    );
    let negative = joinTags(g.negative, all.map(e => e.negative));

    if (a.backend === 'nai') {
        // NovelAI has no LoRA syntax.
        prompt = prompt.replace(LORA_RE, '').replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim();
    }
    return { prompt, negative };
}

/** Effective numeric params: overrides (non-zero) win over backend defaults. */
export function effectiveParams(settings, backend) {
    const base = settings.connection[backend];
    const o = settings.generate.overrides ?? {};
    return {
        steps: o.steps > 0 ? o.steps : base.steps,
        cfg: o.cfg > 0 ? o.cfg : base.cfg,
        width: o.width > 0 ? o.width : base.width,
        height: o.height > 0 ? o.height : base.height,
        sampler: base.sampler,
        scheduler: base.scheduler,
        model: base.model,
    };
}
