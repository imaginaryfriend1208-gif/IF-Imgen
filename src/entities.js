// IF Imgen - unified entity model for characters / personas / styles. Pure module.
import { uuid, normalizeText, splitList, escapeRegex } from './util.js';

export const KINDS = ['characters', 'personas', 'styles'];
export const LORA_POSITIONS = ['front', 'after_style', 'end'];

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
        loras: splitList(partial.loras),               // ["<lora:x:0.8>", ...]
        loraPosition: LORA_POSITIONS.includes(partial.loraPosition) ? partial.loraPosition : 'front',
        bind: {
            characters: splitList(partial.bind?.characters), // ST card avatar filenames
            personas: splitList(partial.bind?.personas),     // ST persona avatar filenames
            always: Boolean(partial.bind?.always),
        },
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

export function isBound(e, { charAvatar, personaAvatar } = {}) {
    if (e.bind?.always) return true;
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
 * Style: bound style > keyword > defaultStyleId > none.
 */
export function resolveEntities(settings, { text, charAvatar, personaAvatar }) {
    const d = settings.data;
    const byKeyChars = matchByKeyword(d.characters, text);
    const byKeyPersonas = matchByKeyword(d.personas, text);
    const anyKeyword = byKeyChars.length + byKeyPersonas.length > 0;
    const bound = list => list.filter(e => isBound(e, { charAvatar, personaAvatar }));
    const characters = anyKeyword ? byKeyChars : bound(d.characters);
    const personas = anyKeyword ? byKeyPersonas : bound(d.personas);
    const style = d.styles.find(e => isBound(e, { charAvatar, personaAvatar }))
        ?? matchByKeyword(d.styles, text)[0]
        ?? d.styles.find(e => e.id === settings.defaultStyleId)
        ?? null;
    return { characters, personas, style };
}

/** Roster text handed to the planner LLM. */
export function rosterText(settings, { charAvatar, personaAvatar }) {
    const lines = [];
    const add = (label, list) => {
        for (const e of list) {
            const desc = e.natural || e.tags || '';
            lines.push(`$${e.keyword} — ${label}: ${e.name}${desc ? ` — ${desc.slice(0, 160)}` : ''}`);
        }
    };
    const d = settings.data;
    add('character', d.characters.filter(e => isBound(e, { charAvatar, personaAvatar })));
    add('user persona', d.personas.filter(e => isBound(e, { charAvatar, personaAvatar })));
    // Unbound ones are still listed by keyword so the LLM can mention them.
    add('character', d.characters.filter(e => !isBound(e, { charAvatar, personaAvatar })));
    add('user persona', d.personas.filter(e => !isBound(e, { charAvatar, personaAvatar })));
    return lines.join('\n');
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
