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
            out.push({ url, messageId: i, name: m.name ?? '', scene: rec?.scene ?? '', final: rec?.final ?? '', refined: rec?.refined ?? '', prompt: rec?.prompt ?? img.title ?? '', history: rec?.history ?? [] });
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

    /**
     * @param {GalleryItem[]} items
     * Layout: image (+ version strip) on top, below it a tabbed reader - Scene document (editable, chat images only) /
     * Prompt draft (editable) / Final prompt (editable) / Refined - then one row of actions. Every text sits in its own
     * tab instead of one caption blob.
     */
    function open(items, index = 0) {
        close();
        let idx = Math.max(0, Math.min(index, items.length - 1));
        let busy = false;
        let tab = 'doc';
        box = document.createElement('div');
        box.className = 'ifimgen-lightbox';
        box.innerHTML = `
            <div class="ifimgen-lb-top">
                ${btn({ cls: 'lb-prev icon', icon: 'play', title: t('vw_prev'), attrs: 'style="transform:scaleX(-1)"' })}
                <img>
                ${btn({ cls: 'lb-next icon', icon: 'play', title: t('vw_next') })}
            </div>
            <div class="ifimgen-lightbox-versions"></div>
            <div class="ifimgen-lb-panel">
                <div class="ifimgen-lb-head"><b class="ifimgen-lb-title"></b><span class="ifimgen-lb-tabs"></span></div>
                <div class="ifimgen-lb-body"></div>
                <div class="ifimgen-lightbox-status ifimgen-status"></div>
                <div class="ifimgen-lightbox-bar"></div>
            </div>`;
        const q = s => box.querySelector(s);
        const img = q('img'), title = q('.ifimgen-lb-title'), tabsEl = q('.ifimgen-lb-tabs'), body = q('.ifimgen-lb-body'), st = q('.ifimgen-lightbox-status'), bar = q('.ifimgen-lightbox-bar'), ver = q('.ifimgen-lightbox-versions');
        const fromRec = (it, r) => ({ ...it, url: r.url, scene: r.scene ?? '', final: r.final ?? '', refined: r.refined ?? '', prompt: r.prompt ?? '', history: r.history ?? [] });
        const setStatus = (text, cls = '') => { st.textContent = text; st.className = `ifimgen-lightbox-status ifimgen-status ${cls}`; };
        const docOf = it => it.test ? '' : (pipeline.sceneDoc?.(it.messageId) ?? '');
        /** Tabs available for this item: [id, label, text, editable]. */
        const tabsOf = it => {
            if (it.profile) return [['draft', t('vw_tab_draft'), it.draft || '', true], ['final', t('vw_tab_final'), it.prompt || '', true]];
            if (it.test) return [['final', t('vw_tab_final'), it.prompt || '', true]];
            const out = [['doc', t('vw_tab_doc'), docOf(it), true], ['draft', t('vw_tab_draft'), it.scene || '', true]];
            if (it.refined) out.push(['refined', t('vw_tab_refined'), it.refined, false]);
            out.push(['final', t('vw_tab_final'), it.prompt || '', true]);
            return out;
        };
        const editorText = () => { const ta = body.querySelector('textarea'); return ta ? ta.value.trim() : ''; };
        const showTab = () => {
            const it = items[idx];
            const tabs = tabsOf(it);
            if (!tabs.some(x => x[0] === tab)) tab = tabs[0][0];
            tabsEl.innerHTML = tabs.map(([id, label, text]) => `<button type="button" class="ifimgen-lb-tab ${id === tab ? 'active' : ''}" data-tab="${id}">${label}${text ? '' : ' <i>·</i>'}</button>`).join('');
            const cur = tabs.find(x => x[0] === tab);
            const [id, , text, editable] = cur;
            const empty = id === 'doc' ? t('vw_scene_doc_none') : t('vw_no_prompt');
            const hint = id === 'doc' ? t('vw_hint_doc') : id === 'draft' ? (it.profile ? t('vw_profile_edit_prompt') : t('vw_hint_draft')) : id === 'final' ? t('vw_hint_final') : t('vw_hint_refined');
            body.innerHTML = `<div class="ifimgen-note">${hint}</div>`
                + (editable ? `<textarea class="text_pole ifimgen-lb-text" spellcheck="false" placeholder="${escapeHtml(empty)}">${escapeHtml(text)}</textarea>`
                    : `<pre class="ifimgen-lb-text">${escapeHtml(text || empty)}</pre>`);
            // Action row depends on the open tab: what is being edited decides what "apply" means.
            const B = [];
            if (it.profile || it.test) {
                B.push(btn({ cls: 'lb-apply primary', icon: 'refresh', label: t('vw_apply_prompt'), title: t('vw_apply_prompt_tip') }));
            } else if (id === 'doc') {
                B.push(btn({ cls: 'lb-doc-save', icon: 'save', label: t('vw_doc_save'), title: t('vw_doc_save_tip') }));
                B.push(btn({ cls: 'lb-doc-save-regen primary', icon: 'refresh', label: t('vw_doc_save_regen'), title: t('vw_doc_save_regen_tip') }));
                B.push(btn({ cls: 'lb-regen-scene', icon: 'brain', label: t('vw_regen_scene'), title: t('vw_regen_scene_tip') }));
            } else if (id === 'draft') {
                B.push(btn({ cls: 'lb-apply primary', icon: 'refresh', label: t('vw_apply_draft'), title: t('vw_apply_draft_tip') }));
                B.push(btn({ cls: 'lb-rewrite', icon: 'brain', label: t('vw_rewrite'), title: t('vw_rewrite_tip') }));
                B.push(btn({ cls: 'lb-redraw', icon: 'image', label: t('vw_redraw'), title: t('vw_redraw_tip') }));
            } else if (id === 'final') {
                B.push(btn({ cls: 'lb-apply-final primary', icon: 'refresh', label: t('vw_apply_final'), title: t('vw_apply_final_tip') }));
                B.push(btn({ cls: 'lb-rewrite', icon: 'brain', label: t('vw_rewrite'), title: t('vw_rewrite_tip') }));
                B.push(btn({ cls: 'lb-redraw', icon: 'image', label: t('vw_redraw'), title: t('vw_redraw_tip') }));
            } else {
                B.push(btn({ cls: 'lb-rewrite primary', icon: 'brain', label: t('vw_rewrite'), title: t('vw_rewrite_tip') }));
                B.push(btn({ cls: 'lb-redraw', icon: 'image', label: t('vw_redraw'), title: t('vw_redraw_tip') }));
            }
            B.push(btn({ cls: 'lb-copy icon', icon: 'clipboard', title: t('vw_copy') }));
            B.push(btn({ cls: 'lb-delete danger icon', icon: 'trash', title: t('vw_delete') }));
            if (!it.test) B.push(btn({ cls: 'lb-jump icon', icon: 'locate', title: t('vw_jump') }));
            B.push(btn({ cls: 'lb-open icon', icon: 'download', title: t('vw_open') }));
            B.push(btn({ cls: 'lb-close icon', icon: 'x', title: t('vw_close') }));
            bar.innerHTML = B.join('');
            if (busy) lock(true);
        };
        const show = () => {
            const it = items[idx];
            img.src = it.url;
            const head = it.profile ? `${t('vw_profile')} · ${escapeHtml(it.name)}${it.profile.current ? '' : ` · ${t('vw_ver_older')}`}` : it.test ? t('vw_test') : `${t('vw_message')} #${it.messageId}`;
            title.innerHTML = `#${idx + 1}/${items.length} · ${head}`;
            const hist = it.history ?? [];
            ver.style.display = hist.length ? '' : 'none';
            ver.innerHTML = hist.length ? `<span class="ifimgen-cap-k">${t('vw_versions')} (${hist.length + 1})</span>`
                + `<img class="cur" src="${escapeHtml(it.url)}" title="${t('vw_ver_current')}">`
                + hist.map((h, k) => `<img data-k="${k}" src="${escapeHtml(h.url)}" title="${t('vw_ver_older')}">`).join('') : '';
            setStatus('');
            showTab();
        };
        const step = d => { if (busy) return; idx = (idx + d + items.length) % items.length; show(); };
        const onKey = e => {
            if (e.target instanceof HTMLTextAreaElement) { if (e.key === 'Escape') e.target.blur(); return; }
            if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1);
        };
        const lock = v => { busy = v; box.querySelectorAll('.ifimgen-btn, .ifimgen-lb-tab').forEach(b => { if (!b.classList.contains('lb-close')) b.disabled = v; }); };
        /** Run an async job with the viewer locked; errors land in the status line. */
        const job = async fn => { if (busy) return; lock(true); try { await fn(); } catch (e) { setStatus(e.message, 'error'); } finally { lock(false); } };
        const applyFresh = (it, fresh) => { if (!fresh) return; items[idx] = it.profile ? { ...it, url: fresh.url, prompt: fresh.prompt, draft: fresh.draft ?? it.draft, profile: { ...it.profile, current: true } } : it.test ? { ...it, url: fresh.url, prompt: fresh.prompt } : fromRec(it, fresh); show(); setStatus(t('vw_regenerated'), 'ok'); onChanged(); };
        const onStatus = s => setStatus(s);

        /**
         * Chat image: `scene` = a draft drawn as typed (no step 2), `final` = a finished prompt sent as-is, `rewrite` = step 2
         * again from the stored document, `redraw` = the stored draft + final again without any LLM call.
         * Profile / test image: `text` is the draft / final prompt.
         */
        async function regen(it, o = {}) {
            if (it.profile) return applyFresh(it, await pipeline.profileImage({ kind: it.profile.kind, id: it.profile.id, draft: o.text, onStatus }));
            if (it.test) return applyFresh(it, await pipeline.regenerateTest(it.url, { prompt: o.text, onStatus }));
            return applyFresh(it, await pipeline.regenerate(it.messageId, it.url, { scene: o.scene, final: o.final, keepPrompt: o.redraw === true, noRefine: o.tokensOnly === true, onStatus }));
        }
        /** Whole-message job (regen scene / save + regenerate): every slot of that message is refreshed from the records. */
        async function refreshMessage(it, r) {
            if (r?.cancelled) return;
            const recs = getContext().chat[it.messageId]?.extra?.ifimgen ?? [];
            const mine = items.map((x, k) => [x, k]).filter(([x]) => !x.test && x.messageId === it.messageId);
            mine.forEach(([x, k], n) => { const rec = recs[n]; if (rec) items[k] = fromRec(x, rec); });
            show(); onChanged();
        }

        // No close on backdrop click: on desktop the panel is wide and a stray click next to it kept dismissing the viewer. Close = X / Esc.
        tabsEl.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b || busy) return; tab = b.dataset.tab; showTab(); });
        bar.addEventListener('click', async e => {
            const b = e.target.closest('.ifimgen-btn'); if (!b) return;
            const it = items[idx];
            const ctx = getContext();
            if (b.classList.contains('lb-close')) return close();
            if (busy) return;
            if (b.classList.contains('lb-open')) return downloadUrl(it.url);
            if (b.classList.contains('lb-jump')) { close(); return jumpTo(it.messageId); }
            if (b.classList.contains('lb-copy')) { try { await navigator.clipboard.writeText(editorText() || body.textContent || ''); setStatus(t('vw_copied'), 'ok'); } catch { setStatus(t('vw_copy_failed'), 'error'); } return; }
            if (b.classList.contains('lb-apply')) { const text = editorText(); if (!text) return setStatus(t('vw_empty'), 'error'); return job(() => regen(it, { text, scene: text, tokensOnly: true })); }
            if (b.classList.contains('lb-apply-final')) { const text = editorText(); if (!text) return setStatus(t('vw_empty'), 'error'); return job(() => regen(it, { final: text })); }
            if (b.classList.contains('lb-rewrite')) return job(() => regen(it, {}));
            if (b.classList.contains('lb-redraw')) return job(() => regen(it, { redraw: true }));
            if (b.classList.contains('lb-doc-save') || b.classList.contains('lb-doc-save-regen')) {
                const text = editorText(); if (!text) return setStatus(t('vw_empty'), 'error');
                if (!pipeline.setSceneDoc?.(it.messageId, text)) return setStatus(t('vw_empty'), 'error');
                setStatus(t('vw_doc_saved'), 'ok');
                if (!b.classList.contains('lb-doc-save-regen')) return;
                return job(async () => { const r = await pipeline.regenerateAll(it.messageId, { newScene: false, onStatus }); await refreshMessage(it, r); if (!r?.cancelled) setStatus(t('vw_doc_regenerated', { n: r?.regenerated ?? 0 }), 'ok'); });
            }
            if (b.classList.contains('lb-regen-scene')) {
                return job(async () => { const r = await pipeline.regenerateScene(it.messageId, { onStatus }); await refreshMessage(it, r); if (!r?.cancelled) setStatus(t('vw_scene_regenerated', { n: r?.regenerated ?? 0 }), 'ok'); });
            }
            if (b.classList.contains('lb-delete')) {
                const ok = await ctx.callGenericPopup(t(it.history?.length ? 'vw_confirm_delete_ver' : 'vw_confirm_delete'), ctx.POPUP_TYPE.CONFIRM);
                if (ok !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
                return job(async () => {
                    let next = null;
                    if (it.profile) pipeline.profileRemove(it.profile.kind, it.profile.id, it.url);
                    else if (it.test) pipeline.removeTest(it.url);
                    else next = await pipeline.removeImage(it.messageId, it.url);
                    if (next) items[idx] = fromRec(it, next); else items.splice(idx, 1);
                    onChanged();
                    if (!items.length) return close();
                    idx = Math.min(idx, items.length - 1); show();
                });
            }
        });
        q('.lb-prev').addEventListener('click', () => step(-1));
        q('.lb-next').addEventListener('click', () => step(1));
        ver.addEventListener('click', e => {
            const im = e.target.closest('img[data-k]');
            if (!im || busy) return;
            const it = items[idx];
            const h = (it.history ?? [])[Number(im.dataset.k)];
            if (!h) return;
            job(async () => { const next = await pipeline.switchVersion(it.messageId, it.url, h.url); if (next) { items[idx] = fromRec(it, next); show(); setStatus(t('vw_ver_switched'), 'ok'); onChanged(); } });
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
