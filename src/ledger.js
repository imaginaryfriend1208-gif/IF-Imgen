// IF Imgen - chat token ledger: every ad-hoc token the scene planner defined in THIS chat.
//   $keyword.kw  - belongs to a character / persona (outfit, hairstyle, its pet, its car ...)
//   $world.kw    - belongs to the world of the story (a place, an NPC, a vehicle nobody owns)
// The ledger is DERIVED from the scene documents stored on the chat's messages (newest definition of a name wins),
// so it is always exactly the tokens of the open chat: a branch only carries the messages up to the branch point, so
// it only carries those tokens; what the branch defines later is its own. chat_metadata.ifimgen_tokens holds only the
// user's flags: `saved` (id -> text copied into an entry) and `hidden` (id -> true, removed from this chat's list).
// Uses: (1) handed to step 1 as CHAT TOKENS so the planner reuses names instead of redefining, (2) merged into the ad-hoc
// tokens of steps 2 / 3 so a token defined many replies ago still resolves, (3) the "Chat tokens" table / floater list.
import { parseDocTokens } from './scene.js';

export const LEDGER_KEY = 'ifimgen_tokens';
export const WORLD_KEY = 'world';

/** @typedef {{ key:string, facet:string, text:string, at:number, saved:boolean }} LedgerToken */

const meta = ctx => ctx.chatMetadata ?? ctx.chat_metadata ?? null;
export const tokenId = tk => `${tk.key}.${tk.facet}`;

/** Flags object of the open chat ({ saved:{}, hidden:{} }); migrates the 0.13.0 shape (a map of tokens) to flags. */
export function ledgerFlags(ctx) {
    const m = meta(ctx); if (!m) return { saved: {}, hidden: {} };
    let f = m[LEDGER_KEY];
    if (!f || typeof f !== 'object' || !f.saved || !f.hidden) {
        const saved = {};
        if (f && typeof f === 'object') for (const [id, tk] of Object.entries(f)) if (tk && typeof tk === 'object' && tk.saved && tk.text) saved[id] = tk.text;
        f = m[LEDGER_KEY] = { saved, hidden: {} };
    }
    return f;
}

// Per-message parse cache: a message's document text is re-parsed only when it changed.
const cache = new WeakMap();
function tokensOf(msg, docOf) {
    if (!msg || typeof msg !== 'object') return [];
    const doc = docOf(msg) || '';
    const c = cache.get(msg);
    if (c && c.doc === doc) return c.tokens;
    const tokens = doc ? parseDocTokens(doc) : [];
    cache.set(msg, { doc, tokens });
    return tokens;
}

/**
 * Tokens of the chat, newest definition first. Same name defined again later -> the later text wins and `at` is the
 * later message (the planner may redefine a thing that changed).
 * @param {object} ctx - ST context (chat + metadata)
 * @param {(msg:object)=>string} docOf - scene document text of a message ('' when none)
 * @param {{ upTo?:number, limit?:number, includeHidden?:boolean }} [o]
 *   upTo - only documents of messages <= upTo (a regenerate of an old message must not see the future)
 *   limit - newest N (0 / undefined = all); includeHidden - keep tokens the user removed from the list
 * @returns {LedgerToken[]}
 */
export function ledgerTokens(ctx, docOf, o = {}) {
    const chat = ctx.chat ?? [];
    const flags = ledgerFlags(ctx);
    const last = Math.min(chat.length - 1, o.upTo ?? Infinity);
    const byId = new Map();
    for (let i = 0; i <= last; i++) {
        for (const tk of tokensOf(chat[i], docOf)) {
            if (!tk.key || !tk.facet || !tk.text) continue;
            byId.set(tokenId(tk), { key: tk.key, facet: tk.facet, text: tk.text, at: i });   // later message overwrites
        }
    }
    let list = [...byId.values()];
    if (!o.includeHidden) list = list.filter(tk => !flags.hidden[tokenId(tk)]);
    for (const tk of list) tk.saved = flags.saved[tokenId(tk)] === tk.text;
    list.sort((a, b) => b.at - a.at);
    return o.limit > 0 ? list.slice(0, o.limit) : list;
}

/** Number of tokens the user hid in this chat. */
export function hiddenCount(ctx) { return Object.keys(ledgerFlags(ctx).hidden).length; }
export function hideLedgerToken(ctx, id) { ledgerFlags(ctx).hidden[id] = true; }
export function unhideAll(ctx) { ledgerFlags(ctx).hidden = {}; }
export function markLedgerSaved(ctx, id, text) { ledgerFlags(ctx).saved[id] = text; }

/** Prompt block for step 1 ('' when empty). */
export function ledgerBlock(tokens) {
    if (!tokens?.length) return '';
    return tokens.map(tk => `$${tk.key}.${tk.facet}: ${tk.text}`).join('\n');
}
