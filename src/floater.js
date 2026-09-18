// IF Imgen - floating quick-action button + in-chat progress markers.
//
//  * One draggable round button (bottom-right by default, position remembered in settings.generate.floaterPos).
//    Click -> popup with the quick actions; REGEN of the last reply is the first / biggest one.
//    While a job runs the button shows a spinner ring + job count and its tooltip follows the pipeline status.
//  * Every message that currently has an image job gets a small "generating…" strip above its text
//    (.ifimgen-genbar) so it is obvious WHICH reply is being illustrated, plus a sticky pill above the
//    send form that mirrors the same status when that message is scrolled out of view.
//
// Loaded by index.js through a dynamic import inside try/catch AFTER the settings drawer is mounted:
// whatever fails in here must never take the rest of the extension down.
import { ICONS } from './icons.js';
import { t } from './i18n.js';
import { escapeHtml } from './util.js';
import { createEntity, upsertEntity, removeEntity, LORA_POSITIONS } from './entities.js';

const BTN = 40; // button diameter (px) - keep in sync with .ifimgen-fl-btn

/**
 * @param {{ settings:object, save:Function, pipeline:object, getContext:Function,
 *           openSettings:Function, openGallery:Function, onCollapseToggle:Function, onStylesChange?:Function }} deps
 */
export function mountFloater({ settings, save, pipeline, getContext, openSettings, openGallery, onCollapseToggle, onStylesChange }) {
    const g = settings.generate;
    let root = null, pop = null, pill = null, stopJobs = null;
    let lastState = { running: 0, ids: [], status: '' };
    let editing = null; // null = action list; { id: string|null } = style editor (null id = new style)

    const lastCharMessage = () => {
        const ctx = getContext();
        let id = ctx.chat.length - 1;
        while (id >= 0 && (ctx.chat[id].is_user || ctx.chat[id].is_system)) id--;
        return id;
    };
    const toast = (kind, msg) => { try { toastr[kind](msg, 'IF Imgen'); } catch { /* no toastr */ } };
    const statusText = st => `${t('job_running', { n: st.running })}${st.status ? ` — ${st.status}` : ''}`;

    // ------------------------------------------------------------------ actions
    /** Regenerate = step 2 again from the stored scene document; newScene = step 1 again first ("regen scene"). */
    async function regenLast(newScene = false) {
        const id = lastCharMessage();
        if (id < 0) return toast('warning', t('st_no_char_msg'));
        closePop();
        try {
            const r = await pipeline.regenerateAll(id, { newScene });
            if (r?.none) return toast('info', t('st_no_images'));
        } catch (e) { toast('error', e.message); }
    }
    async function genLast() {
        const id = lastCharMessage();
        if (id < 0) return toast('warning', t('st_no_char_msg'));
        closePop();
        try { const r = await pipeline.run(id, { force: true }); if (r?.skipped) toast('info', r.skipped); }
        catch (e) { toast('error', e.message); }
    }

    // ------------------------------------------------------------------ styles (settings.data.styles + settings.defaultStyleId)
    const styles = () => settings.data?.styles ?? [];
    const stylesChanged = () => { save(); try { onStylesChange?.(); } catch { /* drawer may be re-mounting */ } };
    function styleRow() {
        const list = styles();
        const opts = list.length
            ? list.map(s => `<option value="${escapeHtml(s.id)}"${s.id === settings.defaultStyleId ? ' selected' : ''}>${escapeHtml(s.name || '(unnamed)')}</option>`).join('')
            : `<option value="">${t('fl_style_none')}</option>`;
        return `
            <div class="ifimgen-fl-style">
                <span class="ifimgen-fl-style-lbl">${ICONS.palette}${t('fl_style')}</span>
                <select class="ifimgen-fl-style-sel text_pole" data-style-select>${opts}</select>
                <button type="button" class="ifimgen-fl-mini" data-act="style-edit" title="${t('fl_style_edit_title')}"${list.length ? '' : ' disabled'}>${ICONS.settings}<span>${t('fl_style_edit')}</span></button>
                <button type="button" class="ifimgen-fl-mini" data-act="style-new" title="${t('fl_style_new')}">${ICONS.plus}</button>
            </div>`;
    }
    const field = (cls, label, control) => `<label class="ifimgen-fl-field"><span>${label}</span>${control}</label>`;
    function renderEditor() {
        const cur = editing.id ? styles().find(s => s.id === editing.id) : null;
        const e = cur ?? createEntity('styles');
        const isDef = Boolean(cur) && cur.id === settings.defaultStyleId;
        root.classList.add('editing');
        pop.innerHTML = `
            <div class="ifimgen-fl-status ifimgen-fl-edit-head">
                <button type="button" class="ifimgen-fl-mini" data-act="style-back" title="${t('fl_style_back')}">${ICONS.x}</button>
                <b>${cur ? t('fl_style_head_edit') : t('fl_style_head_new')}</b>
            </div>
            <div class="ifimgen-fl-form">
                ${field('name', t('lbl_name'), `<input class="text_pole" data-f="name" type="text" value="${escapeHtml(e.name)}" placeholder="${escapeHtml(t('ph_style_name'))}">`)}
                ${field('tags', t('lbl_tags'), `<textarea class="text_pole" data-f="tags" rows="2" placeholder="anime style, flat color, clean lineart">${escapeHtml(e.tags)}</textarea>`)}
                ${field('natural', t('lbl_natural'), `<textarea class="text_pole" data-f="natural" rows="2">${escapeHtml(e.natural)}</textarea>`)}
                ${field('negative', t('lbl_negative'), `<input class="text_pole" data-f="negative" type="text" value="${escapeHtml(e.negative)}" placeholder="realistic, 3d, photo">`)}
                ${field('loras', t('lbl_loras'), `<textarea class="text_pole" data-f="loras" rows="2" placeholder="${escapeHtml(t('ph_loras'))}">${escapeHtml(e.loras.join('\n'))}</textarea>`)}
                ${field('lorapos', t('lbl_lorapos'), `<select class="text_pole" data-f="loraPosition">${LORA_POSITIONS.map(p => `<option value="${p}"${p === e.loraPosition ? ' selected' : ''}>${p}</option>`).join('')}</select>`)}
            </div>
            <div class="ifimgen-fl-status ifimgen-fl-edit-status" data-edit-status></div>
            <div class="ifimgen-fl-row ifimgen-fl-row-mini">
                <button type="button" class="ifimgen-fl-act primary" data-act="style-save">${ICONS.save}<span><b>${t('btn_save')}</b></span></button>
                <button type="button" class="ifimgen-fl-act${isDef ? ' active' : ''}" data-act="style-default"${cur ? '' : ' disabled'}>${ICONS.star}<span><b>${isDef ? t('btn_default_on') : t('btn_set_default')}</b></span></button>
                <button type="button" class="ifimgen-fl-act danger" data-act="style-delete"${cur ? '' : ' disabled'} title="${t('btn_delete')}">${ICONS.trash}<span><b>${t('btn_delete')}</b></span></button>
            </div>`;
        fitPop();
        setTimeout(() => pop.querySelector('[data-f="name"]')?.focus(), 0);
    }
    const editStatus = (text, cls = '') => { const n = pop?.querySelector('[data-edit-status]'); if (n) { n.textContent = text; n.className = `ifimgen-fl-status ifimgen-fl-edit-status ${cls}`; } };
    const readEditor = () => {
        const v = f => pop.querySelector(`[data-f="${f}"]`)?.value ?? '';
        const base = editing.id ? styles().find(s => s.id === editing.id) : null;
        return createEntity('styles', { id: base?.id, name: v('name'), keyword: base?.keyword || v('name'), tags: v('tags'), natural: v('natural'), negative: v('negative'), loras: v('loras'), loraPosition: v('loraPosition') });
    };
    function styleSave() {
        const e = readEditor();
        if (!e.name.trim()) return editStatus(t('st_name_required'), 'error');
        upsertEntity(styles(), e);
        if (!styles().some(x => x.id === settings.defaultStyleId)) settings.defaultStyleId = e.id;
        editing = { id: e.id };
        stylesChanged();
        renderEditor();
        editStatus(t('fl_style_saved', { name: e.name }), 'ok');
    }
    function styleDelete() {
        if (!editing.id) return;
        removeEntity(styles(), editing.id);
        if (settings.defaultStyleId === editing.id) settings.defaultStyleId = styles()[0]?.id ?? '';
        stylesChanged();
        editing = null;
        renderPop();
    }
    function styleDefault() {
        if (!editing.id) return;
        settings.defaultStyleId = editing.id;
        stylesChanged();
        renderEditor();
        editStatus(t('fl_style_now_default', { name: styles().find(s => s.id === editing.id)?.name ?? '' }), 'ok');
    }
    function onStyleSelect(e) {
        const sel = e.target.closest('[data-style-select]'); if (!sel || !sel.value) return;
        settings.defaultStyleId = sel.value;
        stylesChanged();
    }

    // ------------------------------------------------------------------ popup
    const item = (act, icon, label, sub = '', cls = '') =>
        `<button type="button" class="ifimgen-fl-act ${cls}" data-act="${act}">${ICONS[icon] ?? ''}<span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
    // Scene document of the latest character reply: view, edit, save (no LLM call) or save + regenerate the images from it.
    function renderScene() {
        root.classList.add('editing');
        const id = lastCharMessage();
        const doc = id >= 0 ? (pipeline.sceneDoc?.(id) ?? '') : '';
        pop.innerHTML = `
            <div class="ifimgen-fl-status ifimgen-fl-edit-head">
                <button type="button" class="ifimgen-fl-mini" data-act="style-back" title="${t('fl_style_back')}">${ICONS.x}</button>
                <b>${t('fl_scene')}</b>${id >= 0 ? ` <span class="ifimgen-chip">#${id}</span>` : ''}
            </div>
            ${doc ? `<textarea class="text_pole ifimgen-fl-scene" data-scene-text rows="14" spellcheck="false">${escapeHtml(doc)}</textarea>
            <div class="ifimgen-fl-hint">${t('fl_scene_hint')}</div>
            <div class="ifimgen-fl-status ifimgen-fl-edit-status" data-edit-status></div>
            <div class="ifimgen-fl-row ifimgen-fl-row-mini">
                <button type="button" class="ifimgen-fl-act" data-act="scene-save">${ICONS.save}<span><b>${t('btn_save')}</b></span></button>
                <button type="button" class="ifimgen-fl-act primary" data-act="scene-save-regen">${ICONS.refresh}<span><b>${t('fl_scene_save_regen')}</b></span></button>
            </div>` : `<div class="ifimgen-fl-hint">${t('fl_scene_none')}</div>`}`;
        fitPop();
    }
    async function sceneSave(regen) {
        const id = lastCharMessage();
        const ta = pop?.querySelector('[data-scene-text]');
        if (id < 0 || !ta) return;
        const ok = pipeline.setSceneDoc?.(id, ta.value);
        if (!ok) { const st = pop.querySelector('[data-edit-status]'); if (st) st.textContent = t('st_no_char_msg'); return; }
        if (!regen) { const st = pop.querySelector('[data-edit-status]'); if (st) st.textContent = t('fl_scene_saved'); return; }
        closePop();
        try { const r = await pipeline.regenerateAll(id, { newScene: false }); if (r?.none) toast('info', t('st_no_images')); }
        catch (e) { toast('error', e.message); }
    }

    // Chat tokens (read-only list of the ad-hoc tokens of THIS chat - saving / hiding lives on the Generate tab).
    const tokenCount = () => { try { return (pipeline.ledger?.() ?? []).length; } catch { return 0; } };
    function renderTokens() {
        root.classList.add('editing');
        const toks = pipeline.ledger?.() ?? [];
        pop.innerHTML = `
            <div class="ifimgen-fl-edit-head"><span>${ICONS.sparkles} ${t('fl_tokens')} <span class="ifimgen-chip">${toks.length}</span></span>
                <button type="button" class="ifimgen-fl-mini" data-act="tokens-back" title="${t('fl_tokens_back')}">${ICONS.x}</button></div>
            <div class="ifimgen-fl-tokens">${toks.length ? toks.map(tk => `<div class="ifimgen-fl-token${tk.key === 'world' ? ' world' : ''}"><b>$${escapeHtml(tk.key)}.${escapeHtml(tk.facet)}</b><span class="ifimgen-token-at">#${tk.at}${tk.saved ? ' · ' + t('chip_saved') : ''}</span><div>${escapeHtml(tk.text)}</div></div>`).join('') : `<div class="ifimgen-fl-hint">${t('fl_tokens_empty')}</div>`}</div>
            <div class="ifimgen-fl-row ifimgen-fl-row-mini">${item('settings', 'settings', t('fl_settings'))}</div>`;
        fitPop();
    }
    function renderPop() {
        if (!pop) return;
        if (editing === 'tokens') return renderTokens();
        if (editing === 'scene') return renderScene();
        if (editing) return renderEditor();
        root.classList.remove('editing');
        const busy = lastState.running > 0;
        pop.innerHTML = `
            <div class="ifimgen-fl-status">${busy ? statusText(lastState) : t('fl_title')}</div>
            <div class="ifimgen-fl-row">
                <button type="button" class="ifimgen-fl-act primary" data-act="regen" title="${escapeHtml(t('fl_regen_sub'))}">${ICONS.refresh}<span><b>${t('fl_regen')}</b></span></button>
                <button type="button" class="ifimgen-fl-act" data-act="regen-scene" title="${escapeHtml(t('fl_regen_scene_sub'))}">${ICONS.brain}<span><b>${t('fl_regen_scene')}</b></span></button>
                <button type="button" class="ifimgen-fl-act" data-act="gen" title="${escapeHtml(t('fl_generate_sub'))}">${ICONS.sparkles}<span><b>${t('fl_generate')}</b></span></button>
            </div>
            ${busy ? item('cancel', 'x', t('fl_cancel', { n: lastState.running }), '', 'danger') : ''}
            ${styleRow()}
            <div class="ifimgen-fl-row ifimgen-fl-row-mini">
                ${item('scene', 'brain', t('fl_scene'))}
                ${item('tokens', 'sparkles', `${t('fl_tokens')}${tokenCount() ? ` (${tokenCount()})` : ''}`)}
                ${item('gallery', 'images', t('fl_gallery'))}
                ${item('collapse', 'image', g.collapseImages ? t('fl_unfold') : t('fl_fold'))}
                ${item('settings', 'settings', t('fl_settings'))}
            </div>
            <div class="ifimgen-fl-hint">${t('fl_drag')}</div>`;
        fitPop();
    }
    function openPop() {
        if (!root || !pop) return;
        editing = null;
        renderPop();
        // preferred side: open downwards when the button sits in the upper half, rightwards when in the left half
        const r = root.getBoundingClientRect();
        pop.classList.toggle('flip-y', r.top + r.height / 2 < window.innerHeight / 2);
        pop.classList.toggle('flip-x', r.left + r.width / 2 < window.innerWidth / 2);
        root.classList.add('open');
        fitPop();
        setTimeout(() => document.addEventListener('pointerdown', outside, { capture: true }), 0);
    }
    /**
     * Phones: the popup can be wider / taller than the space on the chosen side (or than the whole viewport
     * once the keyboard is up). Measure it and translate / cap its height so it always stays on screen.
     */
    function fitPop() {
        if (!pop || !root?.classList.contains('open')) return;
        const M = 8;
        pop.style.transform = ''; pop.style.maxHeight = ''; pop.style.overflowY = '';
        let r = pop.getBoundingClientRect();
        const maxH = window.innerHeight - 2 * M;
        if (r.height > maxH) { pop.style.maxHeight = `${maxH}px`; pop.style.overflowY = 'auto'; r = pop.getBoundingClientRect(); }
        let dx = 0, dy = 0;
        if (r.right > window.innerWidth - M) dx = window.innerWidth - M - r.right;
        if (r.left + dx < M) dx = M - r.left;
        if (r.bottom > window.innerHeight - M) dy = window.innerHeight - M - r.bottom;
        if (r.top + dy < M) dy = M - r.top;
        if (dx || dy) pop.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
    }
    function closePop() { root?.classList.remove('open', 'editing'); editing = null; if (pop) { pop.style.transform = ''; pop.style.maxHeight = ''; pop.style.overflowY = ''; } document.removeEventListener('pointerdown', outside, { capture: true }); }
    const outside = e => { if (root && !root.contains(e.target)) closePop(); };
    function onAction(e) {
        const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
        e.preventDefault(); e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'regen') regenLast(false);
        else if (act === 'regen-scene') regenLast(true);
        else if (act === 'gen') genLast();
        else if (act === 'cancel') { pipeline.cancel(); closePop(); }
        else if (act === 'gallery') { closePop(); openGallery?.(); }
        else if (act === 'settings') { closePop(); openSettings?.(); }
        else if (act === 'collapse') { onCollapseToggle?.(); renderPop(); }
        else if (act === 'style-edit') { const id = pop.querySelector('[data-style-select]')?.value || settings.defaultStyleId; if (id && styles().some(s => s.id === id)) { editing = { id }; renderEditor(); } }
        else if (act === 'tokens') { editing = 'tokens'; renderTokens(); }
        else if (act === 'scene') { editing = 'scene'; renderScene(); }
        else if (act === 'scene-save') sceneSave(false);
        else if (act === 'scene-save-regen') sceneSave(true);
        else if (act === 'tokens-back') { editing = null; renderPop(); }
        else if (act === 'style-new') { editing = { id: null }; renderEditor(); }
        else if (act === 'style-back') { editing = null; renderPop(); }
        else if (act === 'style-save') styleSave();
        else if (act === 'style-delete') styleDelete();
        else if (act === 'style-default') styleDefault();
    }

    // ------------------------------------------------------------------ drag (pointer events; no move = click)
    function enableDrag(handle) {
        let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, active = false;
        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            active = true; moved = false; sx = e.clientX; sy = e.clientY;
            const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
            try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });
        handle.addEventListener('pointermove', e => {
            if (!active) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 6) return;
            if (!moved) closePop();
            moved = true;
            place(ox + dx, oy + dy);
        });
        const up = e => {
            if (!active) return;
            active = false;
            try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            if (moved) { const r = root.getBoundingClientRect(); g.floaterPos = { x: Math.round(r.left), y: Math.round(r.top) }; save(); }
            else if (root.classList.contains('open')) closePop(); else openPop();
        };
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    }
    function place(x, y) {
        if (!root) return;
        const w = root.offsetWidth || BTN, h = root.offsetHeight || BTN;
        const cx = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w));
        const cy = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h));
        root.style.left = `${cx}px`; root.style.top = `${cy}px`; root.style.right = 'auto'; root.style.bottom = 'auto';
    }
    function onResize() { if (root && g.floaterPos && Number.isFinite(g.floaterPos.x)) place(g.floaterPos.x, g.floaterPos.y); fitPop(); }

    // ------------------------------------------------------------------ progress markers
    function paint(st) {
        lastState = st;
        const busy = st.running > 0;
        if (root) {
            root.classList.toggle('running', busy);
            root.querySelector('.ifimgen-fl-count').textContent = busy ? String(st.running) : '';
            root.querySelector('.ifimgen-fl-btn').title = busy ? statusText(st) : t('fl_title');
            if (root.classList.contains('open')) renderPop();
        }
        // per-message strips (test renders use a negative key and have no message)
        const want = new Set(st.ids.filter(id => typeof id === 'number' && id >= 0));
        document.querySelectorAll('.ifimgen-genbar').forEach(el => { if (!want.has(Number(el.dataset.mid))) el.remove(); });
        for (const id of want) {
            const mesText = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
            if (!mesText) continue;
            let bar = mesText.parentElement.querySelector(`.ifimgen-genbar[data-mid="${id}"]`);
            if (!bar) {
                bar = document.createElement('div');
                bar.className = 'ifimgen-genbar';
                bar.dataset.mid = String(id);
                bar.innerHTML = `<span class="ifimgen-genbar-txt"></span><span class="ifimgen-genbar-bar"></span><button type="button" class="ifimgen-genbar-cancel" title="${t('job_cancel')}">${ICONS.x}</button>`;
                bar.querySelector('.ifimgen-genbar-cancel').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); pipeline.cancel(id); });
                mesText.parentElement.insertBefore(bar, mesText);
            }
            bar.querySelector('.ifimgen-genbar-txt').textContent = `${t('fl_generating')}${st.status ? ` — ${st.status}` : ''}`;
        }
        if (pill) {
            pill.classList.toggle('show', busy);
            if (busy) pill.querySelector('span').textContent = statusText(st);
        }
    }

    // ------------------------------------------------------------------ mount / unmount
    function mount() {
        if (root || g.floater === false) return;
        root = document.createElement('div');
        root.id = 'ifimgen_floater';
        root.className = 'ifimgen-fl';
        root.innerHTML = `
            <button type="button" class="ifimgen-fl-btn" aria-label="IF Imgen" title="${t('fl_title')}">
                ${ICONS.image}
                <span class="ifimgen-fl-count"></span>
            </button>
            <div class="ifimgen-fl-pop"></div>`;
        document.body.appendChild(root);
        pop = root.querySelector('.ifimgen-fl-pop');
        pop.addEventListener('click', onAction);
        pop.addEventListener('change', onStyleSelect);
        // typing / clicking inside the popup must not start a drag on the button or close via the outside handler
        pop.addEventListener('pointerdown', e => e.stopPropagation());
        enableDrag(root.querySelector('.ifimgen-fl-btn'));
        if (g.floaterPos && Number.isFinite(g.floaterPos.x) && Number.isFinite(g.floaterPos.y)) place(g.floaterPos.x, g.floaterPos.y);
        window.addEventListener('resize', onResize);

        pill = document.createElement('div');
        pill.className = 'ifimgen-genpill';
        pill.title = t('job_cancel');
        pill.innerHTML = '<span></span>';
        pill.addEventListener('click', () => pipeline.cancel());
        document.body.appendChild(pill);

        stopJobs = pipeline.onJobs?.(paint) ?? null;
    }
    function unmount() {
        stopJobs?.(); stopJobs = null;
        closePop();
        window.removeEventListener('resize', onResize);
        root?.remove(); pill?.remove(); root = pop = pill = null;
        document.querySelectorAll('.ifimgen-genbar').forEach(el => el.remove());
    }

    mount();
    return {
        /** Setting toggled in the drawer. */
        setEnabled(on) { g.floater = Boolean(on); if (on) mount(); else unmount(); },
        /** Language switched: rebuild texts. */
        refresh() { unmount(); mount(); },
        /** Chat re-rendered (new chat / edit / more messages): restore strips for running jobs. */
        repaint() { paint(lastState); },
        unmount,
    };
}
