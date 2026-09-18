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
        natural: String(partial.natural ?? '').trim(),  // natural-language description
        negative: String(partial.negative ?? '').trim(),
        facets: partial.kind === 'styles' || kind === 'styles' ? [] : parseFacets(partial.facets), // [{key:'back', text:'...'}] referenced as $keyword.back
        // World = places, side characters (NPCs) and recurring items of this person's story ($keyword.apartment,
        // $keyword.npc_william). Same token syntax as Details, kept apart so the look stays short.
        world: partial.kind === 'styles' || kind === 'styles' ? [] : parseFacets(partial.world),
        loras: splitList(partial.loras),               // ["<lora:x:0.8>", ...]
        loraPosition: LORA_POSITIONS.includes(partial.loraPosition) ? partial.loraPosition : 'front',
        // Binding. `characters` / `personas` hold at most ONE avatar: a profile is one version of one card (a card may own
        // several profiles - the active one is chosen in settings.activeProfiles). `chats` = guest appearances (root
        // chat names, so branches count). `always` only advertises the token to the LLM, it never auto-loads.
        // Only identifiers are stored. Nothing is ever read FROM the card or persona.
        bind: {
            chats: splitList(partial.bind?.chats),                        // ROOT chat names (chat_metadata.main_chat or the file name)
            characters: splitList(partial.bind?.characters).slice(0, 1),  // card avatar filename
            personas: splitList(partial.bind?.personas).slice(0, 1),      // persona avatar filename
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

/**
 * Chat identity used for binding. `chatId` is the ROOT chat name (a branch / checkpoint keeps its parent's name), so a
 * binding made in the parent chat follows every branch. `activeProfiles` maps card / persona avatar -> the entity id
 * chosen as the active version of that card (settings.activeProfiles).
 * @typedef {{ chatId?:string, charAvatar?:string, personaAvatar?:string, activeProfiles?:Record<string,string> }} Ident
 */

/** The profile bound to `avatar` that is active: the one picked in activeProfiles, else the only / first bound one. */
export function activeProfileFor(list, avatar, activeProfiles = {}) {
    if (!avatar) return null;
    const owned = (list ?? []).filter(e => e.bind?.characters?.includes(avatar) || e.bind?.personas?.includes(avatar));
    if (!owned.length) return null;
    const picked = activeProfiles?.[avatar];
    return owned.find(e => e.id === picked) ?? owned[0];
}

/** Official: the active profile of the open card / persona. Guest: bound to this (root) chat. `always` does NOT count. */
export function isActive(e, list, { chatId, charAvatar, personaAvatar, activeProfiles } = {}) {
    if (chatId && e.bind?.chats?.includes(chatId)) return true;
    if (charAvatar && e.bind?.characters?.includes(charAvatar)) return activeProfileFor(list, charAvatar, activeProfiles)?.id === e.id;
    if (personaAvatar && e.bind?.personas?.includes(personaAvatar)) return activeProfileFor(list, personaAvatar, activeProfiles)?.id === e.id;
    return false;
}

/**
 * Listed for the LLM: active for this chat, or `always` (token advertised). Profiles of the open card that are NOT the
 * active version are hidden even when marked always, so two versions of one person never both reach the roster.
 * `list` = all entities of that kind (needed to know which version is active); defaults to [e] for legacy callers.
 */
export function isBound(e, ident = {}, list = null) {
    const all = list ?? [e];
    if (isActive(e, all, ident)) return true;
    if (!e.bind?.always) return false;
    const owner = e.bind?.characters?.[0] || e.bind?.personas?.[0] || '';
    const ownerOpen = Boolean(owner) && (owner === ident.charAvatar || owner === ident.personaAvatar);
    return !ownerOpen; // always-on, but an inactive version of the open card stays out
}

/** Why an entity is in play for this chat: 'official' (active version of the open card / persona), 'guest' (bound to this chat), 'always', or ''. */
export function bindReason(e, list, ident = {}) {
    if (ident.chatId && e.bind?.chats?.includes(ident.chatId)) return 'guest';
    if (isActive(e, list, ident)) return 'official';
    return isBound(e, ident, list) ? 'always' : '';
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
    const ident = { chatId, charAvatar, personaAvatar, activeProfiles: settings.activeProfiles ?? {} };
    // Only entities in play for this chat can be matched by keyword: the active version of the open card / persona,
    // guests bound to this chat, and always-on orphans. An inactive version of the open card is never picked, even by name.
    const inPlay = list => list.filter(e => isBound(e, ident, list));
    const byKeyChars = matchByKeyword(inPlay(d.characters), text);
    const byKeyPersonas = matchByKeyword(inPlay(d.personas), text);
    const anyKeyword = byKeyChars.length + byKeyPersonas.length > 0;
    // No keyword at all -> the official / guest entities only. `always` never auto-loads (an always-on orphan used to
    // land in every chat that mentioned nobody - that was the Rosario-in-Sebastian's-chat bug).
    const active = list => list.filter(e => isActive(e, list, ident));
    const characters = anyKeyword ? byKeyChars : active(d.characters);
    const personas = anyKeyword ? byKeyPersonas : active(d.personas);
    // Styles have no keyword and no binding: the one marked default is applied to every image.
    const style = d.styles.find(e => e.id === settings.defaultStyleId) ?? null;
    return { characters, personas, style };
}

/** Roster text handed to the step-2 LLM: keyword, base look, every Details / World entry as "token: text" (see rosterLine). */
export function rosterText(settings, { chatId, charAvatar, personaAvatar }, dialect = 'tags') {
    const ident = { chatId, charAvatar, personaAvatar, activeProfiles: settings.activeProfiles ?? {} };
    const lines = [];
    const add = (label, list) => { for (const e of list) lines.push(rosterLine(e, label, dialect)); };
    const d = settings.data;
    // Official / guest first, then always-on orphans. Nothing else: an unbound, not-always profile (or an inactive
    // version of the open card) must not be offered to the LLM at all.
    add('character', d.characters.filter(e => isActive(e, d.characters, ident)));
    add('user persona', d.personas.filter(e => isActive(e, d.personas, ident)));
    add('character', d.characters.filter(e => !isActive(e, d.characters, ident) && isBound(e, ident, d.characters)));
    add('user persona', d.personas.filter(e => !isActive(e, d.personas, ident) && isBound(e, ident, d.personas)));
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
