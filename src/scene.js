// IF Imgen - scene token expansion + optional refine prompt. Pure module.
//
// Planner output uses tokens:
//   $yenka          -> the entity (its base look is attached by the compiler)
//   $yenka.back     -> one DETAIL (facet) of that entity, e.g. "a big tattoo on left shoulder back"
//   $char.back / $charBack   -> same facet of the most recently mentioned character
//   $user.outfit / $userOutfit / $persona.outfit -> same for the user persona
//
// Mode 'plan'  (1 LLM call): tokens are expanded verbatim into the scene text.
// Mode 'refine' (2 LLM calls): cast base + referenced facets + scene are handed to a
// second LLM which rewrites them into ONE coherent image prompt.
import { keysOf, normalizeKeyword } from './entities.js';

export const FACET_KEYS = ['outfit', 'front', 'back', 'body', 'face', 'nsfw', 'sfw', 'note'];

/** "back: a big tattoo\noutfit: white shirt" -> [{key:'back',text:'a big tattoo'}, ...] */
export function parseFacets(value) {
    if (Array.isArray(value)) return value.filter(f => f && f.key && f.text).map(f => ({ key: normKey(f.key), text: String(f.text).trim() })).filter(f => f.key && f.text);
    const out = [];
    for (const line of String(value ?? '').split('\n')) {
        // Key may be Vietnamese / contain spaces ("trang phục: áo dài") -> normalized to trang_phuc.
        const m = line.match(/^\s*\$?([^\s:$][^:]*?)\s*:\s*(.+?)\s*$/);
        if (!m) continue;
        const key = normKey(m[1]);
        if (!key) continue;
        const prev = out.find(f => f.key === key);
        if (prev) prev.text += ', ' + m[2]; else out.push({ key, text: m[2] });
    }
    return out;
}

export function facetsText(list) {
    return (list ?? []).map(f => `${f.key}: ${f.text}`).join('\n');
}

// Same normalization as keywords: strip $, diacritics (đ -> d), lowercase, spaces -> underscore.
const normKey = k => normalizeKeyword(k);
const facetOf = (e, key) => (e.facets ?? []).find(f => f.key === key) ?? null;
const RELATIVE = { char: 'characters', character: 'characters', user: 'personas', persona: 'personas' };
// Unicode-aware so "$Dư_Tô.lưng" written by the LLM still resolves to $du_to.lung.
const TOKEN_RE = /\$([\p{L}][\p{L}\p{N}_\-]*)(?:\.([\p{L}\p{N}_\-]+))?/gu;

function entityByKey(list, key) {
    const k = normalizeKeyword(key);
    return list.find(e => keysOf(e).some(x => x === k || x.replace(/_/g, '') === k.replace(/_/g, ''))) ?? null;
}

/** Split "$charBack" -> ['char','back'], "$userOutfit" -> ['user','outfit']; null otherwise. */
function splitCamelRelative(key) {
    const m = key.match(/^(char|character|user|persona)([A-Z][A-Za-z0-9_]*)$/);
    return m ? [m[1], m[2].toLowerCase()] : null;
}

/**
 * Expand tokens in a planner scene.
 * @param {{ scene:string, characters:object[], personas:object[] }} a
 * @returns {{ text:string, used: Map<string, Set<string>>, unknown:string[] }}
 *   text    - scene with tokens replaced (entity -> name, facet -> facet text)
 *   used    - entityId -> facet keys referenced (empty set = only the base look)
 *   unknown - tokens that could not be resolved (dropped from text)
 */
export function expandScene({ scene, characters = [], personas = [] }) {
    const used = new Map();
    const unknown = [];
    const last = { characters: characters[0] ?? null, personas: personas[0] ?? null };
    const mark = (e, facet) => { if (!used.has(e.id)) used.set(e.id, new Set()); if (facet) used.get(e.id).add(facet); };

    const text = String(scene ?? '').replace(TOKEN_RE, (m, key, facet) => {
        let e = null, f = facet ? normKey(facet) : '';
        const rel = RELATIVE[key.toLowerCase()];
        const camel = !facet ? splitCamelRelative(key) : null;
        if (rel && facet) e = last[rel];
        else if (camel) { e = last[RELATIVE[camel[0]]]; f = camel[1]; }
        else {
            e = entityByKey(characters, key) ?? entityByKey(personas, key);
            if (e) last[characters.includes(e) ? 'characters' : 'personas'] = e;
        }
        if (!e) { unknown.push(m); return ''; }
        if (!f) { mark(e); return e.name || ''; }
        const fx = facetOf(e, f);
        if (!fx) { unknown.push(m); mark(e); return e.name || ''; }
        mark(e, f);
        return fx.text;
    });
    return { text: tidy(text), used, unknown };
}

function tidy(s) {
    return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/,\s*,/g, ',').replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
}

/** One line per entity for the planner roster: keyword, who they are, available details. */
export function rosterLine(e, label) {
    const desc = (e.natural || e.tags || '').slice(0, 160);
    const facets = (e.facets ?? []).map(f => `$${e.keyword}.${f.key}`);
    return `$${e.keyword} — ${label}: ${e.name}${desc ? ` — ${desc}` : ''}${facets.length ? `\n    details: ${facets.join(', ')}` : ''}`;
}

export const DEFAULT_REFINE_SYSTEM = `You write prompts for an image generation model. You receive a CAST (people with their base look and the specific details that matter for this shot), an optional STYLE, and a SCENE written by a director. Merge them into ONE final image prompt.
Rules:
- Keep every visual fact from the cast and the scene; do not invent new people or change what they do.
- Fold the base look and the listed details into the description of the person naturally (e.g. "a small girl with dark parted hair ... a big tattoo on her left shoulder blade visible through the wet shirt").
- Include only what would be visible in this shot; if a person is seen from behind, do not describe the face.
- Do not repeat the same fact twice. No preamble, no explanation, no quotes.
- {{dialect_rule}}
Output the prompt text only.`;

export const REFINE_DIALECT_RULES = {
    tags: 'Output comma-separated danbooru-style tags (lowercase, spaces not underscores), 20-45 tags, most important first: count tags, then the people with their look/details, then actions, poses, expressions, clothing state, setting, lighting, camera.',
    natural: 'Output one vivid natural-language paragraph of 60-110 words: people first (look + details + action), then setting, lighting, camera.',
};

/**
 * Build the refine (2nd call) messages.
 * @param {{ system:string, dialect:string, scene:string, expanded:string, used:Map<string,Set<string>>, characters:object[], personas:object[], style:object|null }} a
 */
export function buildRefinePrompt(a) {
    const system = String(a.system || DEFAULT_REFINE_SYSTEM).replaceAll('{{dialect_rule}}', REFINE_DIALECT_RULES[a.dialect] ?? REFINE_DIALECT_RULES.natural);
    const natural = a.dialect === 'natural';
    const castBlock = [];
    const cast = [...a.characters.map(e => [e, 'character']), ...a.personas.map(e => [e, 'user persona'])];
    for (const [e, label] of cast) {
        const base = natural ? (e.natural || e.tags) : (e.tags || e.natural);
        const keys = a.used.get(e.id) ?? new Set();
        const details = (e.facets ?? []).filter(f => keys.has(f.key)).map(f => `  - ${f.key}: ${f.text}`);
        castBlock.push(`- ${e.name} (${label}): ${base || '(no base description)'}${details.length ? `\n  details for this shot:\n${details.join('\n')}` : ''}`);
    }
    const styleLine = a.style ? `STYLE: ${a.style.natural || a.style.tags || a.style.name}` : '';
    const user = [
        castBlock.length ? `CAST:\n${castBlock.join('\n')}` : 'CAST: (nobody from the roster)',
        styleLine,
        `SCENE (director's draft, names already resolved):\n${a.expanded}`,
        'Write the final prompt now.',
    ].filter(Boolean).join('\n\n');
    return { system, user };
}
