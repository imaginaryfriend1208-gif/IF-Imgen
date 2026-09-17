// IF Imgen - prompt translator presets (step 2: scene document -> image prompts), builtin + user. Pure module.
import { uuid } from './util.js';

const OUTPUT_RULES = `

WHAT YOU WRITE: an image prompt is a description of the SCENE in that paragraph -- who is present, what each person is doing, pose, expression, clothing state, where they are, lighting, camera angle/shot type. It is NOT a character sheet.

CAST: the ROSTER lists known people as $keyword with a short description so you can recognise them in the text. Their looks are attached automatically later, so NEVER re-describe their fixed appearance (hair, eyes, body, face, height). Mention each person present ONLY as their $keyword once, then describe what they are doing. If a paragraph has two people, mention both keywords and describe both. If a paragraph has no roster person, describe the scene without keywords.

DETAILS: a roster entry may list detail tokens such as $yenka.back, $yenka.outfit, $yenka.nsfw, $yenka.body. Each holds a stored description you cannot see. When that part of the person is visible or matters for the shot, put the TOKEN in the prompt exactly as listed (e.g. "...walking away in the rain, wet $yenka.outfit clinging to her skin, showing $yenka.back"). Never guess or write the content of a detail yourself; never reference a token that is not listed.

OUTPUT FORMAT (strict): reply with ONLY a JSON array, no prose, no markdown fence. Inside "prompt" never use double quotes (write dialogue as: mouthing the words no no):
[{"p": <paragraph number>, "prompt": "<image prompt>"}]
- "p" must be one of the paragraph numbers listed. Pick the most visual moments.
- Produce exactly {{count}} objects unless fewer paragraphs are usable.
- {{dialect_rule}}

EXAMPLE (roster has $mara with details $mara.outfit, $mara.back; and $tomas): [{"p": 3, "prompt": "$mara sits on the edge of a bed with her back to the viewer, $mara.outfit pushed off one shoulder revealing $mara.back, leaning forward and sewing a wound on $tomas's side with steady hands; $tomas lies back with eyes closed; dim bedroom, single lamp on a nightstand, warm low light, medium shot from the foot of the bed"}]`;

const DIALECT_RULES = {
    tags: 'Write comma-separated danbooru-style tags (lowercase, spaces not underscores), 20-45 tags, most important first: count tags (1girl, 2boys), $keywords, actions, poses, expressions, every garment with its colour and state, props that are in the shot, setting, lighting, camera. No sentences.',
    natural: 'Write ONE vivid natural-language paragraph of 60-110 words: subject(s) and action first (clothing with colours and state, expression, pose), then setting and the props in the shot, lighting, camera. No tag lists, no headings.',
};

/**
 * Step 2 contract, appended to EVERY preset system (built-in, overridden or user-made) when a scene document is
 * given: the document must actually show up in each prompt - place, layout, clothing with colours + state,
 * expression, action, pose / position of every person. Without it models paraphrase the paragraph and drop the rest.
 */
const DOC_LENGTH = {
    tags: 'With a document the prompt is longer than usual: 30-60 tags, because place, props, clothing, expression and pose of every person are all spelled out.',
    natural: 'With a document the paragraph is longer than usual: 90-150 words, because place, props, clothing, expression and pose of every person are all spelled out.',
};
export const SCENE_DOC_RULES = `

SCENE DOCUMENT RULES (a SCENE DOCUMENT is given - these rules override anything above that conflicts):
- The document is the source of truth for this reply. The paragraph only picks the MOMENT and the CAMERA; where it happens, who is present, what they wear, how they feel and where they are positioned all come from the document. TRANSLATE the document into the prompt - never summarise the paragraph alone.
- EVERY prompt must contain, explicitly:
  (a) WHERE: indoors/outdoors and the place type from LOCATION, the furniture and props from LAYOUT that would be in the frame and where they stand (bed against the wall, lit lamp on the nightstand, rain on the window...), time of day and the lighting.
  (b) for EACH person present in that shot: their $keyword, then their clothing written out in words from that person's WEARING lines with colours and state (never just "clothes" or "dressed" - write e.g. "unbuttoned white linen shirt, black cotton shorts, barefoot"), their EXPRESSION and gaze, the action of that paragraph from DOING, and their POSE / POSITION relative to the furniture and to the other people (sitting on the left edge of the bed, kneeling at his feet, facing away from the viewer).
- Clothing always comes from the document in words. Do NOT replace it with a $keyword.outfit token. Other detail tokens ($keyword.back, .nsfw, .body...) are still written as tokens when that part is visible.
- Never write anything the document contradicts, and never drop the place, the lighting or the clothing because the paragraph does not repeat them.
- {{doc_length}}
EXAMPLE with a document (tags): [{"p": 3, "prompt": "1girl, 1boy, $mara sitting on the left edge of a bed with her back to the viewer, oversized white shirt unbuttoned and pushed off her right shoulder, black cotton shorts, barefoot, worried expression looking down at his wound, leaning forward sewing a cut on $tomas's side, $tomas lying on his back on the rumpled bed, grey tank top pulled up to his chest, dark jeans, eyes closed, gritted teeth, dim bedroom, nightstand with a lit brass lamp on the right, window with closed curtains behind the bed, clothes on the wooden floor by the door, warm low light, medium shot from the foot of the bed"}]`;

export const BUILTIN_PRESETS = [
    {
        id: 'scene_default', builtin: true, name: 'Scene (default)',
        system: `You are an illustration director for a roleplay chat. You read the latest reply split into numbered paragraphs plus short context, and choose which paragraphs deserve an image and write the image prompt for each.
Keep continuity with earlier context (location, time of day, clothing). Focus on what is visually happening in that paragraph.` + OUTPUT_RULES,
    },
    {
        id: 'portrait_focus', builtin: true, name: 'Portrait / expression focus',
        system: `You are an illustration director. Prefer close-up or medium shots of the speaking character's face and expression in the chosen paragraph. Emphasise emotion, gaze, lighting on the face.` + OUTPUT_RULES,
    },
    {
        id: 'action_wide', builtin: true, name: 'Action / wide shot',
        system: `You are an illustration director. Prefer full-body or wide shots that show the interaction between characters and the environment. Emphasise poses, positioning of each character, and the setting.` + OUTPUT_RULES,
    },
    {
        id: 'nsfw_explicit', builtin: true, name: 'NSFW explicit',
        system: `You are an illustration director for adult roleplay. Choose the most explicit visual moments. Describe bodies, positions, contact, fluids, expressions frankly using standard danbooru vocabulary. Do not censor.` + OUTPUT_RULES,
    },
    {
        id: 'sfw_safe', builtin: true, name: 'SFW only',
        system: `You are an illustration director. Choose only safe-for-work moments. If the paragraph is explicit, depict a tasteful, clothed, non-sexual framing instead.` + OUTPUT_RULES,
    },
    {
        id: 'background_only', builtin: true, name: 'Background / environment',
        system: `You are an illustration director. Produce prompts of the environment only: no people ("no humans"). Describe architecture, nature, weather, time of day, lighting, atmosphere.` + OUTPUT_RULES,
    },
    {
        id: 'pov_user', builtin: true, name: 'POV of the user',
        system: `You are an illustration director. Every image is from the user's first-person point of view (pov). The user's own body appears only as hands/arms if relevant. The other characters face the viewer.` + OUTPUT_RULES,
    },
    {
        id: 'comic_panel', builtin: true, name: 'Comic panel per beat',
        system: `You are an illustration director laying out a comic. Treat each chosen paragraph as one panel: strong composition, clear silhouette, expressive faces, dynamic angle. Vary the shot type between panels.` + OUTPUT_RULES,
    },
];

export function createPreset(partial = {}) {
    return {
        id: partial.id || uuid(),
        builtin: false,
        name: partial.name || 'New preset',
        system: partial.system || BUILTIN_PRESETS[0].system,
    };
}

/** Built-ins with the user's overrides applied (`overridden: true` when a saved text replaces the default), then user presets. */
export function allPresets(settings) {
    const ov = settings.data.presetOverrides ?? {};
    const builtins = BUILTIN_PRESETS.map(p => typeof ov[p.id] === 'string' ? { ...p, system: ov[p.id], overridden: true } : p);
    return [...builtins, ...(settings.data.presets ?? [])];
}

/** Save `system` over a preset in place: built-in -> override entry, user preset -> its own record. */
export function overwritePreset(settings, id, system) {
    if (BUILTIN_PRESETS.some(p => p.id === id)) {
        settings.data.presetOverrides ??= {};
        const def = BUILTIN_PRESETS.find(p => p.id === id).system;
        if (system === def) delete settings.data.presetOverrides[id]; else settings.data.presetOverrides[id] = system;
        return true;
    }
    const own = (settings.data.presets ?? []).find(p => p.id === id);
    if (!own) return false;
    own.system = system;
    return true;
}

/** Drop the override of a built-in preset (back to the shipped text). */
export function resetPreset(settings, id) {
    if (settings.data.presetOverrides) delete settings.data.presetOverrides[id];
}

export function findPreset(settings, id) {
    return allPresets(settings).find(p => p.id === id) ?? BUILTIN_PRESETS[0];
}

/**
 * Step 2 messages: scene document (+ paragraphs) -> N image prompts.
 * @param {object} preset
 * @param {{ paragraphs: {index:number,text:string}[], count:number, roster:string, context?:string, dialect:string, sceneDoc?:string, fixed?:boolean }} a
 *   sceneDoc - the scene document written in step 1 (authoritative). Earlier context is omitted when it is given.
 *   fixed    - the listed paragraphs are exactly the ones to illustrate (regenerate: keep every image slot)
 */
export function renderPlannerPrompt(preset, a) {
    const doc = String(a.sceneDoc ?? '').trim();
    const dialect = DIALECT_RULES[a.dialect] ? a.dialect : 'tags';
    // The document contract is appended to the preset text so overridden / user presets get it too.
    const system = (preset.system + (doc ? SCENE_DOC_RULES : ''))
        .replaceAll('{{count}}', String(a.count))
        .replaceAll('{{dialect_rule}}', DIALECT_RULES[dialect])
        .replaceAll('{{doc_length}}', DOC_LENGTH[dialect]);
    const paraBlock = a.paragraphs.map(p => `[${p.index}] ${p.text}`).join('\n\n');
    const what = doc
        ? 'translate the SCENE DOCUMENT into the prompt of each (place + props from LAYOUT, lighting, and for every person present: clothing in words with colours and state, expression, the action of that paragraph, pose / position)'
        : 'describe the SCENE of each (actions, poses, setting, lighting, camera)';
    const ask = a.fixed
        ? `Write one prompt for EACH of the ${a.count} paragraph(s) listed (use every listed "p" exactly once), ${what}, and reply with the JSON array only.`
        : `Choose ${a.count} paragraph(s), ${what}, and reply with the JSON array only.`;
    const user = [
        a.roster ? `ROSTER (keyword -> who they are; looks are added automatically, do not repeat them):\n${a.roster}` : 'ROSTER: (none)',
        doc ? `SCENE DOCUMENT (authoritative for this reply - translate it into the prompts):\n${doc}` : '',
        !doc && a.context ? `EARLIER CONTEXT:\n${a.context}` : '',
        `LATEST REPLY, NUMBERED PARAGRAPHS:\n${paraBlock}`,
        ask,
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

/**
 * Pull the first JSON array out of an LLM reply. Tolerates prose around it, a ```json fence,
 * and unescaped double quotes INSIDE string values (e.g. a "no, no" plea).
 * Strict parse of [first '[' .. last ']'] first; if that fails, quotes that are not followed by a
 * JSON structural character are re-escaped and parsing is retried.
 * @returns {any[]|null}
 */
export function extractJsonArray(text) {
    const s = String(text ?? '');
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    const tryParse = str => { try { const v = JSON.parse(str); return Array.isArray(v) ? v : null; } catch { return null; } };
    const slice = s.slice(start, end + 1);
    return tryParse(slice) ?? tryParse(repairQuotes(slice)) ?? looseObjects(slice);
}

/**
 * Last resort for replies whose strings are closed with an ESCAPED quote (backslash + quote before the brace)
 * or that mix raw quotes: split on object boundaries and read every "key": number plus the "prompt" text up to
 * the LAST quote of the chunk, so inner / escaped quotes cannot break it.
 * @returns {object[]|null}
 */
function looseObjects(str) {
    const out = [];
    for (let raw of str.split(/\}\s*,\s*\{/)) {
        raw = raw.replace(/^[\s[{]+/, '').replace(/[\s\]}]+$/, '');
        const obj = {};
        for (const m of raw.matchAll(/"([A-Za-z_]\w*)"\s*:\s*(-?\d+(?:\.\d+)?)/g)) obj[m[1]] = Number(m[2]);
        const t = raw.match(/"(prompt|text|scene)"\s*:\s*"([\s\S]*)$/);
        if (t) {
            let v = t[2];
            const q = v.lastIndexOf('"');
            if (q >= 0) v = v.slice(0, q);
            if (v.endsWith('\\')) v = v.slice(0, -1);
            obj[t[1]] = v.replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
        }
        if (Object.keys(obj).length) out.push(obj);
    }
    return out.length ? out : null;
}

/** Escape double quotes that sit inside string values: a quote closes a string only when the next non-space char is , : ] or }. */
function repairQuotes(str) {
    let out = '', inStr = false;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (!inStr) { if (ch === '"') inStr = true; out += ch; continue; }
        if (ch === '\\') { out += ch + (str[i + 1] ?? ''); i++; continue; }
        if (ch !== '"') { out += ch; continue; }
        if (/^\s*[,:\]}]/.test(str.slice(i + 1))) { inStr = false; out += ch; } else out += '\\"';
    }
    return out;
}

/** Parse planner reply into [{p, prompt}] restricted to valid paragraph numbers. */
export function parsePlan(text, validIndexes) {
    const s = String(text ?? '');
    const arr = extractJsonArray(s);
    if (!Array.isArray(arr)) return [];
    const valid = new Set(validIndexes);
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        const p = Number(item?.p);
        const prompt = String(item?.prompt ?? '').trim();
        if (!valid.has(p) || !prompt || seen.has(p)) continue;
        seen.add(p);
        out.push({ p, prompt });
    }
    return out.sort((x, y) => x.p - y.p);
}
