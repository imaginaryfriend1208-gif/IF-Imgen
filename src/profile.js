// IF Imgen - profile / avatar image of ONE entity (character or persona). Pure module.
//
// Unlike chat images there is no scene: the picture is a portrait of the person alone, written from what the user
// stored on the entry (Tags, Natural description, Details) plus the default style. ONE LLM call turns that data
// into a portrait prompt (buildProfilePrompt -> parseProfilePrompt); profileDraft() is the no-LLM fallback / preview.
// The compiler then adds quality prefix, style fragment, negatives and LoRAs exactly as for a chat image.
import { parseRefined } from './scene.js';

/** Framing choices offered in the entity panel (stored on entity.profile.shot). */
export const PROFILE_SHOTS = ['portrait', 'bust', 'full'];

/** Detail keys that are never handed to the prompt writer while SFW is on. */
const NSFW_KEYS = new Set(['nsfw', 'nude', 'naked', 'lewd']);
/** Detail keys that only make sense when the framing shows the body / the back. */
const BODY_KEYS = new Set(['back', 'body', 'legs', 'feet', 'tail']);

export const DEFAULT_PROFILE_SYSTEM = `You write ONE image prompt for the PROFILE PICTURE (avatar) of a roleplay character. You receive the person's BASE LOOK (their fixed appearance as written by the user), their stored DETAILS (outfit, face, body, marks...), an optional STYLE and the requested FRAMING. The picture shows this person ALONE, clearly recognisable, as a character portrait - no story moment, no other people.
Rules:
- Use every visual fact of the BASE LOOK and of the DETAILS that would be visible in the chosen framing: face and hair always; the outfit when the shot shows the body; back / body marks only when the framing shows them. Never invent hair colour, eye colour, age, body type or clothing that the data does not give; when something is missing, leave it out rather than guess.
- Exactly one person, solo. No other people, no text, no speech bubbles, no split panels, no watermark.
- Pick an expression and a pose that fit the personality the description suggests (a confident smirk, a gentle smile, a cold stare...), looking at the viewer or slightly past the camera.
- Background: simple and readable - a plain gradient, soft bokeh or a place that fits the character - never busy, the person stays the subject.
- Lighting: flattering portrait lighting (soft key light, gentle rim light), sharp focus on the face.
- {{framing_rule}}
- {{dialect_rule}}
- Do not repeat the same fact twice. No preamble, no explanation, no markdown fence. Never use double quotes inside the prompt.
OUTPUT FORMAT (strict): reply with ONLY this JSON object:
{"prompt": "<the prompt>"}`;

export const PROFILE_FRAMING_RULES = {
    portrait: 'FRAMING: head-and-shoulders portrait - the face fills the frame, hair and the collar / neckline of the outfit are visible, nothing below the chest.',
    bust: 'FRAMING: upper body from the waist up - face, hair and the top half of the outfit are clearly visible, hands may be in frame.',
    full: 'FRAMING: full body, standing, the whole outfit including footwear visible, feet inside the frame, the person fills most of the height.',
};

export const PROFILE_DIALECT_RULES = {
    tags: 'Write comma-separated danbooru-style tags (lowercase, spaces not underscores), 25-45 tags, most important first: count tag (1girl / 1boy / 1other) and solo, the framing tag (portrait / upper body / full body), looking at viewer, then hair, eyes, face and body from the base look, every visible garment with its colour, the expression, the pose, the background, the lighting. No sentences.',
    natural: 'Write ONE natural-language paragraph of 60-110 words for a model that reads sentences (Flux / Krea): the framing in one sentence (head-and-shoulders / upper-body / full-body portrait, at eye level, looking at the viewer), then the person with their name first (face, hair, eyes, body, then the visible clothing top to bottom with colours), then expression and pose, then a plain background and ONE light sentence (source, direction, quality, tone). If the base look is given as tags, rewrite it into sentences (1girl -> a young woman; drop quality words and weights). No tag lists, no headings, no brackets, no negatives.',
};

const shotOf = shot => PROFILE_SHOTS.includes(shot) ? shot : 'portrait';

/** Details handed to the prompt writer for a given framing / SFW switch. */
export function profileFacets(entity, { shot = 'portrait', sfw = true } = {}) {
    const s = shotOf(shot);
    return (entity?.facets ?? []).filter(f => {
        if (sfw && NSFW_KEYS.has(f.key)) return false;
        if (s === 'portrait' && BODY_KEYS.has(f.key)) return false;
        return true;
    });
}

/**
 * Messages for the profile prompt writer (one call per profile image).
 * @param {{ system?:string, dialect?:string, entity:object, label?:string, style?:object|null, shot?:string, sfw?:boolean }} a
 *   label - 'character' | 'user persona' (what the entry is, for the LLM)
 * @returns {{ system:string, user:string }}
 */
export function buildProfilePrompt(a) {
    const e = a.entity ?? {};
    const shot = shotOf(a.shot);
    const sfw = a.sfw !== false;
    const dialect = PROFILE_DIALECT_RULES[a.dialect] ? a.dialect : 'tags';
    const system = String(a.system || DEFAULT_PROFILE_SYSTEM)
        .replaceAll('{{framing_rule}}', PROFILE_FRAMING_RULES[shot])
        .replaceAll('{{dialect_rule}}', PROFILE_DIALECT_RULES[dialect]);
    const facets = profileFacets(e, { shot, sfw });
    const user = [
        `PERSON (${a.label || 'character'}): ${e.name || '(unnamed)'}${e.keyword ? ` — token $${e.keyword}` : ''}`,
        e.tags ? `BASE LOOK (tags): ${e.tags}` : '',
        e.natural ? `BASE LOOK (description): ${e.natural}` : '',
        !e.tags && !e.natural ? 'BASE LOOK: (none stored - describe only what the details give, keep the rest generic)' : '',
        facets.length ? `DETAILS:\n${facets.map(f => `  ${f.key}: ${f.text}`).join('\n')}` : 'DETAILS: (none)',
        a.style ? `STYLE: ${a.style.natural || a.style.tags || a.style.name}` : '',
        `FRAMING: ${shot}${sfw ? ' · SAFE FOR WORK: fully clothed, nothing explicit' : ''}`,
        'Write the profile image prompt now as the JSON object.',
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

/** LLM reply -> prompt text ('' when nothing usable). Accepts {"prompt"}, [{"prompt"}], fenced JSON or plain text. */
export function parseProfilePrompt(text) {
    return parseRefined(text, 1)[0] ?? '';
}

// Image models default to a head shot: bust / full must say what is IN frame (waist, feet) and the distance.
const SHOT_WORDS = {
    tags: { portrait: 'portrait, close-up, face focus', bust: 'upper body, cowboy shot, from the waist up, hands visible', full: 'full body, wide shot, standing, from head to toe, feet visible, from a distance' },
    natural: { portrait: 'close-up head-and-shoulders portrait', bust: 'medium shot from the waist up with the hands visible', full: 'full-body shot taken from a distance, standing from head to toe with the feet inside the frame' },
};

/**
 * Deterministic portrait draft from the stored data - used when the LLM fails and as the "no LLM" preview.
 * @param {{ entity:object, dialect?:string, shot?:string, sfw?:boolean }} a
 */
export function profileDraft(a) {
    const e = a.entity ?? {};
    const shot = shotOf(a.shot);
    const natural = a.dialect === 'natural';
    const facets = profileFacets(e, { shot, sfw: a.sfw !== false }).map(f => f.text);
    if (natural) {
        const base = e.natural || e.tags || e.name || 'a person';
        const parts = [`A ${SHOT_WORDS.natural[shot]} of ${e.name || 'the character'}: ${base}.`];
        if (facets.length) parts.push(`${facets.join('. ')}.`);
        parts.push('Alone, looking at the viewer with a calm expression, simple soft background, flattering portrait lighting, sharp focus on the face.');
        return parts.join(' ').replace(/\.\./g, '.').replace(/\s{2,}/g, ' ').trim();
    }
    const base = e.tags || e.natural || '';
    return ['solo', SHOT_WORDS.tags[shot], 'looking at viewer', base, ...facets, 'simple background', 'soft lighting', 'sharp focus']
        .map(s => String(s).trim()).filter(Boolean).join(', ');
}
