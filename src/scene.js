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

/**
 * "back: a big tattoo\noutfit: white shirt" -> [{key:'back',text:'a big tattoo'}, ...]
 * A World entry written as "world.chinatown_alley: ..." (or "$world.chinatown_alley: ...") gets scope 'world': it is
 * addressed as $world.chinatown_alley in documents and prompts (a place / NPC of the story, not of one person).
 */
export function parseFacets(value) {
    const scoped = (key, text, scope) => scope === 'world' ? { key, text, scope } : { key, text };
    if (Array.isArray(value)) return value.filter(f => f && f.key && f.text).map(f => scoped(normKey(f.key), String(f.text).trim(), f.scope)).filter(f => f.key && f.text);
    const out = [];
    for (const line of String(value ?? '').split('\n')) {
        // Key may be Vietnamese / contain spaces ("trang phục: áo dài") -> normalized to trang_phuc.
        const m = line.match(/^\s*\$?([^\s:$][^:]*?)\s*:\s*(.+?)\s*$/);
        if (!m) continue;
        const w = m[1].trim().match(/^world\.(.+)$/i);
        const key = normKey(w ? w[1] : m[1]);
        if (!key) continue;
        const prev = out.find(f => f.key === key && (f.scope === 'world') === Boolean(w));
        if (prev) prev.text += ', ' + m[2]; else out.push(scoped(key, m[2], w ? 'world' : undefined));
    }
    return out;
}

export function facetsText(list) {
    return (list ?? []).map(f => `${f.scope === 'world' ? 'world.' : ''}${f.key}: ${f.text}`).join('\n');
}

// Same normalization as keywords: strip $, diacritics (đ -> d), lowercase, spaces -> underscore.
const normKey = k => normalizeKeyword(k);
// A token resolves against the entity's Details first, then its World (places, NPCs, recurring items), then the
// ad-hoc TOKENS the step-1 LLM defined at the top of the scene document. A stored entry always wins over an ad-hoc one.
const facetOf = (e, key) => (e.facets ?? []).find(f => f.key === key) ?? (e.world ?? []).find(f => f.key === key) ?? null;
const adhocOf = (e, key, adhoc) => (adhoc ?? []).find(tk => tk.facet === key && (tk.key === e.keyword || (e.aliases ?? []).includes(tk.key))) ?? null;
// $world.kw: a token of the story's world (place, NPC, vehicle) - stored World entries of any cast member first (an entry
// saved from a $world token keeps scope 'world'), then the ad-hoc / ledger tokens under the key 'world'.
const WORLD = 'world';
const worldOf = (key, ents, adhoc) => {
    for (const e of ents) { const f = (e.world ?? []).find(x => x.key === key && x.scope === WORLD); if (f) return f; }
    return (adhoc ?? []).find(tk => tk.key === WORLD && tk.facet === key) ?? null;
};

const TOKENS_HEAD_RE = /^\s*TOKENS\s*:/i;
const TOKEN_DEF_RE = /^\s*[-*]?\s*\$?([\p{L}][\p{L}\p{N}_\-]*)\.([\p{L}\p{N}_\-]+)\s*:\s*(.+?)\s*$/u;

/**
 * Split a scene document into its TOKENS section (ad-hoc token definitions written by the step-1 LLM for things that
 * will recur: a new outfit, an NPC, a place) and the rest. The section starts at a "TOKENS:" line and ends at the
 * first blank line or the next SECTION: header.
 * @returns {{ tokens:{key:string,facet:string,text:string}[], head:string, body:string }}
 *   tokens - [{ key:'seb', facet:'outfit_work', text:'...' }], head - the TOKENS lines verbatim ('' when absent), body - the rest
 */
export function splitDocTokens(doc) {
    const lines = String(doc ?? '').split(/\r?\n/);
    const start = lines.findIndex(l => TOKENS_HEAD_RE.test(l));
    if (start < 0) return { tokens: [], head: '', body: String(doc ?? '') };
    let end = start + 1;
    while (end < lines.length && lines[end].trim() && !/^[A-Z][A-Z /]+:/.test(lines[end].trim())) end++;
    const head = lines.slice(start, end);
    const tokens = [];
    // Definitions may also sit on the TOKENS: line itself ("TOKENS: $seb.hat: a grey cap").
    for (const l of [head[0].replace(TOKENS_HEAD_RE, ''), ...head.slice(1)]) {
        const m = l.match(TOKEN_DEF_RE);
        if (!m) continue;
        const key = normalizeKeyword(m[1]), facet = normKey(m[2]);
        if (!key || !facet) continue;
        const prev = tokens.find(tk => tk.key === key && tk.facet === facet);
        if (prev) prev.text = m[3]; else tokens.push({ key, facet, text: m[3] });
    }
    const body = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/^\n+/, '');
    return { tokens, head: head.join('\n'), body };
}

/** Ad-hoc tokens defined in a scene document's TOKENS section (see splitDocTokens). */
export function parseDocTokens(doc) { return splitDocTokens(doc).tokens; }
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
 * @param {{ scene:string, characters:object[], personas:object[], keepUnknown?:boolean, adhoc?:{key:string,facet:string,text:string}[] }} a
 *   keepUnknown - leave unresolved tokens in the text instead of dropping them (scene documents: never lose a line)
 *   adhoc       - tokens defined in the scene document's TOKENS section (parseDocTokens); resolved after Details / World
 * @returns {{ text:string, used: Map<string, Set<string>>, unknown:string[] }}
 *   text    - scene with tokens replaced (entity -> name, facet -> facet text)
 *   used    - entityId -> facet keys referenced (empty set = only the base look)
 *   unknown - tokens that could not be resolved (dropped from text unless keepUnknown)
 */
export function expandScene({ scene, characters = [], personas = [], keepUnknown = false, adhoc = [] }) {
    const used = new Map();
    const unknown = [];
    const last = { characters: characters[0] ?? null, personas: personas[0] ?? null };
    const mark = (e, facet) => { if (!used.has(e.id)) used.set(e.id, new Set()); if (facet) used.get(e.id).add(facet); };

    const text = String(scene ?? '').replace(TOKEN_RE, (m, key, facet) => {
        let e = null, f = facet ? normKey(facet) : '';
        const rel = RELATIVE[key.toLowerCase()];
        const camel = !facet ? splitCamelRelative(key) : null;
        if (key.toLowerCase() === WORLD && f) {
            const w = worldOf(f, [...characters, ...personas], adhoc);
            if (w) return w.text;
            unknown.push(m); return keepUnknown ? m : '';
        }
        if (rel && facet) e = last[rel];
        else if (camel) { e = last[RELATIVE[camel[0]]]; f = camel[1]; }
        else {
            e = entityByKey(characters, key) ?? entityByKey(personas, key);
            if (e) last[characters.includes(e) ? 'characters' : 'personas'] = e;
        }
        if (!e) { unknown.push(m); return keepUnknown ? m : ''; }
        if (!f) { mark(e); return e.name || ''; }
        const fx = facetOf(e, f) ?? adhocOf(e, f, adhoc);
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
export function expandSceneDoc({ doc, characters = [], personas = [], adhoc = [] }) {
    // The TOKENS section is kept verbatim (its lines ARE the definitions); the body is expanded with them, then with
    // the chat ledger (tokens defined by earlier documents of this chat).
    const { tokens, head, body } = splitDocTokens(doc);
    const ex = expandScene({ scene: body, characters, personas, keepUnknown: true, adhoc: [...tokens, ...adhoc] });
    return { ...ex, text: [head, ex.text].filter(Boolean).join('\n'), tokens };
}

function tidy(s) {
    return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/,\s*,/g, ',').replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
}

/**
 * Roster block of one entity for the step-2 LLM: keyword, base look (the dialect's text), then every Details and
 * World entry as "$keyword.key: text". The writer needs the TEXTS to write the "final" (smooth) prompt; the tokens
 * alone are enough for the raw "prompt".
 */
export function rosterLine(e, label, dialect = 'tags') {
    const look = String((dialect === 'natural' ? (e.natural || e.tags) : (e.tags || e.natural)) || '').trim();
    const tok = list => (list ?? []).map(f => `    $${e.keyword}.${f.key}: ${f.text}`);
    const details = tok(e.facets), world = tok(e.world);
    return [
        `$${e.keyword} — ${label}: ${e.name}${look ? ` — base look: ${look}` : ''}`,
        details.length ? `  details:\n${details.join('\n')}` : '',
        world.length ? `  world (places, side characters, recurring items):\n${world.join('\n')}` : '',
    ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- scene document (step 1)

export const DEFAULT_SCENE_SYSTEM = `You are the scene planner and continuity keeper of an illustrated roleplay. You read the latest reply (numbered paragraphs), the earlier chat context, the CAST (known people with their stored details) and the PREVIOUS SCENE DOCUMENTS written for earlier replies, and you write ONE SCENE DOCUMENT for this reply. Every image prompt of this reply is written from this document only, and the document is read again when the next reply is planned, so it must be precise, complete and consistent with the previous documents unless the text clearly changes something.
TOKENS: the CAST lists each known person as $keyword and each stored entry as $keyword.entry followed by its text (details = the person's own look and clothes; world = places, side characters and recurring items of that person's story). Refer to a known person by $keyword or by name. When a stored entry IS what is on show, worn or where the scene happens, write the TOKEN instead of copying its text, then add only what differs right now (e.g. WEARING: $yenka.outfit, unbuttoned, sleeves rolled up, barefoot). When the current clothing is NOT a stored outfit, describe it in words. Tokens are replaced by their stored text automatically later. Never write a token that is not listed or defined and never guess what an entry contains.
NEW TOKENS: when this reply shows something that will come back later and has NO stored token yet - a new outfit or hairstyle of a known person, a side character (NPC) who is physically present, a recurring place, vehicle or pet tied to a known person - DEFINE it once in a TOKENS section at the very top of the document, one per line, as $keyword.new_key: <full visual description in words>, then use that token below. Keys are lowercase snake_case. Something that belongs to a known person (an outfit, a hairstyle, their pet, their car) is named after the owner: $seb.outfit_work, $yen.hair_bun, $seb.car. Something that belongs to the WORLD of the story - a place, a side character (NPC), a vehicle or object nobody in the cast owns - is named $world.key: $world.npc_william, $world.chinatown_alley, $world.red_taxi. An NPC token holds everything an image model needs (apparent age, build, hair, face, clothes). Reuse a token listed under CHAT TOKENS or defined in a PREVIOUS DOCUMENT under the same name and keep its text; when the thing itself changed (the outfit is now torn and wet, the NPC shaved his beard) redefine the SAME name with the new text in TOKENS - do not invent a second name for the same thing. Do not define tokens for one-off props.
Write plain text in these sections, short factual lines, in this order:
TOKENS: (only when needed - the new token definitions described above; omit the section when there is nothing new)
SCENE: what happens in this reply in 2-3 sentences; the mood; the visual style or genre feel (quiet domestic drama, tense noir, warm slice of life...).
LOCATION: indoors or outdoors; the type of place (bedroom, kitchen, alley, forest road...); time of day; weather; the light sources and the quality of the light (colour, direction, intensity).
LAYOUT: the room or area in detail - size, walls / floor / ceiling or ground and sky, doors and windows, every notable piece of furniture and prop and WHERE it is (bed against the left wall, nightstand with a lit lamp on its right, window behind the bed, clothes on the floor by the door...). When the place is the same as in a previous document, carry its layout over and only add what is new.
PEOPLE PRESENT: how many people are physically in the scene, then their names; a side character is listed by its token ($seb.npc_william). People only mentioned, remembered or on the phone are NOT present.
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
        const world = (e.world ?? []).map(f => `  $${f.scope === 'world' ? 'world' : e.keyword}.${f.key}: ${f.text}`);
        return `- ${e.name} (${label}) — token $${e.keyword}${facets.length ? `\n  details:\n${facets.join('\n')}` : ''}${world.length ? `\n  world (places, side characters, recurring items):\n${world.join('\n')}` : ''}`;
    });
    const prev = (a.previous ?? []).filter(x => x && String(x.text ?? '').trim());
    const prevBlock = prev.map((x, i) => `--- document ${i + 1} of ${prev.length}${i === prev.length - 1 ? ' (most recent)' : ''} ---\n${String(x.text).trim()}`).join('\n\n');
    const paraBlock = (a.paragraphs ?? []).map(p => `[${p.index}] ${p.text}`).join('\n\n');
    const user = [
        castBlock.length ? `CAST (known people and their stored details; write the tokens, they are expanded later):\n${castBlock.join('\n')}` : 'CAST: (nobody from the roster)',
        a.ledger ? `CHAT TOKENS (defined earlier in this chat - reuse these names as they are; redefine one in TOKENS only when the thing itself changed):\n${a.ledger}` : '',
        prev.length ? `PREVIOUS SCENE DOCUMENTS (continuity - keep what did not change):\n${prevBlock}` : 'PREVIOUS SCENE DOCUMENTS: (none - this is the first illustrated reply)',
        a.context ? `EARLIER CONTEXT:\n${a.context}` : '',
        `LATEST REPLY, NUMBERED PARAGRAPHS:\n${paraBlock}`,
        'Write the scene document for the latest reply now (use the listed tokens for people and their stored entries; define new tokens at the top only for things that will recur).',
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
    natural: 'Each prompt is one vivid natural-language paragraph of roughly 90-150 words (do not count words, just stay complete) for a model that reads sentences (Flux / Krea): subject and camera first (shot size, angle, framing, focus), then each person (look + clothing with colours and state from the document + details + pose and position), the action with one clause per point of contact (whose hand, what it touches), the place with its props, ONE light sentence (source, direction, quality, tone), then gaze / eyes / mouth / emotion per visible face. If the CAST or a draft is written as comma-separated tags, rewrite it into sentences (1girl -> a young woman; count / quality / weight syntax dropped; emphasised tags earlier, minor ones later with "faintly"). Never leave a comma-separated list, never use weights or brackets, never state what is absent. Keep every place / clothing / pose fact of the draft; add what is missing, never remove facts.',
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
