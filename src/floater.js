// IF Imgen - floating quick-action button + in-chat progress markers.
//
//  * One draggable round button (bottom-right by default, position remembered in settings).
//    Click -> popup with the quick actions; REGEN of the last reply is the first / biggest one.
//    While a job runs the button shows a spinner ring + count, and its label follows the pipeline status.
//  * Every message that currently has an image job gets a small "generating…" strip at the top of its
//    text (class .ifimgen-genbar) so it is obvious WHICH reply is being illustrated. A sticky pill at the
//    bottom of the chat mirrors the same status when the message is scrolled out of view.
import { ICONS } from './icons.js';
import { t } from './i18n.js';

/**
 * @param {{ settings:object, save:Function, pipeline:object, getContext:Function, openDrawer:Function,
 *           openGallery:Function, onCollapseToggle:Function }} deps
 */
export function mountFloater({ settings, save, pipeline, getContext, openDrawer, openGallery, onCollapseToggle }) {
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
    function cancelAll() { pipeline.cancel(); closePop(); }

    // ------------------------------------------------------------------ popup
    const item = (act, icon, label, cls = '') => `<button type="button" class="ifimgen-fl-item ${cls}" data-act="${act}">${ICONS[icon] ?? ''}<span>${label}</span></button>`;
    function renderPop() {
        const busy = lastState.running > 0;
        pop.innerHTML = `
            ${item('regen', 'refresh', t('fl_regen_last'), 'primary big')}
            ${item('gen', 'image', t('fl_gen_last'))}
            ${busy ? item('cancel', 'x', t('fl_cancel', { n: lastState.running }), 'danger') : ''}
            <div class="ifimgen-fl-sep"></div>
            ${item('gallery', 'images', t('fl_gallery'))}
            ${item('collapse', g.collapseImages ? 'eye' : 'eyeoff', g.collapseImages ? t('fl_unfold') : t('fl_fold'))}
            ${item('settings', 'gear', t('fl_settings'))}`;
    }
    function openPop() {
        if (!pop) return;
        renderPop();
        pop.classList.add('open');
        root.classList.add('open');
        // keep popup inside the viewport: flip to the left / top when the button is near an edge
        const r = root.getBoundingClientRect();
        pop.classList.toggle('flip-x', r.left < 240);
        pop.classList.toggle('flip-y', r.top < 320);
        setTimeout(() => document.addEventListener('pointerdown', outside, { capture: true, once: true }), 0);
    }
    function closePop() { pop?.classList.remove('open'); root?.classList.remove('open'); }
    const outside = e => { if (!root.contains(e.target)) closePop(); else setTimeout(() => document.addEventListener('pointerdown', outside, { capture: true, once: true }), 0); };

    // ------------------------------------------------------------------ drag (pointer events; click = no move)
    function enableDrag(handle) {
        let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, active = false;
        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            active = true; moved = false; sx = e.clientX; sy = e.clientY;
            const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
            handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', e => {
            if (!active) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 6) return;
            moved = true;
            place(ox + dx, oy + dy);
        });
        const up = e => {
            if (!active) return;
            active = false;
            try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            if (moved) { const r = root.getBoundingClientRect(); g.floaterPos = { x: Math.round(r.left), y: Math.round(r.top) }; save(); }
            else { if (pop.classList.contains('open')) closePop(); else openPop(); }
        };
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    }
    function place(x, y) {
        const w = root.offsetWidth || 52, h = root.offsetHeight || 52;
        const cx = Math.min(Math.max(0, x), window.innerWidth - w);
        const cy = Math.min(Math.max(0, y), window.innerHeight - h);
        root.style.left = `${cx}px`; root.style.top = `${cy}px`; root.style.right = 'auto'; root.style.bottom = 'auto';
    }

    // ------------------------------------------------------------------ progress markers
    function paint(st) {
        lastState = st;
        const busy = st.running > 0;
        if (root) {
            root.classList.toggle('busy', busy);
            root.querySelector('.ifimgen-fl-count').textContent = busy ? String(st.running) : '';
            root.title = busy ? `${t('job_running', { n: st.running })}${st.status ? ` — ${st.status}` : ''}` : t('fl_title');
            if (pop?.classList.contains('open')) renderPop();
        }
        // per-message strips
        const want = new Set(st.ids.filter(id => typeof id === 'number' && id >= 0));
        document.querySelectorAll('.ifimgen-genbar').forEach(el => { const id = Number(el.dataset.mid); if (!want.has(id)) el.remove(); });
        for (const id of want) {
            const mes = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
            if (!mes) continue;
            let bar = mes.parentElement.querySelector(`.ifimgen-genbar[data-mid="${id}"]`);
            if (!bar) {
                bar = document.createElement('div');
                bar.className = 'ifimgen-genbar';
                bar.dataset.mid = String(id);
                bar.innerHTML = `<span class="ifimgen-genbar-spin"></span><span class="ifimgen-genbar-text"></span><button type="button" class="ifimgen-genbar-cancel" title="${t('job_cancel')}">${ICONS.x}</button>`;
                bar.querySelector('.ifimgen-genbar-cancel').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); pipeline.cancel(id); });
                mes.parentElement.insertBefore(bar, mes);
            }
            bar.querySelector('.ifimgen-genbar-text').textContent = `${t('fl_generating')}${st.status ? ` — ${st.status}` : ''}`;
        }
        // sticky pill at the bottom of the chat (visible even when the message is scrolled away)
        if (pill) {
            pill.classList.toggle('show', busy);
            if (busy) pill.querySelector('span').textContent = `${t('job_running', { n: st.running })}${st.status ? ` — ${st.status}` : ''}`;
        }
    }

    // ------------------------------------------------------------------ mount / unmount
    function mount() {
        if (root || g.showFloater === false) return;
        root = document.createElement('div');
        root.id = 'ifimgen_floater';
        root.className = 'ifimgen-fl';
        root.innerHTML = `
            <button type="button" class="ifimgen-fl-btn" aria-label="IF Imgen">
                <span class="ifimgen-fl-ring"></span>
                ${ICONS.image}
                <span class="ifimgen-fl-count"></span>
            </button>
            <div class="ifimgen-fl-pop"></div>`;
        document.body.appendChild(root);
        pop = root.querySelector('.ifimgen-fl-pop');
        pop.addEventListener('click', e => {
            const b = e.target.closest('[data-act]'); if (!b) return;
            const act = b.dataset.act;
            if (act === 'regen') regenLast();
            else if (act === 'gen') genLast();
            else if (act === 'cancel') cancelAll();
            else if (act === 'gallery') { closePop(); openGallery(); }
            else if (act === 'settings') { closePop(); openDrawer(); }
            else if (act === 'collapse') { g.collapseImages = !g.collapseImages; save(); onCollapseToggle(g.collapseImages); renderPop(); }
        });
        enableDrag(root.querySelector('.ifimgen-fl-btn'));
        if (g.floaterPos && Number.isFinite(g.floaterPos.x)) place(g.floaterPos.x, g.floaterPos.y);
        window.addEventListener('resize', onResize);

        pill = document.createElement('div');
        pill.className = 'ifimgen-genpill';
        pill.innerHTML = `<span></span>`;
        pill.title = t('job_cancel');
        pill.addEventListener('click', () => pipeline.cancel());
        (document.getElementById('sheld') || document.body).appendChild(pill);

        stopJobs = pipeline.onJobs?.(paint);
    }
    function onResize() { if (root && g.floaterPos) place(g.floaterPos.x, g.floaterPos.y); }
    function unmount() {
        stopJobs?.(); stopJobs = null;
        window.removeEventListener('resize', onResize);
        root?.remove(); pill?.remove(); root = pop = pill = null;
        document.querySelectorAll('.ifimgen-genbar').forEach(el => el.remove());
    }

    mount();
    return {
        /** Re-read settings (show/hide) and re-render texts after a language switch. */
        refresh() { unmount(); mount(); },
        /** Chat re-rendered (new chat / message edit): restore strips for running jobs. */
        repaint() { paint(lastState); },
        unmount,
    };
}
