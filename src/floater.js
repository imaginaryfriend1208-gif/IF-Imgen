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

const BTN = 52; // button diameter (px) - keep in sync with .ifimgen-fl-btn

/**
 * @param {{ settings:object, save:Function, pipeline:object, getContext:Function,
 *           openSettings:Function, openGallery:Function, onCollapseToggle:Function }} deps
 */
export function mountFloater({ settings, save, pipeline, getContext, openSettings, openGallery, onCollapseToggle }) {
    const g = settings.generate;
    let root = null, pop = null, pill = null, stopJobs = null;
    let lastState = { running: 0, ids: [], status: '' };

    const lastCharMessage = () => {
        const ctx = getContext();
        let id = ctx.chat.length - 1;
        while (id >= 0 && (ctx.chat[id].is_user || ctx.chat[id].is_system)) id--;
        return id;
    };
    const toast = (kind, msg) => { try { toastr[kind](msg, 'IF Imgen'); } catch { /* no toastr */ } };
    const statusText = st => `${t('job_running', { n: st.running })}${st.status ? ` — ${st.status}` : ''}`;

    // ------------------------------------------------------------------ actions
    async function regenLast() {
        const id = lastCharMessage();
        if (id < 0) return toast('warning', t('st_no_char_msg'));
        closePop();
        try {
            const r = await pipeline.regenerateAll(id, {});
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

    // ------------------------------------------------------------------ popup
    const item = (act, icon, label, sub = '', cls = '') =>
        `<button type="button" class="ifimgen-fl-act ${cls}" data-act="${act}">${ICONS[icon] ?? ''}<span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
    function renderPop() {
        if (!pop) return;
        const busy = lastState.running > 0;
        pop.innerHTML = `
            <div class="ifimgen-fl-status">${busy ? statusText(lastState) : t('fl_title')}</div>
            ${item('regen', 'refresh', t('fl_regen'), t('fl_regen_sub'), 'primary')}
            ${item('gen', 'sparkles', t('fl_generate'), t('fl_generate_sub'))}
            ${busy ? item('cancel', 'x', t('fl_cancel', { n: lastState.running }), '', 'danger') : ''}
            <div class="ifimgen-fl-row">
                ${item('gallery', 'images', t('fl_gallery'))}
                ${item('collapse', 'image', g.collapseImages ? t('fl_unfold') : t('fl_fold'))}
                ${item('settings', 'settings', t('fl_settings'))}
            </div>
            <div class="ifimgen-fl-hint">${t('fl_drag')}</div>`;
    }
    function openPop() {
        if (!root || !pop) return;
        renderPop();
        // keep the popup inside the viewport: open downwards near the top edge, leftwards near the left edge
        const r = root.getBoundingClientRect();
        pop.classList.toggle('flip-y', r.top < 360);
        pop.classList.toggle('flip-x', r.left < 280);
        root.classList.add('open');
        setTimeout(() => document.addEventListener('pointerdown', outside, { capture: true }), 0);
    }
    function closePop() { root?.classList.remove('open'); document.removeEventListener('pointerdown', outside, { capture: true }); }
    const outside = e => { if (root && !root.contains(e.target)) closePop(); };
    function onAction(e) {
        const b = e.target.closest('[data-act]'); if (!b) return;
        e.preventDefault(); e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'regen') regenLast();
        else if (act === 'gen') genLast();
        else if (act === 'cancel') { pipeline.cancel(); closePop(); }
        else if (act === 'gallery') { closePop(); openGallery?.(); }
        else if (act === 'settings') { closePop(); openSettings?.(); }
        else if (act === 'collapse') { onCollapseToggle?.(); renderPop(); }
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
    function onResize() { if (root && g.floaterPos && Number.isFinite(g.floaterPos.x)) place(g.floaterPos.x, g.floaterPos.y); }

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
