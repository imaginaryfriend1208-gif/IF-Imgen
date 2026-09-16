// IF Imgen - floating quick-action button + in-chat progress markers.
//
//  * One draggable round button (bottom-right by default; position remembered in settings.generate.floaterPos).
//    Click -> popup with quick actions; REGEN of the last reply is the first / biggest one.
//    While a job runs: spinner ring + job count on the button, status text in a pill above it.
//  * Every message with a running image job gets a slim "generating…" strip at the top of its text
//    (.ifimgen-genbar) so it is obvious WHICH reply is being illustrated.
//
// Defensive by design: everything is wrapped so a DOM hiccup here can never take the drawer down.
import { ICONS } from './icons.js';
import { t } from './i18n.js';

export function mountFloater({ settings, save, pipeline, getContext, openDrawer, onCollapseToggle }) {
    const g = settings.generate;
    let root = null, btn = null, pop = null, pill = null, label = null, count = null;
    let stopJobs = null, timer = null, retry = null;
    let state = { running: 0, ids: [], status: '' };

    const lastCharMessage = () => {
        const ctx = getContext();
        for (let id = ctx.chat.length - 1; id >= 0; id--) {
            const m = ctx.chat[id];
            if (m && !m.is_user && !m.is_system) return id;
        }
        return -1;
    };

    // ---- actions ------------------------------------------------------------------------------------
    const actions = {
        regen: async () => { const id = lastCharMessage(); if (id < 0) return toast(t('fl_no_reply')); closePop(); await pipeline.regenerateAll(id, {}); },
        generate: async () => { const id = lastCharMessage(); if (id < 0) return toast(t('fl_no_reply')); closePop(); await pipeline.run(id, { force: true }); },
        cancel: () => { pipeline.cancel(); closePop(); },
        gallery: () => { closePop(); openDrawer?.('gallery'); },
        settings: () => { closePop(); openDrawer?.('settings'); },
        collapse: () => { closePop(); onCollapseToggle?.(); },
    };
    const toast = msg => { try { window.toastr?.info?.(msg, 'IF Imgen'); } catch { /* no toastr */ } };

    // ---- DOM ----------------------------------------------------------------------------------------
    const item = (act, icon, title, sub, cls = '') => `
        <button class="ifimgen-fl-item ${cls}" data-act="${act}">
            <span class="ifimgen-fl-ico">${ICONS[icon] ?? ''}</span>
            <span class="ifimgen-fl-txt"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>
        </button>`;

    function build() {
        root = document.createElement('div');
        root.className = 'ifimgen-fl';
        root.innerHTML = `
            <div class="ifimgen-fl-pill" style="display:none"></div>
            <div class="ifimgen-fl-pop">
                <div class="ifimgen-fl-head">${t('fl_title')}<span class="ifimgen-fl-drag">${t('fl_drag')}</span></div>
                ${item('regen', 'refresh', t('fl_regen'), t('fl_regen_sub'), 'primary')}
                ${item('generate', 'sparkles', t('fl_generate'), t('fl_generate_sub'))}
                ${item('cancel', 'x', t('fl_cancel'), '', 'cancel')}
                <div class="ifimgen-fl-row">
                    ${item('gallery', 'images', t('fl_gallery'), '')}
                    ${item('settings', 'settings', t('fl_settings'), '')}
                    ${item('collapse', 'image', t('fl_collapse'), '')}
                </div>
            </div>
            <button class="ifimgen-fl-btn" title="IF Imgen">${ICONS.sparkles}<span class="ifimgen-fl-count"></span></button>`;
        btn = root.querySelector('.ifimgen-fl-btn');
        pop = root.querySelector('.ifimgen-fl-pop');
        pill = root.querySelector('.ifimgen-fl-pill');
        count = root.querySelector('.ifimgen-fl-count');
        root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); Promise.resolve(actions[b.dataset.act]?.()).catch(err => console.error('[IF Imgen] floater action', err)); }));
        pill.addEventListener('click', () => { const id = state.ids.find(x => x >= 0); if (id >= 0) document.querySelector(`#chat .mes[mesid="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
        wireDrag();
        applyPos();
        document.body.appendChild(root);
    }

    function applyPos() {
        const p = g.floaterPos;
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
            root.style.left = Math.min(Math.max(0, p.x), window.innerWidth - 60) + 'px';
            root.style.top = Math.min(Math.max(0, p.y), window.innerHeight - 60) + 'px';
            root.style.right = 'auto'; root.style.bottom = 'auto';
        } else { root.style.right = '16px'; root.style.bottom = '90px'; root.style.left = 'auto'; root.style.top = 'auto'; }
        // popup opens upward when the button sits in the lower half, leftward when on the right half
        const r = root.getBoundingClientRect();
        root.classList.toggle('up', r.top > window.innerHeight / 2);
        root.classList.toggle('left', r.left > window.innerWidth / 2);
    }

    function wireDrag() {
        let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, pid = null;
        const down = e => {
            pid = e.pointerId; moved = false; sx = e.clientX; sy = e.clientY;
            const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
            btn.setPointerCapture?.(pid);
        };
        const move = e => {
            if (pid === null || e.pointerId !== pid) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 6) return;
            moved = true;
            root.style.left = (ox + dx) + 'px'; root.style.top = (oy + dy) + 'px'; root.style.right = 'auto'; root.style.bottom = 'auto';
        };
        const up = e => {
            if (pid === null || e.pointerId !== pid) return;
            pid = null;
            if (moved) { const r = root.getBoundingClientRect(); g.floaterPos = { x: r.left, y: r.top }; save(); applyPos(); }
            else togglePop();
        };
        btn.addEventListener('pointerdown', down);
        btn.addEventListener('pointermove', move);
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointercancel', () => { pid = null; });
        window.addEventListener('resize', () => { if (root) applyPos(); });
    }

    const outside = e => { if (root && !root.contains(e.target)) closePop(); };
    const onKey = e => { if (e.key === 'Escape') closePop(); };
    function togglePop() { root.classList.contains('open') ? closePop() : openPop(); }
    function openPop() {
        applyPos(); root.classList.add('open');
        setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey); }, 0);
    }
    function closePop() {
        root?.classList.remove('open');
        document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey);
    }

    // ---- progress -------------------------------------------------------------------------------------
    function paint(s) {
        try { paintInner(s); } catch (e) { console.error('[IF Imgen] floater paint', e); }
    }
    function paintInner(s) {
        state = s ?? state;
        if (!root) return;
        const running = state.running > 0;
        root.classList.toggle('running', running);
        count.textContent = running ? String(state.running) : '';
        const txt = running ? `${t('gen_bar')} ${state.status ? '· ' + state.status : ''}` : '';
        pill.textContent = txt; pill.style.display = running ? '' : 'none';
        root.querySelector('[data-act="cancel"]').style.display = running ? '' : 'none';
        // strips on the messages being illustrated (ST may re-render a message; the interval re-adds them)
        const want = new Set(state.ids.filter(id => id >= 0).map(String));
        document.querySelectorAll('.ifimgen-genbar').forEach(el => { if (!want.has(el.dataset.mid)) el.remove(); });
        for (const mid of want) {
            const host = document.querySelector(`#chat .mes[mesid="${mid}"] .mes_text`);
            if (!host) continue;
            let bar = host.querySelector(':scope > .ifimgen-genbar');
            if (!bar) { bar = document.createElement('div'); bar.className = 'ifimgen-genbar'; bar.dataset.mid = mid; host.prepend(bar); }
            bar.innerHTML = `<span class="ifimgen-genbar-spin"></span>${txt}`;
        }
        if (running && !timer) timer = setInterval(() => paint(state), 1000);
        if (!running && timer) { clearInterval(timer); timer = null; }
    }

    // ---- lifecycle ------------------------------------------------------------------------------------
    function mount() {
        if (root || g.floater === false) return;
        if (!document.body || !document.getElementById('chat')) { retry = setTimeout(mount, 800); return; }
        try {
            build();
            stopJobs = pipeline.onJobs?.(paint) ?? null;
        } catch (e) { console.error('[IF Imgen] floater failed to mount', e); unmount(); }
    }
    function unmount() {
        clearTimeout(retry); retry = null;
        if (timer) { clearInterval(timer); timer = null; }
        stopJobs?.(); stopJobs = null;
        closePop();
        document.querySelectorAll('.ifimgen-genbar').forEach(el => el.remove());
        root?.remove(); root = btn = pop = pill = label = count = null;
    }

    mount();
    return {
        setEnabled(on) { on ? mount() : unmount(); },
        destroy: unmount,
    };
}
