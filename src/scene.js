// IF Imgen - scene token expansion + scene-setting / refine prompts. Pure module.
//
// Planner output uses tokens:
//   $yenka          -> the entity (its base look is attached by the compiler)
//   $yenka.back     -> one DETAIL (facet) of that entity, e.g. "a big tattoo on left shoulder back"
//   $char.back / $charBack   -> same facet of the most recently mentioned character
//   $user.outfit / $userOutfit / $persona.outfit -> same for the user persona
//
// Mode 'plan'  (1 LLM call): tokens are expanded verbatim into the scene text.
// Mode 'refine' (3 LLM calls per MESSAGE, independent of the image count):
//   1. planner -> N shot drafts (with tokens)
//   2. setting -> ONE shared SCENE SETTING: where, who is present, what each wears, what they do, poses
//   3. refine  -> ONE batch call: setting + cast + the N drafts -> N final prompts (JSON array)
// The batch call (never one call per image) keeps location / people / clothing identical across images.
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

// ---------------------------------------------------------------- scene setting (refine step 1)

export const DEFAULT_SETTING_SYSTEM = `You are the continuity supervisor of an illustrated roleplay. You read the latest reply (numbered paragraphs) plus earlier context and write ONE SCENE SETTING that every image made for this reply must obey.
Write plain text with these sections, short factual lines:
LOCATION: where this happens (indoors/outdoors, room type, notable furniture or props), time of day, weather, lighting.
PEOPLE PRESENT: how many people are physically in the scene, then their names.
For EACH person present, one block:
- <name>
  WEARING: the exact clothing right now and its state (buttoned, soaked, pushed off one shoulder, removed...). If the CAST lists an outfit detail for that person, use it unless the text clearly says otherwise. If they are undressed, say so.
  DOING: what they do over the course of this reply, in order.
  POSE / POSITION: body position and where they are relative to the others and to the furniture.
Rules: state only what the text and cast say or clearly imply; never invent new people; never describe fixed looks (hair, eyes, body, face); clothing does not change between paragraphs unless the text says it does. No preamble, no markdown, no quotes.`;

/**
 * Build the scene-setting messages (one call per message, shared by all its images).
 * @param {{ system?:string, paragraphs:{index:number,text:string}[], context?:string, characters:object[], personas:object[] }} a
 */
export function buildSettingPrompt(a) {
    const system = String(a.system || DEFAULT_SETTING_SYSTEM);
    const cast = [...(a.characters ?? []).map(e => [e, 'character']), ...(a.personas ?? []).map(e => [e, 'user persona'])];
    const castBlock = cast.map(([e, label]) => {
        const facets = (e.facets ?? []).map(f => `  ${f.key}: ${f.text}`);
        return `- ${e.name} (${label})${facets.length ? `\n${facets.join('\n')}` : ''}`;
    });
    const paraBlock = (a.paragraphs ?? []).map(p => `[${p.index}] ${p.text}`).join('\n\n');
    const user = [
        castBlock.length ? `CAST (known people and their stored details):\n${castBlock.join('\n')}` : 'CAST: (nobody from the roster)',
        a.context ? `EARLIER CONTEXT:\n${a.context}` : '',
        `LATEST REPLY, NUMBERED PARAGRAPHS:\n${paraBlock}`,
        'Write the scene setting now.',
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

// ---------------------------------------------------------------- refine (step 2, ONE batch call for all shots)

export const DEFAULT_REFINE_SYSTEM = `You write prompts for an image generation model. You receive a SCENE SETTING (the authoritative description of the place, who is present, what each person wears and does), a CAST (people with their base look and the details that matter), an optional STYLE, and {{count}} SHOT DRAFT(S) written by a director. Write one final image prompt per shot.
Rules:
- The SCENE SETTING is the single source of truth: the same location, the same people and the same clothing (and clothing state) appear in EVERY prompt. Never change an outfit between shots unless the setting or that draft explicitly says so.
- Keep every visual fact from the cast and the draft; do not invent new people or change what they do.
- Fold the base look and the listed details into the description of the person naturally (e.g. "a small girl with dark parted hair ... a big tattoo on her left shoulder blade visible through the wet shirt").
- Include only what would be visible in that shot; if a person is seen from behind, do not describe the face.
- Do not repeat the same fact twice inside one prompt. No preamble, no explanation, no markdown fence.
- {{dialect_rule}}
OUTPUT FORMAT (strict): reply with ONLY a JSON array of exactly {{count}} objects, in draft order:
[{"i": 1, "prompt": "<final prompt for shot 1>"}, {"i": 2, "prompt": "<final prompt for shot 2>"}]`;

export const REFINE_DIALECT_RULES = {
    tags: 'Each prompt is comma-separated danbooru-style tags (lowercase, spaces not underscores), 20-45 tags, most important first: count tags, then the people with their look/details, then actions, poses, expressions, clothing state, setting, lighting, camera.',
    natural: 'Each prompt is one vivid natural-language paragraph of 60-110 words: people first (look + details + action), then setting, lighting, camera.',
};

/**
 * Build the refine messages for ALL shots of a message in one call.
 * @param {{ system:string, dialect:string, setting?:string, shots?:{expanded:string, used:Map<string,Set<string>>}[], expanded?:string, used?:Map<string,Set<string>>, characters:object[], personas:object[], style:object|null }} a
 *   shots      - one entry per image (draft with names/facets already expanded + facets it referenced)
 *   expanded/used - legacy single-shot form, equivalent to shots=[{expanded, used}]
 */
export function buildRefinePrompt(a) {
    const shots = a.shots ?? [{ expanded: a.expanded, used: a.used }];
    const count = shots.length;
    const system = String(a.system || DEFAULT_REFINE_SYSTEM)
        .replaceAll('{{dialect_rule}}', REFINE_DIALECT_RULES[a.dialect] ?? REFINE_DIALECT_RULES.natural)
        .replaceAll('{{count}}', String(count));
    const natural = a.dialect === 'natural';
    // Facets referenced by ANY shot -> listed once for the cast.
    const used = new Map();
    for (const s of shots) for (const [id, keys] of (s.used ?? new Map())) { if (!used.has(id)) used.set(id, new Set()); for (const k of keys) used.get(id).add(k); }
    const castBlock = [];
    const cast = [...a.characters.map(e => [e, 'character']), ...a.personas.map(e => [e, 'user persona'])];
    for (const [e, label] of cast) {
        const base = natural ? (e.natural || e.tags) : (e.tags || e.natural);
        const keys = used.get(e.id) ?? new Set();
        const details = (e.facets ?? []).filter(f => keys.has(f.key)).map(f => `  - ${f.key}: ${f.text}`);
        castBlock.push(`- ${e.name} (${label}): ${base || '(no base description)'}${details.length ? `\n  details for these shots:\n${details.join('\n')}` : ''}`);
    }
    const styleLine = a.style ? `STYLE: ${a.style.natural || a.style.tags || a.style.name}` : '';
    const drafts = shots.map((s, i) => `[${i + 1}] ${s.expanded}`).join('\n\n');
    const user = [
        a.setting ? `SCENE SETTING (shared by all shots, authoritative):\n${a.setting}` : '',
        castBlock.length ? `CAST:\n${castBlock.join('\n')}` : 'CAST: (nobody from the roster)',
        styleLine,
        `SHOT DRAFTS (director's drafts, names already resolved):\n${drafts}`,
        `Write the ${count} final prompt(s) now as the JSON array.`,
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

const cleanPrompt = v => String(v ?? '').replace(/^["'`\s]+|["'`\s]+$/g, '').trim();

/**
 * Parse the batch refine reply into `count` prompts (draft order). Missing slots are ''.
 * Accepts [{i,prompt}], ["...", "..."], {"prompts":[...]}; a single shot may also be plain text.
 * @returns {string[]} length === count
 */
export function parseRefined(text, count) {
    const s = String(text ?? '').trim();
    const n = Math.max(1, Number(count) || 1);
    let arr = null;
    const start = s.indexOf('['), end = s.lastIndexOf(']');
    if (start >= 0 && end > start) { try { const j = JSON.parse(s.slice(start, end + 1)); if (Array.isArray(j)) arr = j; } catch { /* fall through */ } }
    if (!arr) {
        const os = s.indexOf('{'), oe = s.lastIndexOf('}');
        if (os >= 0 && oe > os) { try { const j = JSON.parse(s.slice(os, oe + 1)); if (Array.isArray(j?.prompts)) arr = j.prompts; else if (typeof j?.prompt === 'string') arr = [j]; } catch { /* fall through */ } }
    }
    if (!arr) return n === 1 && s ? [cleanPrompt(s)] : new Array(n).fill('');
    const out = new Array(n).fill('');
    arr.forEach((item, k) => {
        const p = cleanPrompt(typeof item === 'string' ? item : item?.prompt);
        const i = Number(item?.i);
        const idx = Number.isInteger(i) && i >= 1 && i <= n ? i - 1 : k;
        if (idx < n && p && !out[idx]) out[idx] = p;
    });
    return out;
}
