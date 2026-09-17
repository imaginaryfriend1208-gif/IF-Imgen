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

const COUNT_WORDS = {
    '1girl': 'a young woman', '2girls': 'two young women', '3girls': 'three young women', 'multiple girls': 'several young women',
    '1boy': 'a young man', '2boys': 'two young men', '3boys': 'three young men', 'multiple boys': 'several young men',
    '1other': 'one person', 'solo': 'alone', 'no humans': 'an empty scene without people',
};
const QUALITY_WORDS = /^(masterpiece|best quality|amazing quality|very aesthetic|absurdres|highres|high resolution|ultra[- ]detailed|highly detailed|extremely detailed|8k|4k|uhd|hdr|newest|very awa|score[ _]\d+([ _]up)?|source[ _]\w+|rating[ _]\w+|safe|general|sensitive|questionable|explicit|nsfw|sfw)$/i;

/**
 * Turn a comma-separated tag fragment into prose-friendly text for models that read sentences (Flux / Krea):
 * drops weight syntax ((tag:1.3), {tag}, [tag]), quality / rating tags and underscores, rewrites count tags
 * (1girl -> a young woman) and joins the rest with commas into one clause. Text that already looks like prose
 * (has sentence punctuation, few commas) is returned as is, minus weights.
 */
export function softenTags(text) {
    let s = String(text ?? '').trim();
    if (!s) return '';
    s = s.replace(LORA_RE, '').replace(/\(([^()]*?):\s*-?\d+(?:\.\d+)?\)/g, '$1').replace(/[{}[\]()]/g, '').replace(/_/g, ' ');
    const items = s.split(',').map(x => x.trim()).filter(Boolean);
    const proseLike = /[.!?;]/.test(s) && items.some(x => x.split(/\s+/).length > 5);
    if (proseLike) return items.join(', ');
    const out = [];
    for (const it of items) {
        const low = it.toLowerCase();
        if (QUALITY_WORDS.test(low)) continue;
        out.push(COUNT_WORDS[low] ?? it);
    }
    return out.join(', ');
}

/** Join prose fragments into sentences: each non-empty part ends with a full stop. */
function joinProse(...parts) {
    const out = [];
    for (const p of parts.flat()) {
        let s = String(p ?? '').trim().replace(/^[,.\s]+|[,\s]+$/g, '').trim();
        if (!s) continue;
        if (!/[.!?]$/.test(s)) s += '.';
        out.push(s);
    }
    return out.join(' ');
}

/**
 * @param {{ scene:string, characters:object[], personas:object[], style:object|null, settings:object, backend:'sd'|'nai', merged?:boolean, dialect?:string }} a
 *   <lora:...> tags stay in the prompt; in workflow mode the sd backend turns them into LoRA nodes.
 *   merged=true: `scene` already contains the cast (refine mode) -> character/persona fragments are NOT prepended;
 *   their LoRAs and negatives still apply. Quality prefix and style are always handled here.
 *   dialect: effective dialect (preset-forced or global); defaults to settings.generate.dialect.
 *   natural: entity / style fragments go through softenTags(), parts are joined as sentences, no quality prefix;
 *   the negative is still sent unless disabled (Krea users turn it off in Generate).
 * @returns {{ prompt:string, negative:string }}
 */
export function compilePrompt(a) {
    const g = a.settings.generate;
    const ents = [...a.characters, ...a.personas];
    const styleList = a.style ? [a.style] : [];
    const all = [...styleList, ...ents];
    const natural = (a.dialect ?? g.dialect) === 'natural';
    const scene = stripKeywordTokens(a.scene, ents);

    const pick = e => natural ? softenTags(e.natural || e.tags) : (e.tags || e.natural);
    const useQuality = g.useQualityPrefix !== false && !natural;

    let prompt;
    if (natural) {
        // Prose: LoRA tags stay as separate tokens (the backend strips them into nodes); everything else is sentences.
        const loras = [...lorasAt(all, 'front'), ...lorasAt(all, 'after_style'), ...lorasAt(all, 'end')].join(' ');
        const body = joinProse(
            styleList.map(pick),
            a.merged ? [] : a.characters.map(pick),
            a.merged ? [] : a.personas.map(pick),
            scene,
        );
        prompt = [loras, body].filter(Boolean).join(' ');
    } else {
        prompt = joinTags(
            lorasAt(all, 'front'),
            useQuality ? g.qualityPrefix : '',
            styleList.map(pick),
            lorasAt(all, 'after_style'),
            a.merged ? [] : a.characters.map(pick),
            a.merged ? [] : a.personas.map(pick),
            scene,
            lorasAt(all, 'end'),
        );
    }
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
