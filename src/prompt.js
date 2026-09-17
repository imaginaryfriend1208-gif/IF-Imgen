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

/** First sentences of a prose fragment up to ~max chars (cut at a sentence end, else at a comma, else hard). */
export function clipProse(text, max = 220) {
    const s = String(text ?? '').trim();
    if (s.length <= max) return s;
    const head = s.slice(0, max + 1);
    const dot = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    if (dot >= max * 0.4) return head.slice(0, dot + 1);
    const comma = head.lastIndexOf(', ');
    if (comma >= max * 0.5) return head.slice(0, comma);
    return head.slice(0, max).replace(/\s+\S*$/, '');
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
    const prefs = modelPromptPrefs(a.settings, a.backend);
    const natural = (a.dialect ?? prefs.dialect ?? g.dialect) === 'natural';
    const scene = stripKeywordTokens(a.scene, ents);

    const pick = e => natural ? softenTags(e.natural || e.tags) : (e.tags || e.natural);
    const useQuality = g.useQualityPrefix !== false && !natural;

    let prompt;
    if (natural) {
        // Prose: the SCENE leads (subject + camera sentence first - that is what Flux / Krea weigh most), then the cast
        // in one short clause each (only when the scene does not already carry the look), then the style trimmed to
        // its opening sentences. Long style / look paragraphs placed first were dragging every image towards the
        // style's reference painters and the cast's ethnic markers instead of the scene. LoRA tags stay as tokens.
        const loras = [...lorasAt(all, 'front'), ...lorasAt(all, 'after_style'), ...lorasAt(all, 'end')].join(' ');
        // Style: its one-sentence "lead" opens the prompt (medium / look in a few words - what Flux / Krea weigh most);
        // without a lead, the first sentence of the style text is used. The full style text closes the prompt, clipped.
        const styleLead = styleList.map(e => String(e.lead ?? '').trim() || clipProse(pick(e), 160));
        const styleBody = styleList.map(e => (String(e.lead ?? '').trim() ? clipProse(pick(e), 350) : clipProse(pick(e).slice(styleLead[0]?.length ?? 0), 350)));
        const body = joinProse(
            styleLead,
            scene,
            a.merged ? [] : a.characters.map(e => clipProse(pick(e), 220)),
            a.merged ? [] : a.personas.map(e => clipProse(pick(e), 220)),
            styleBody,
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
    const useNeg = prefs.useNegative !== '' ? prefs.useNegative : g.useNegative !== false;
    let negative = !useNeg ? '' : joinTags(g.negative, all.map(e => e.negative));

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

/**
 * Prompt language / negative use of the ACTIVE model profile: '' (or missing) = follow the global Generate settings.
 * Selecting a Krea checkpoint with dialect 'natural' + useNegative false makes every prompt prose without a negative,
 * an Illustrious checkpoint with 'tags' goes back to danbooru tags - no need to flip the global switch per model.
 * @returns {{ dialect:''|'tags'|'natural', useNegative:''|boolean }}
 */
export function modelPromptPrefs(settings, backend) {
    const base = settings.connection?.[backend];
    const prof = settings.connection?.profiles?.[backend]?.[base?.model] ?? {};
    return { dialect: prof.dialect === 'tags' || prof.dialect === 'natural' ? prof.dialect : '', useNegative: typeof prof.useNegative === 'boolean' ? prof.useNegative : '' };
}

/** Effective numeric params for the backend's default model: overrides (non-zero) win over the model profile. */
export function effectiveParams(settings, backend, { ar = '' } = {}) {
    const base = settings.connection[backend];
    const p = modelParams(settings, backend, base.model);
    const o = settings.generate.overrides ?? {};
    let width = o.width > 0 ? o.width : p.width;
    let height = o.height > 0 ? o.height : p.height;
    // Auto aspect: the planner's "ar" swaps / squares the profile size (same pixel budget, multiples of 64).
    if (settings.generate.autoAspect !== false && ar) {
        const long = Math.max(width, height), short = Math.min(width, height);
        if (ar === 'portrait') [width, height] = [short, long];
        else if (ar === 'landscape') [width, height] = [long, short];
        else if (ar === 'square') { const sq = Math.round(Math.sqrt(width * height) / 64) * 64; width = height = sq; }
    }
    return {
        steps: o.steps > 0 ? o.steps : p.steps,
        cfg: o.cfg > 0 ? o.cfg : p.cfg,
        width, height,
        sampler: p.sampler,
        scheduler: p.scheduler,
        model: base.model,
    };
}
