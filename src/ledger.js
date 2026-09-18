// IF Imgen - chat token ledger: every ad-hoc token the scene planner defined in THIS chat, kept in chat_metadata so it
// follows the chat file (branches / checkpoints copy it). Two kinds of key:
//   $keyword.kw  - belongs to a character / persona (outfit, hairstyle, its pet, its car ...)
//   $world.kw    - belongs to the world of the story (a place, an NPC, a vehicle nobody owns)
// The ledger is (1) handed to step 1 as CHAT TOKENS so the planner reuses names instead of redefining, (2) merged into
// the ad-hoc tokens of steps 2 / 3 so a token defined many replies ago still resolves, (3) the source of the
// "Chat tokens" table where the user saves tokens into an entry's Details / World for good.
import { parseDocTokens } from './scene.js';

export const LEDGER_KEY = 'ifimgen_tokens';
export const WORLD_KEY = 'world';

/** @typedef {{ key:string, facet:string, text:string, at:number, updatedAt:number, saved?:boolean }} LedgerToken */

const meta = ctx => ctx.chatMetadata ?? ctx.chat_metadata ?? null;
export const tokenId = tk => `${tk.key}.${tk.facet}`;

/** Live ledger map of the open chat ({} when the chat has no metadata object). */
export function readLedger(ctx) {
    const m = meta(ctx); if (!m) return {};
    if (!m[LEDGER_KEY] || typeof m[LEDGER_KEY] !== 'object') m[LEDGER_KEY] = {};
    return m[LEDGER_KEY];
}

/**
 * Merge tokens (parseDocTokens output) defined by the document of message `at`. Same name -> the text is updated
 * (the planner is allowed to redefine a changed thing) and `saved` is kept. Returns the number of new / changed tokens.
 */
export function mergeLedger(ctx, tokens, at) {
    const led = readLedger(ctx); let changed = 0;
    for (const tk of tokens ?? []) {
        if (!tk?.key || !tk?.facet || !tk?.text) continue;
        const id = tokenId(tk), cur = led[id];
        if (cur && cur.text === tk.text) { if (at > (cur.at ?? -1)) cur.at = at; continue; }
        led[id] = { key: tk.key, facet: tk.facet, text: tk.text, at, updatedAt: Date.now(), saved: cur?.saved && cur.text === tk.text ? true : false };
        changed++;
    }
    return changed;
}

/** Ledger as a list, newest definition first; `limit` > 0 keeps only the newest N (0 = all). */
export function ledgerTokens(ctx, limit = 0) {
    const list = Object.values(readLedger(ctx)).sort((a, b) => (b.at - a.at) || (b.updatedAt - a.updatedAt));
    return limit > 0 ? list.slice(0, limit) : list;
}

export function removeLedgerToken(ctx, id) { const led = readLedger(ctx); if (!(id in led)) return false; delete led[id]; return true; }
export function markLedgerSaved(ctx, id, saved = true) { const tk = readLedger(ctx)[id]; if (tk) tk.saved = saved; return Boolean(tk); }

/** Prompt block for step 1 ('' when empty). */
export function ledgerBlock(tokens) {
    if (!tokens?.length) return '';
    return tokens.map(tk => `$${tk.key}.${tk.facet}: ${tk.text}`).join('\n');
}

/**
 * First use in a chat that already has scene documents: rebuild the ledger from every stored document (oldest first
 * so the newest definition wins). Returns true when a bootstrap happened.
 * @param {(msg:object)=>string} docOf - scene document text of a message ('' when none)
 */
export function bootstrapLedger(ctx, docOf) {
    const m = meta(ctx); if (!m || m[LEDGER_KEY]) return false;
    m[LEDGER_KEY] = {};
    const chat = ctx.chat ?? [];
    for (let i = 0; i < chat.length; i++) { const doc = docOf(chat[i]); if (doc) mergeLedger(ctx, parseDocTokens(doc), i); }
    return true;
}
