// IF Imgen - scene token expansion + scene-setting / refine prompts. Pure module.
//
// Planner output uses tokens:
//   $yenka          -> the entity (its base look is attached by the compiler)
//   $yenka.back     -> one DETAIL (facet) of that entity, e.g. "a big tattoo on left shoulder back"
//   $char.back / $charBack   -> same facet of the most recently mentioned character
//   $user.outfit / $userOutfit / $persona.outfit -> same for the user persona
//
// Pipeline per MESSAGE (independent of the image count):
//   1. scene planner -> ONE SCENE DOCUMENT: what happens, style, location, detailed layout, who is present,
//                       what each wears (colours, state), expression, actions, pose. Stored on the message and
//                       handed to the planner of the NEXT reply for continuity.
//   2. translator    -> the scene document + the numbered paragraphs -> N image prompts with tokens (JSON array)
//   3. refine (optional) -> ONE batch call: document + cast + the N prompts -> N polished prompts (JSON array)
// Regenerating an image re-runs step 2 (+3) from the stored document; only "regen scene" re-runs step 1.
import { keysOf, normalizeKeyword } from './entities.js';
import { extractJsonArray } from './presets.js';

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
 * Expand tokens in a planner scene (or in a scene document).
 * @param {{ scene:string, characters:object[], personas:object[], keepUnknown?:boolean }} a
 *   keepUnknown - leave unresolved tokens in the text instead of dropping them (scene documents: never lose a line)
 * @returns {{ text:string, used: Map<string, Set<string>>, unknown:string[] }}
 *   text    - scene with tokens replaced (entity -> name, facet -> facet text)
 *   used    - entityId -> facet keys referenced (empty set = only the base look)
 *   unknown - tokens that could not be resolved (dropped from text unless keepUnknown)
 */
export function expandScene({ scene, characters = [], personas = [], keepUnknown = false }) {
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
        if (!e) { unknown.push(m); return keepUnknown ? m : ''; }
        if (!f) { mark(e); return e.name || ''; }
        const fx = facetOf(e, f);
        if (!fx) { unknown.push(m); mark(e); return keepUnknown ? m : (e.name || ''); }
        mark(e, f);
        return fx.text;
    });
    return { text: keepUnknown ? text.trim() : tidy(text), used, unknown };
}

/**
 * Scene document -> plain words for the translator / refine LLM: every $keyword becomes the name, every
 * $keyword.detail its stored text; tokens that do not resolve stay as written (nothing is lost). The document
 * itself is stored WITH tokens so later edits of an entity's details reach every future regenerate.
 */
export function expandSceneDoc({ doc, characters = [], personas = [] }) {
    return expandScene({ scene: doc, characters, personas, keepUnknown: true });
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

// ---------------------------------------------------------------- scene document (step 1)

export const DEFAULT_SCENE_SYSTEM = `You are the scene planner and continuity keeper of an illustrated roleplay. You read the latest reply (numbered paragraphs), the earlier chat context, the CAST (known people with their stored details) and the PREVIOUS SCENE DOCUMENTS written for earlier replies, and you write ONE SCENE DOCUMENT for this reply. Every image prompt of this reply is written from this document only, and the document is read again when the next reply is planned, so it must be precise, complete and consistent with the previous documents unless the text clearly changes something.
TOKENS: the CAST lists each known person as $keyword and each stored detail as $keyword.detail followed by its text (e.g. $yenka.outfit: white button-up shirt). Refer to a known person by $keyword or by name. When a stored detail IS what is on show or worn, write the TOKEN instead of copying its text, then add only what differs right now (e.g. WEARING: $yenka.outfit, unbuttoned, sleeves rolled up, barefoot). When the current clothing is NOT the stored outfit, describe it in words instead. Tokens are replaced by their stored text automatically later. Never write a token that is not listed and never guess what a detail contains.
Write plain text in these sections, short factual lines, in this order:
SCENE: what happens in this reply in 2-3 sentences; the mood; the visual style or genre feel (quiet domestic drama, tense noir, warm slice of life...).
LOCATION: indoors or outdoors; the type of place (bedroom, kitchen, alley, forest road...); time of day; weather; the light sources and the quality of the light (colour, direction, intensity).
LAYOUT: the room or area in detail - size, walls / floor / ceiling or ground and sky, doors and windows, every notable piece of furniture and prop and WHERE it is (bed against the left wall, nightstand with a lit lamp on its right, window behind the bed, clothes on the floor by the door...). When the place is the same as in a previous document, carry its layout over and only add what is new.
PEOPLE PRESENT: how many people are physically in the scene, then their names. People only mentioned, remembered or on the phone are NOT present.
For EACH person present, one block:
- <name>
  WEARING: every garment right now with its colour, material or pattern when known, and its state (buttoned, unbuttoned, soaked, torn, pushed off one shoulder, removed and lying where...). Include footwear and accessories. If the CAST lists an outfit detail for that person, write its token ($keyword.outfit) plus the current state unless the text clearly says they wear something else. If undressed, say exactly what is on and what is off.
  EXPRESSION: the face and the gaze (what or whom they look at), the emotion as it shows on the face.
  DOING: what they do over the course of this reply, in order, with the paragraph number of each action ([3] sits on the edge of the bed...).
  POSE / POSITION: body position and where they are relative to the others and to the layout (standing by the window, kneeling at the foot of the bed, facing away...).
  If clothing changes during the reply, note the change under DOING with its paragraph number and put the FINAL state under WEARING.
CONTINUITY: what stays as in the previous document and what changed (moved to another room, undressed, a new prop, time passed, someone left or arrived).
Rules: state only what the text, the cast and the previous documents say or clearly imply; never invent new people; never describe fixed looks (hair colour, eyes, body, face, height) - those are attached automatically; never contradict a previous document unless this reply clearly changes it. No preamble, no markdown, no quotes.`;

/**
 * Build the scene-document messages (step 1, one call per message, shared by all its images).
 * @param {{ system?:string, paragraphs:{index:number,text:string}[], context?:string, previous?:{id:number,text:string}[], characters:object[], personas:object[] }} a
 *   previous - scene documents of earlier replies (oldest first) handed over for continuity
 */
export function buildScenePrompt(a) {
    const system = String(a.system || DEFAULT_SCENE_SYSTEM);
    const cast = [...(a.characters ?? []).map(e => [e, 'character']), ...(a.personas ?? []).map(e => [e, 'user persona'])];
    // Each detail is shown as its token + text, so the planner can write the token and still knows what it means.
    const castBlock = cast.map(([e, label]) => {
        const facets = (e.facets ?? []).map(f => `  $${e.keyword}.${f.key}: ${f.text}`);
        return `- ${e.name} (${label}) — token $${e.keyword}${facets.length ? `\n${facets.join('\n')}` : ''}`;
    });
    const prev = (a.previous ?? []).filter(x => x && String(x.text ?? '').trim());
    const prevBlock = prev.map((x, i) => `--- document ${i + 1} of ${prev.length}${i === prev.length - 1 ? ' (most recent)' : ''} ---\n${String(x.text).trim()}`).join('\n\n');
    const paraBlock = (a.paragraphs ?? []).map(p => `[${p.index}] ${p.text}`).join('\n\n');
    const user = [
        castBlock.length ? `CAST (known people and their stored details; write the tokens, they are expanded later):\n${castBlock.join('\n')}` : 'CAST: (nobody from the roster)',
        prev.length ? `PREVIOUS SCENE DOCUMENTS (continuity - keep what did not change):\n${prevBlock}` : 'PREVIOUS SCENE DOCUMENTS: (none - this is the first illustrated reply)',
        a.context ? `EARLIER CONTEXT:\n${a.context}` : '',
        `LATEST REPLY, NUMBERED PARAGRAPHS:\n${paraBlock}`,
        'Write the scene document for the latest reply now (use the listed tokens for people and their stored details).',
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

// ---------------------------------------------------------------- refine (step 3, ONE batch call for all shots)

export const DEFAULT_REFINE_SYSTEM = `You polish prompts for an image generation model. You receive a SCENE DOCUMENT (the authoritative description of the place, its layout, who is present, what each person wears, feels and does), a CAST (people with their base look and the details that matter), an optional STYLE, and {{count}} SHOT DRAFT(S) already written from that document. Write one final image prompt per shot: keep the content of the draft, add the missing visual tags and tidy the details.
Rules:
- The SCENE DOCUMENT is the single source of truth: the same location, the same people and the same clothing (colours and state) appear in EVERY prompt. Never change an outfit between shots unless the document says it changes at that moment.
- A SHOT DRAFT chooses the moment, the action, the framing and the camera. If a draft or a cast detail contradicts the document about place, who is present or what someone wears, the DOCUMENT wins and the contradiction is dropped.
- Keep every visual fact from the cast and the draft that does not conflict with the document; do not invent new people, garments or props, or change what they do.
- Fold the base look and the listed details into the description of the person naturally (e.g. "a small girl with dark parted hair ... a big tattoo on her left shoulder blade visible through the wet shirt").
- Include only what would be visible in that shot; if a person is seen from behind, do not describe the face.
- Do not repeat the same fact twice inside one prompt. No preamble, no explanation, no markdown fence.
- {{dialect_rule}}
OUTPUT FORMAT (strict): reply with ONLY a JSON array of exactly {{count}} objects, in draft order. Never use double quotes inside a prompt string:
[{"i": 1, "prompt": "<final prompt for shot 1>"}, {"i": 2, "prompt": "<final prompt for shot 2>"}]`;

export const REFINE_DIALECT_RULES = {
    tags: 'Each prompt is comma-separated danbooru-style tags (lowercase, spaces not underscores), 30-60 tags, most important first: count tags, then the people with their look/details, then actions, poses, expressions, every garment with colour and state, position relative to the furniture, place and the props in frame, lighting, camera. Keep every place / clothing / pose fact of the draft; add missing tags, never remove facts.',
    natural: 'Each prompt is one vivid natural-language paragraph of roughly 90-150 words (do not count words, just stay complete): people first (look + clothing with colours and state from the document + details + expression + action + position), then the place with its props, lighting, camera. Keep every place / clothing / pose fact of the draft; add what is missing, never remove facts.',
};

/**
 * Build the refine messages for ALL shots of a message in one call.
 * @param {{ system:string, dialect:string, setting?:string, shots?:{expanded:string, used:Map<string,Set<string>>}[], expanded?:string, used?:Map<string,Set<string>>, characters:object[], personas:object[], style:object|null }} a
 *   setting    - the scene document of the message (step 1)
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
        a.setting ? `SCENE DOCUMENT (shared by all shots, authoritative):\n${a.setting}` : '',
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
    arr = extractJsonArray(s);
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
