// IF Imgen - planner prompt presets (builtin + user). Pure module.
import { uuid } from './util.js';

const OUTPUT_RULES = `

WHAT YOU WRITE: an image prompt is a description of the SCENE in that paragraph -- who is present, what each person is doing, pose, expression, clothing state, where they are, lighting, camera angle/shot type. It is NOT a character sheet.

CAST: the ROSTER lists known people as $keyword with a short description so you can recognise them in the text. Their looks are attached automatically later, so NEVER re-describe their fixed appearance (hair, eyes, body, face, height). Mention each person present ONLY as their $keyword once, then describe what they are doing. If a paragraph has two people, mention both keywords and describe both. If a paragraph has no roster person, describe the scene without keywords.

DETAILS: a roster entry may list detail tokens such as $yenka.back, $yenka.outfit, $yenka.nsfw, $yenka.body. Each holds a stored description you cannot see. When that part of the person is visible or matters for the shot, put the TOKEN in the prompt exactly as listed (e.g. "...walking away in the rain, wet $yenka.outfit clinging to her skin, showing $yenka.back"). Never guess or write the content of a detail yourself; never reference a token that is not listed.

OUTPUT FORMAT (strict): reply with ONLY a JSON array, no prose, no markdown fence:
[{"p": <paragraph number>, "prompt": "<image prompt>"}]
- "p" must be one of the paragraph numbers listed. Pick the most visual moments.
- Produce exactly {{count}} objects unless fewer paragraphs are usable.
- {{dialect_rule}}

EXAMPLE (roster has $mara with details $mara.outfit, $mara.back; and $tomas): [{"p": 3, "prompt": "$mara sits on the edge of a bed with her back to the viewer, $mara.outfit pushed off one shoulder revealing $mara.back, leaning forward and sewing a wound on $tomas's side with steady hands; $tomas lies back with eyes closed; dim bedroom, single lamp on a nightstand, warm low light, medium shot from the foot of the bed"}]`;

const DIALECT_RULES = {
    tags: 'Write comma-separated danbooru-style tags (lowercase, spaces not underscores), 15-35 tags, most important first: count tags (1girl, 2boys), $keywords, actions, poses, expressions, clothing state, setting, lighting, camera. No sentences.',
    natural: 'Write ONE vivid natural-language paragraph of 40-80 words: subject(s) and action first, then setting, lighting, camera. No tag lists, no headings.',
};

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
 * @param {object} preset
 * @param {{ paragraphs: {index:number,text:string}[], count:number, roster:string, context:string, dialect:string }} a
 */
export function renderPlannerPrompt(preset, a) {
    const system = preset.system
        .replaceAll('{{count}}', String(a.count))
        .replaceAll('{{dialect_rule}}', DIALECT_RULES[a.dialect] ?? DIALECT_RULES.tags);
    const paraBlock = a.paragraphs.map(p => `[${p.index}] ${p.text}`).join('\n\n');
    const user = [
        a.roster ? `ROSTER (keyword -> who they are; looks are added automatically, do not repeat them):\n${a.roster}` : 'ROSTER: (none)',
        a.context ? `EARLIER CONTEXT:\n${a.context}` : '',
        `LATEST REPLY, NUMBERED PARAGRAPHS:\n${paraBlock}`,
        `Choose ${a.count} paragraph(s), describe the SCENE of each (actions, poses, setting, lighting, camera), and reply with the JSON array only.`,
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

/** Parse planner reply into [{p, prompt}] restricted to valid paragraph numbers. */
export function parsePlan(text, validIndexes) {
    const s = String(text ?? '');
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    let arr;
    try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
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
