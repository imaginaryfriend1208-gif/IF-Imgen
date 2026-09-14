// IF Imgen - planner prompt presets (builtin + user). Pure module.
import { uuid } from './util.js';

const OUTPUT_RULES = `
OUTPUT FORMAT (strict): reply with ONLY a JSON array, no prose, no markdown fence:
[{"p": <paragraph number>, "prompt": "<image prompt>"}]
- "p" must be one of the paragraph numbers listed. Pick the most visual moments.
- Produce exactly {{count}} objects unless fewer paragraphs are usable.
- Never include character appearance tags that are already provided by the roster; describe pose, action, expression, clothing state, camera, setting, lighting.
- Refer to roster entities by their exact KEYWORD (e.g. $lyna) at the start of the prompt so the compiler can attach their tags.
- {{dialect_rule}}`;

const DIALECT_RULES = {
    tags: 'Write comma-separated danbooru-style tags (lowercase, spaces not underscores), 15-35 tags, most important first. No sentences.',
    natural: 'Write one vivid natural-language paragraph of 40-70 words, subject first, then action, setting, lighting, camera. No tag lists.',
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

export function allPresets(settings) {
    return [...BUILTIN_PRESETS, ...(settings.data.presets ?? [])];
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
        a.roster ? `ROSTER (keyword -> who they are):\n${a.roster}` : 'ROSTER: (none)',
        a.context ? `EARLIER CONTEXT:\n${a.context}` : '',
        `LATEST REPLY, NUMBERED PARAGRAPHS:\n${paraBlock}`,
        `Choose ${a.count} paragraph(s) and reply with the JSON array only.`,
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
