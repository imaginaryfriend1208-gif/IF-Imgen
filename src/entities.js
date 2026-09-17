// IF Imgen - unified entity model for characters / personas / styles. Pure module.
import { uuid, normalizeText, splitList, escapeRegex } from './util.js';
import { parseFacets, rosterLine } from './scene.js';
import { PROFILE_SHOTS } from './profile.js';

export const KINDS = ['characters', 'personas', 'styles'];
export const LORA_POSITIONS = ['front', 'after_style', 'end'];
/** Older profile images kept per entity (newest first). */
export const PROFILE_VERSIONS = 8;

/**
 * Profile (avatar) image state of a character / persona: framing + SFW preference, the shown image and older
 * versions. Stored on the entity so it survives Save / export / import.
 * @returns {{ shot:string, sfw:boolean, current:object|null, history:object[] }}
 */
export function normalizeProfile(p) {
    const src = p && typeof p === 'object' ? p : {};
    const rec = r => r && typeof r === 'object' && r.url ? {
        url: String(r.url), prompt: String(r.prompt ?? ''), negative: String(r.negative ?? ''), draft: String(r.draft ?? ''),
        shot: PROFILE_SHOTS.includes(r.shot) ? r.shot : 'portrait', sfw: r.sfw !== false,
        backend: String(r.backend ?? ''), model: String(r.model ?? ''), at: Number(r.at) || 0,
    } : null;
    return {
        shot: PROFILE_SHOTS.includes(src.shot) ? src.shot : 'portrait',
        sfw: src.sfw !== false,
        current: rec(src.current),
        history: (Array.isArray(src.history) ? src.history : []).map(rec).filter(Boolean).slice(0, PROFILE_VERSIONS),
    };
}

export function createEntity(kind, partial = {}) {
    const e = {
        id: partial.id || uuid(),
        kind,
        name: partial.name || '',
        keyword: normalizeKeyword(partial.keyword || partial.name || ''),
        aliases: splitList(partial.aliases).map(normalizeKeyword).filter(Boolean),
        tags: String(partial.tags ?? '').trim(),        // danbooru tags
        natural: String(partial.natural ?? '').trim(),
        lead: String(partial.lead ?? '').trim(),          // styles only: ONE short sentence placed at the head of prose prompts; the long natural text goes last  // natural-language description
        negative: String(partial.negative ?? '').trim(),
        facets: partial.kind === 'styles' || kind === 'styles' ? [] : parseFacets(partial.facets), // [{key:'back', text:'...'}] referenced as $keyword.back
        world: partial.kind === 'styles' || kind === 'styles' ? [] : parseFacets(partial.world),   // places, NPCs, recurring items: $keyword.apartment, $keyword.npc_william
        loras: splitList(partial.loras),               // ["<lora:x:0.8>", ...]
        loraPosition: LORA_POSITIONS.includes(partial.loraPosition) ? partial.loraPosition : 'front',
        // Binding = "auto-load this entity when that chat / card / persona is open".
        // Only identifiers are stored. Nothing is ever read FROM the card or persona.
        bind: {
            chats: splitList(partial.bind?.chats),           // ST chat ids (getCurrentChatId)
            characters: splitList(partial.bind?.characters), // ST card avatar filenames (identity only)
            personas: splitList(partial.bind?.personas),     // ST persona avatar filenames (identity only)
            always: Boolean(partial.bind?.always),
        },
        // Profile / avatar image (characters + personas only) - see src/profile.js.
        profile: kind === 'styles' ? null : normalizeProfile(partial.profile),
        updatedAt: Date.now(),
    };
    return e;
}

export function normalizeKeyword(k) {
    return normalizeText(k).replace(/^\$+/, '').replace(/[^a-z0-9_\- ]/g, '').replace(/\s+/g, '_');
}

export function upsertEntity(list, entity) {
    const i = list.findIndex(x => x.id === entity.id);
    entity.updatedAt = Date.now();
    if (i >= 0) list[i] = entity; else list.push(entity);
    return entity;
}

export function removeEntity(list, id) {
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) list.splice(i, 1);
}

/** All keys (keyword + aliases) of an entity, normalized, longest first. */
export function keysOf(e) {
    return [e.keyword, ...(e.aliases ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * Entities whose keyword/alias appears in text as a whole word ("$lyna", "lyna", "Lyna's").
 * Underscore keywords also match with spaces ("dark_elf" ~ "dark elf").
 */
export function matchByKeyword(list, text) {
    const norm = normalizeText(text);
    if (!norm) return [];
    const out = [];
    for (const e of list) {
        for (const k of keysOf(e)) {
            const pat = escapeRegex(k).replace(/_/g, '[ _]');
            const re = new RegExp(`(^|[^a-z0-9])\\$?${pat}(?=$|[^a-z0-9])`, 'i');
            if (re.test(norm)) { out.push(e); break; }
        }
    }
    return out;
}

export function isBound(e, { chatId, charAvatar, personaAvatar } = {}) {
    if (e.bind?.always) return true;
    if (chatId && e.bind?.chats?.includes(chatId)) return true;
    if (charAvatar && e.bind?.characters?.includes(charAvatar)) return true;
    if (personaAvatar && e.bind?.personas?.includes(personaAvatar)) return true;
    return false;
}

/**
 * Resolve which entities apply to one image prompt.
 * Characters/personas: mentioned by $keyword in the planner text. If the planner
 * named nobody at all, fall back to the entities bound to this chat (so a prompt
 * with no keywords still gets the current character). Bound entities that are NOT
 * mentioned are dropped when at least one keyword matched -- a two-person roster
 * must not be stamped onto a solo scene.
 * Style: always the default style (settings.defaultStyleId), or none.
 */
export function resolveEntities(settings, { text, chatId, charAvatar, personaAvatar }) {
    const d = settings.data;
    const byKeyChars = matchByKeyword(d.characters, text);
    const byKeyPersonas = matchByKeyword(d.personas, text);
    const anyKeyword = byKeyChars.length + byKeyPersonas.length > 0;
    const bound = list => list.filter(e => isBound(e, { chatId, charAvatar, personaAvatar }));
    const characters = anyKeyword ? byKeyChars : bound(d.characters);
    const personas = anyKeyword ? byKeyPersonas : bound(d.personas);
    // Styles have no keyword and no binding: the one marked default is applied to every image.
    const style = d.styles.find(e => e.id === settings.defaultStyleId) ?? null;
    return { characters, personas, style };
}

/** Roster text handed to the planner LLM (keyword, who they are, available $keyword.detail tokens). */
export function rosterText(settings, { chatId, charAvatar, personaAvatar }) {
    const ident = { chatId, charAvatar, personaAvatar };
    const lines = [];
    const add = (label, list) => { for (const e of list) lines.push(rosterLine(e, label)); };
    const d = settings.data;
    add('character', d.characters.filter(e => isBound(e, ident)));
    add('user persona', d.personas.filter(e => isBound(e, ident)));
    // Unbound ones are still listed by keyword so the LLM can mention them.
    add('character', d.characters.filter(e => !isBound(e, ident)));
    add('user persona', d.personas.filter(e => !isBound(e, ident)));
    return lines.join(String.fromCharCode(10));
}

// ---- import / export -------------------------------------------------------

export function exportEntities(kind, list) {
    return { app: 'IF_Imgen', kind, version: 1, items: list };
}

/** @returns {{ added:number, updated:number, errors:string[] }} */
export function importEntities(kind, list, payload, mode = 'merge') {
    const errors = [];
    const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : null;
    if (!items) return { added: 0, updated: 0, errors: ['Invalid file: expected { items: [] }'] };
    if (payload?.kind && payload.kind !== kind) errors.push(`File kind "${payload.kind}" differs from target "${kind}"; importing anyway.`);
    if (mode === 'replace') list.splice(0, list.length);
    let added = 0, updated = 0;
    for (const raw of items) {
        if (!raw || typeof raw !== 'object' || !raw.name) { errors.push('Skipped item without name'); continue; }
        const e = createEntity(kind, raw);
        const i = list.findIndex(x => x.id === e.id || (x.keyword && x.keyword === e.keyword));
        if (i >= 0) { e.id = list[i].id; list[i] = e; updated++; } else { list.push(e); added++; }
    }
    return { added, updated, errors };
}
