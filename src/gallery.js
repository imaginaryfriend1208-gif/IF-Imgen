// IF Imgen - per-chat gallery + test images + image viewer (regenerate / edit / delete).
import { listImages, safeImageUrl } from './paragraphs.js';
import { downloadUrl, escapeHtml } from './util.js';
import { ICONS, btn } from './icons.js';
import { t } from './i18n.js';

/**
 * @typedef {{ url:string, messageId:number, name:string, scene:string, refined?:string, prompt:string, negative?:string, test?:boolean }} GalleryItem
 * @returns {GalleryItem[]}
 */
export function collectChatImages(chat) {
    const out = [];
    (chat ?? []).forEach((m, i) => {
        if (!m?.mes) return;
        const recs = Array.isArray(m.extra?.ifimgen) ? m.extra.ifimgen : [];
        for (const img of listImages(m.mes)) {
            const url = safeImageUrl(img.url);
            const rec = recs.find(r => r.url === url) ?? recs.find(r => r.url === img.url);
            out.push({ url, messageId: i, name: m.name ?? '', scene: rec?.scene ?? '', refined: rec?.refined ?? '', prompt: rec?.prompt ?? img.title ?? '', history: rec?.history ?? [] });
        }
    });
    return out;
}

/** Test records (settings.data.testImages) -> gallery items. */
export function collectTestImages(records) {
    return (records ?? []).map(r => ({ url: r.url, messageId: -1, name: '', scene: r.scene ?? '', refined: '', prompt: r.prompt ?? '', negative: r.negative ?? '', test: true }));
}

/** Profile records from pipeline.profileImages() -> gallery items. */
export function collectProfileImages(records) {
    return (records ?? []).map(r => ({ url: r.url, messageId: -1, name: r.name ?? '', scene: '', refined: '', prompt: r.prompt ?? '', negative: r.negative ?? '', draft: r.draft ?? '', test: true, profile: { kind: r.kind, id: r.id, current: Boolean(r.current) } }));
}

/** Full-screen viewer shared by the Gallery tab and by clicking an image in chat. */
export function createViewer({ getContext, pipeline, onChanged = () => {} }) {
    let box = null;

    function jumpTo(messageId) {
        const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!el) return toastr.info(t('vw_msg_not_loaded', { id: messageId }), 'IF Imgen');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ifimgen-flash');
        setTimeout(() => el.classList.remove('ifimgen-flash'), 1500);
    }

    /** @param {GalleryItem[]} items */
    function open(items, index = 0) {
        close();
        let idx = Math.max(0, Math.min(index, items.length - 1));
        let busy = false;
        box = document.createElement('div');
        box.className = 'ifimgen-lightbox';
        box.innerHTML = `
            <img>
            <div class="ifimgen-lightbox-cap"></div>
            <div class="ifimgen-lightbox-status ifimgen-status"></div>
            <div class="ifimgen-lightbox-bar">
                ${btn({ cls: 'lb-prev', icon: 'play', title: t('vw_prev'), attrs: 'style="transform:scaleX(-1)"' })}
                ${btn({ cls: 'lb-regen primary', icon: 'refresh', label: t('vw_regen'), title: t('vw_regen_tip') })}
                ${btn({ cls: 'lb-regen-scene', icon: 'brain', label: t('vw_regen_scene'), title: t('vw_regen_scene_tip') })}
                ${btn({ cls: 'lb-edit', icon: 'save', label: t('vw_edit') })}
                ${btn({ cls: 'lb-delete danger', icon: 'trash', title: t('vw_delete') })}
                ${btn({ cls: 'lb-jump', icon: 'locate', title: t('vw_jump') })}
                ${btn({ cls: 'lb-open', icon: 'download', title: t('vw_open') })}
                ${btn({ cls: 'lb-next', icon: 'play', title: t('vw_next') })}
                ${btn({ cls: 'lb-close', icon: 'x', title: t('vw_close') })}
            </div>`;
        const q = s => box.querySelector(s);
        const img = q('img'), cap = q('.ifimgen-lightbox-cap'), st = q('.ifimgen-lightbox-status');
        // Version strip (shown + older versions of this slot); lives right above the caption.
        const ver = document.createElement('div'); ver.className = 'ifimgen-lightbox-versions'; cap.parentNode.insertBefore(ver, cap);
        const fromRec = (it, r) => ({ ...it, url: r.url, scene: r.scene ?? '', refined: r.refined ?? '', prompt: r.prompt ?? '', history: r.history ?? [] });
        const setStatus = (text, cls = '') => { st.textContent = text; st.className = `ifimgen-lightbox-status ifimgen-status ${cls}`; };
        const show = () => {
            const it = items[idx];
            img.src = it.url;
            const doc = it.test ? '' : (pipeline.sceneDoc?.(it.messageId) ?? '');
            const head = it.profile ? `${t('vw_profile')} · ${escapeHtml(it.name)}${it.profile.current ? '' : ` · ${t('vw_ver_older')}`}` : it.test ? t('vw_test') : `${t('vw_message')} ${it.messageId}`;
            cap.innerHTML = `<b>#${idx + 1}/${items.length} · ${head}</b>`
                + (it.test ? '' : (doc
                    ? `<details class="ifimgen-cap-doc"><summary><span class="ifimgen-cap-k">${t('vw_scene_doc')}</span> ${escapeHtml(doc.split('\n')[0].slice(0, 120))}…</summary><pre>${escapeHtml(doc)}</pre></details>`
                    : `<div class="ifimgen-note">${t('vw_scene_doc_none')}</div>`))
                + (it.scene ? `<div><span class="ifimgen-cap-k">${t('vw_scene')}</span> ${escapeHtml(it.scene)}</div>` : '')
                + (it.refined ? `<div><span class="ifimgen-cap-k">${t('vw_refined')}</span> ${escapeHtml(it.refined)}</div>` : '')
                + (it.prompt ? `<div><span class="ifimgen-cap-k">${t('vw_final')}</span> ${escapeHtml(it.prompt)}</div>` : `<div class="ifimgen-note">${t('vw_no_prompt')}</div>`);
            q('.lb-jump').style.display = it.test ? 'none' : '';
            q('.lb-regen-scene').style.display = it.test ? 'none' : '';
            const hist = it.history ?? [];
            ver.style.display = hist.length ? '' : 'none';
            ver.innerHTML = hist.length ? `<span class="ifimgen-cap-k">${t('vw_versions')} (${hist.length + 1})</span>`
                + `<img class="cur" src="${escapeHtml(it.url)}" title="${t('vw_ver_current')}">`
                + hist.map((h, k) => `<img data-k="${k}" src="${escapeHtml(h.url)}" title="${t('vw_ver_older')}">`).join('') : '';
            setStatus('');
        };
        const step = d => { if (busy) return; idx = (idx + d + items.length) % items.length; show(); };
        const onKey = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); };
        const lock = v => { busy = v; box.querySelectorAll('.ifimgen-btn').forEach(b => { if (!b.classList.contains('lb-close')) b.disabled = v; }); };

        /** Chat image: `text` is a scene (re-compiled). Test image: `text` is the final prompt (sent as-is). */
        async function doRegen(text) {
            const it = items[idx];
            lock(true);
            try {
                if (it.profile) {
                    const fresh = await pipeline.profileImage({ kind: it.profile.kind, id: it.profile.id, draft: text, onStatus: s => setStatus(s) });
                    if (fresh) { items[idx] = { ...it, url: fresh.url, prompt: fresh.prompt, draft: fresh.draft ?? it.draft, profile: { ...it.profile, current: true } }; show(); setStatus(t('vw_regenerated'), 'ok'); onChanged(); }
                } else if (it.test) {
                    const fresh = await pipeline.regenerateTest(it.url, { prompt: text, onStatus: s => setStatus(s) });
                    if (fresh) { items[idx] = { ...it, url: fresh.url, prompt: fresh.prompt }; show(); setStatus(t('vw_regenerated'), 'ok'); onChanged(); }
                } else {
                    const fresh = await pipeline.regenerate(it.messageId, it.url, { scene: text, onStatus: s => setStatus(s) });
                    if (fresh) { items[idx] = fromRec(it, fresh); show(); setStatus(t('vw_regenerated'), 'ok'); onChanged(); }
                }
            } catch (e) { setStatus(e.message, 'error'); }
            finally { lock(false); }
        }

        box.addEventListener('click', e => { if (e.target === box && !busy) close(); });
        q('.lb-close').addEventListener('click', close);
        q('.lb-prev').addEventListener('click', () => step(-1));
        q('.lb-next').addEventListener('click', () => step(1));
        q('.lb-open').addEventListener('click', () => downloadUrl(items[idx].url));
        q('.lb-jump').addEventListener('click', () => { close(); jumpTo(items[idx].messageId); });
        q('.lb-regen').addEventListener('click', () => doRegen(undefined));
        // Regen scene: step 1 again for the whole message, every image of it redrawn; the viewer list is refreshed from the records.
        q('.lb-regen-scene').addEventListener('click', async () => {
            const it = items[idx];
            if (it.test) return;
            lock(true);
            try {
                const r = await pipeline.regenerateScene(it.messageId, { onStatus: s => setStatus(s) });
                if (r?.cancelled) return;
                const ctx = getContext();
                const recs = ctx.chat[it.messageId]?.extra?.ifimgen ?? [];
                // Slots keep their order; map every item of this message onto its fresh record by position.
                const mine = items.map((x, k) => [x, k]).filter(([x]) => !x.test && x.messageId === it.messageId);
                mine.forEach(([x, k], n) => { const rec = recs[n]; if (rec) items[k] = fromRec(x, rec); });
                show(); setStatus(t('vw_scene_regenerated', { n: r?.regenerated ?? 0 }), 'ok'); onChanged();
            } catch (e) { setStatus(e.message, 'error'); }
            finally { lock(false); }
        });
        ver.addEventListener('click', async e => {
            const im = e.target.closest('img[data-k]');
            if (!im || busy) return;
            const it = items[idx];
            const h = (it.history ?? [])[Number(im.dataset.k)];
            if (!h) return;
            lock(true);
            try {
                const next = await pipeline.switchVersion(it.messageId, it.url, h.url);
                if (next) { items[idx] = fromRec(it, next); show(); setStatus(t('vw_ver_switched'), 'ok'); onChanged(); }
            } catch (err) { setStatus(err.message, 'error'); }
            finally { lock(false); }
        });
        q('.lb-edit').addEventListener('click', async () => {
            const ctx = getContext();
            const it = items[idx];
            const label = it.profile ? t('vw_profile_edit_prompt') : it.test ? t('vw_edit_prompt_final') : t('vw_edit_prompt_scene');
            const initial = it.profile ? (it.draft || it.prompt || '') : it.test ? it.prompt : (it.scene || it.prompt || '');
            const text = await ctx.callGenericPopup(label, ctx.POPUP_TYPE.INPUT, initial, { rows: 8, wide: true, okButton: t('vw_regen') });
            if (typeof text !== 'string' || !text.trim()) return;
            await doRegen(text.trim());
        });
        q('.lb-delete').addEventListener('click', async () => {
            const ctx = getContext();
            const ok = await ctx.callGenericPopup(t(items[idx].history?.length ? 'vw_confirm_delete_ver' : 'vw_confirm_delete'), ctx.POPUP_TYPE.CONFIRM);
            if (ok !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
            const it = items[idx];
            lock(true);
            try {
                let next = null;
                if (it.profile) pipeline.profileRemove(it.profile.kind, it.profile.id, it.url);
                else if (it.test) pipeline.removeTest(it.url);
                else next = await pipeline.removeImage(it.messageId, it.url);
                if (next) items[idx] = fromRec(it, next); else items.splice(idx, 1);
                onChanged();
                if (!items.length) return close();
                idx = Math.min(idx, items.length - 1); show();
            }
            catch (e) { setStatus(e.message, 'error'); }
            finally { lock(false); }
        });
        document.addEventListener('keydown', onKey);
        box._onKey = onKey;
        document.body.appendChild(box);
        show();
    }

    function close() {
        if (!box) return;
        document.removeEventListener('keydown', box._onKey);
        box.remove();
        box = null;
    }

    return { open, close };
}

export function mountGallery({ panel, getContext, viewer, pipeline }) {
    const grid = panel.querySelector('.ifimgen-gallery');
    const info = panel.querySelector('.ifimgen-gallery-info');
    const tgrid = panel.querySelector('.ifimgen-gallery-test');
    const tinfo = panel.querySelector('.ifimgen-gallery-test-info');
    const pgrid = panel.querySelector('.ifimgen-gallery-profile');
    const pinfo = panel.querySelector('.ifimgen-gallery-profile-info');
    let items = [], titems = [], pitems = [];

    const thumbs = (list, cap) => list.map((it, i) => `
        <figure class="ifimgen-thumb" data-i="${i}" title="${escapeHtml(it.scene || it.prompt)}">
            <img src="${escapeHtml(it.url)}" alt="" loading="lazy">
            <figcaption>${cap(it)}</figcaption>
        </figure>`).join('');

    function refresh() {
        const ctx = getContext();
        items = collectChatImages(ctx.chat);
        const chatName = ctx.characters?.[ctx.characterId]?.name || ctx.groups?.find?.(g => g.id === ctx.groupId)?.name || t('st_this_chat');
        info.textContent = items.length ? t('st_gallery_count', { n: items.length, chat: chatName }) : t('st_gallery_empty', { chat: chatName });
        grid.innerHTML = thumbs(items, it => `#${it.messageId}`);

        titems = collectTestImages(pipeline?.testImages?.() ?? []);
        tinfo.textContent = titems.length ? t('st_test_count', { n: titems.length }) : t('st_test_empty');
        tgrid.innerHTML = thumbs(titems, it => escapeHtml((it.mode || 'test').toString()));

        pitems = collectProfileImages(pipeline?.profileImages?.() ?? []);
        pinfo.textContent = pitems.length ? t('st_profile_images_count', { n: pitems.length }) : t('st_profile_images_empty');
        pgrid.innerHTML = thumbs(pitems, it => escapeHtml(it.name));
    }

    grid.addEventListener('click', e => {
        const fig = e.target.closest('.ifimgen-thumb');
        if (fig) viewer.open(items, Number(fig.dataset.i));
    });
    tgrid.addEventListener('click', e => {
        const fig = e.target.closest('.ifimgen-thumb');
        if (fig) viewer.open(titems, Number(fig.dataset.i));
    });
    pgrid.addEventListener('click', e => {
        const fig = e.target.closest('.ifimgen-thumb');
        if (fig) viewer.open(pitems, Number(fig.dataset.i));
    });
    panel.querySelector('.ifimgen-gallery-refresh').addEventListener('click', refresh);
    refresh();
    return { refresh };
}

export function galleryMarkup() {
    return `
    <div class="ifimgen-panel" data-panel="gallery">
        <div class="ifimgen-box">
            <div class="ifimgen-box-title">${ICONS.images} ${t('box_gallery')}</div>
            <div class="ifimgen-row"><span class="ifimgen-note ifimgen-gallery-info" style="flex:1"></span>${btn({ cls: 'ifimgen-gallery-refresh', icon: 'refresh', title: t('btn_refresh') })}</div>
            <div class="ifimgen-note">${t('note_gallery')}</div>
            <div class="ifimgen-gallery"></div>
        </div>
        <div class="ifimgen-box">
            <div class="ifimgen-box-title">${ICONS.locate} ${t('box_test_images')}</div>
            <div class="ifimgen-row"><span class="ifimgen-note ifimgen-gallery-test-info" style="flex:1"></span></div>
            <div class="ifimgen-note">${t('note_test_images')}</div>
            <div class="ifimgen-gallery ifimgen-gallery-test"></div>
        </div>
        <div class="ifimgen-box">
            <div class="ifimgen-box-title">${ICONS.user} ${t('box_profile_images')}</div>
            <div class="ifimgen-row"><span class="ifimgen-note ifimgen-gallery-profile-info" style="flex:1"></span></div>
            <div class="ifimgen-note">${t('note_profile_images')}</div>
            <div class="ifimgen-gallery ifimgen-gallery-profile"></div>
        </div>
    </div>`;
}
