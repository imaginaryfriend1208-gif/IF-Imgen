// IF Imgen - "Chat tokens" box (Generate tab): the ledger of every ad-hoc token the scene planner defined in the open
// chat. Tick tokens, pick a character / persona -> they are written into its Details ($kw.key) or World ($kw.key of
// that person, or $world.key when the token belongs to the world) and marked "saved" in the ledger.
import { createEntity, upsertEntity } from './entities.js';
import { escapeHtml } from './util.js';
import { t } from './i18n.js';
import { ICONS } from './icons.js';

const WORLD_GUESS = /^(npc|place|room|apartment|house|home|car|bike|pet|dog|cat|shop|bar|cafe|office|street|alley|city|town|park|beach|school|hotel)_?|_(place|room|alley|street|shop|bar|cafe|office|city|town)$/i;

export function ledgerBoxHtml({ boxTitle, btn }) {
    return `
        <div class="ifimgen-box">
            ${boxTitle('sparkles', t('box_ledger'), '<span class="ifimgen-chip" id="ifimgen_ledger_count"></span>')}
            <div class="ifimgen-note">${t('note_ledger')}</div>
            <div id="ifimgen_ledger_list" class="ifimgen-ledger"></div>
            <div class="ifimgen-row">
                <label>${t('lbl_ledger_target')}</label><select id="ifimgen_ledger_target" class="text_pole" style="max-width:16em"></select>
                ${btn({ id: 'ifimgen_ledger_save', cls: 'primary', icon: 'save', label: t('btn_ledger_save') })}
                ${btn({ id: 'ifimgen_ledger_refresh', icon: 'refresh', title: t('btn_ledger_refresh') })}
                <span id="ifimgen_ledger_status" class="ifimgen-status"></span>
            </div>
        </div>`;
}

/** Merge facets into a list: same key (and scope) -> replaced, else appended. */
export function mergeFacets(cur, extra) {
    const out = [...(cur ?? [])];
    for (const f of extra) {
        const j = out.findIndex(x => x.key === f.key && (x.scope === 'world') === (f.scope === 'world'));
        if (j >= 0) out[j] = f; else out.push(f);
    }
    return out;
}

/** Ledger tokens -> { facets, world } to add to an entity: $world.* -> World with scope 'world'; a person's token -> Details
 *  unless its key looks like a place / NPC / item (then World). */
export function tokensToFacets(tokens) {
    const add = { facets: [], world: [] };
    for (const tk of tokens) {
        if (tk.key === 'world') add.world.push({ key: tk.facet, text: tk.text, scope: 'world' });
        else if (WORLD_GUESS.test(tk.facet)) add.world.push({ key: tk.facet, text: tk.text });
        else add.facets.push({ key: tk.facet, text: tk.text });
    }
    return add;
}

export function mountLedger({ root, settings, save, pipeline, status, onEntitiesChanged }) {
    const $ = id => root.querySelector(`#${id}`);
    const list = $('ifimgen_ledger_list'), target = $('ifimgen_ledger_target');
    function render() {
        const toks = pipeline.ledger?.() ?? [];
        $('ifimgen_ledger_count').textContent = String(toks.length);
        const ents = [...settings.data.characters.map(e => ({ e, kind: 'characters' })), ...settings.data.personas.map(e => ({ e, kind: 'personas' }))];
        const keep = target.value;
        target.innerHTML = ents.map(({ e, kind }) => `<option value="${kind}:${escapeHtml(e.id)}">${escapeHtml(e.name)} ($${escapeHtml(e.keyword)})</option>`).join('');
        if (keep && [...target.options].some(o => o.value === keep)) target.value = keep;
        if (!toks.length) { list.innerHTML = `<div class="ifimgen-note">${t('st_ledger_empty')}</div>`; return; }
        list.innerHTML = toks.map(tk => {
            const id = `${tk.key}.${tk.facet}`;
            const chips = `${tk.key === 'world' ? `<span class="ifimgen-chip">${t('chip_world')}</span>` : ''}${tk.saved ? `<span class="ifimgen-chip active">${t('chip_saved')}</span>` : ''}`;
            return `<div class="ifimgen-token" data-id="${escapeHtml(id)}">
                <label class="checkbox_label ifimgen-token-head"><input type="checkbox" data-id="${escapeHtml(id)}"> <b>$${escapeHtml(id)}</b>${chips}<span class="ifimgen-token-at">#${tk.at}</span></label>
                <button class="menu_button ifimgen-btn ifimgen-token-remove" data-id="${escapeHtml(id)}" title="${escapeHtml(t('ttl_ledger_remove'))}">${ICONS.trash}</button>
                <div class="ifimgen-token-text">${escapeHtml(tk.text)}</div>
            </div>`;
        }).join('');
    }
    list.addEventListener('click', ev => {
        const b = ev.target.closest('.ifimgen-token-remove'); if (!b) return;
        pipeline.ledgerRemove?.(b.dataset.id); render();
    });
    $('ifimgen_ledger_refresh').addEventListener('click', render);
    $('ifimgen_ledger_save').addEventListener('click', () => {
        const ids = [...list.querySelectorAll('input[type=checkbox]:checked')].map(c => c.dataset.id);
        const [kind, id] = String(target.value).split(':');
        if (!ids.length || !kind || !id) return status(t('st_ledger_pick'), 'error');
        const ents = settings.data[kind]; const saved = ents?.find(e => e.id === id);
        if (!saved) return status(t('st_ledger_no_entries'), 'error');
        const picked = (pipeline.ledger?.() ?? []).filter(tk => ids.includes(`${tk.key}.${tk.facet}`));
        const add = tokensToFacets(picked);
        const next = createEntity(kind, { ...saved, facets: mergeFacets(saved.facets, add.facets), world: mergeFacets(saved.world, add.world) });
        upsertEntity(ents, next); save();
        for (const tk of picked) pipeline.ledgerMarkSaved?.(`${tk.key}.${tk.facet}`);
        onEntitiesChanged?.(); render();
        status(t('st_ledger_saved', { n: picked.length, name: next.name }), 'ok');
    });
    render();
    return { refresh: render };
}
