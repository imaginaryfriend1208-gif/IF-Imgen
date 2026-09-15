// IF Imgen - per-chat gallery + image viewer (regenerate / edit / delete).
import { listImages, safeImageUrl } from './paragraphs.js';
import { escapeHtml } from './util.js';
import { ICONS, btn } from './icons.js';

/**
 * @typedef {{ url:string, messageId:number, name:string, scene:string, prompt:string }} GalleryItem
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
            out.push({ url, messageId: i, name: m.name ?? '', scene: rec?.scene ?? '', prompt: rec?.prompt ?? img.title ?? '' });
        }
    });
    return out;
}

/** Full-screen viewer shared by the Gallery tab and by clicking an image in chat. */
export function createViewer({ getContext, pipeline, onChanged = () => {} }) {
    let box = null;

    function jumpTo(messageId) {
        const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!el) return toastr.info(`Message #${messageId} is not loaded in the chat view.`, 'IF Imgen');
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
                ${btn({ cls: 'lb-prev', icon: 'play', title: 'Previous', attrs: 'style="transform:scaleX(-1)"' })}
                ${btn({ cls: 'lb-regen primary', icon: 'refresh', label: 'Regenerate' })}
                ${btn({ cls: 'lb-edit', icon: 'save', label: 'Edit & regenerate' })}
                ${btn({ cls: 'lb-delete danger', icon: 'trash', title: 'Delete image' })}
                ${btn({ cls: 'lb-jump', icon: 'locate', title: 'Go to message' })}
                ${btn({ cls: 'lb-open', icon: 'download', title: 'Open file' })}
                ${btn({ cls: 'lb-next', icon: 'play', title: 'Next' })}
                ${btn({ cls: 'lb-close', icon: 'x', title: 'Close' })}
            </div>`;
        const q = s => box.querySelector(s);
        const img = q('img'), cap = q('.ifimgen-lightbox-cap'), st = q('.ifimgen-lightbox-status');
        const setStatus = (t, cls = '') => { st.textContent = t; st.className = `ifimgen-lightbox-status ifimgen-status ${cls}`; };
        const show = () => {
            const it = items[idx];
            img.src = it.url;
            cap.innerHTML = `<b>#${idx + 1}/${items.length} · message ${it.messageId}</b>`
                + (it.scene ? `<div><span class="ifimgen-cap-k">scene</span> ${escapeHtml(it.scene)}</div>` : '')
                + (it.prompt ? `<div><span class="ifimgen-cap-k">final prompt</span> ${escapeHtml(it.prompt)}</div>` : '<div class="ifimgen-note">no stored prompt (legacy image) — use Edit & regenerate</div>');
            setStatus('');
        };
        const step = d => { if (busy) return; idx = (idx + d + items.length) % items.length; show(); };
        const onKey = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); };
        const lock = v => { busy = v; box.querySelectorAll('.ifimgen-btn').forEach(b => { if (!b.classList.contains('lb-close')) b.disabled = v; }); };

        async function doRegen(scene) {
            const it = items[idx];
            lock(true);
            try {
                const fresh = await pipeline.regenerate(it.messageId, it.url, { scene, onStatus: s => setStatus(s) });
                if (fresh) { items[idx] = { ...it, url: fresh.url, scene: fresh.scene, prompt: fresh.prompt }; show(); setStatus('Regenerated.', 'ok'); onChanged(); }
            } catch (e) { setStatus(e.message, 'error'); }
            finally { lock(false); }
        }

        box.addEventListener('click', e => { if (e.target === box && !busy) close(); });
        q('.lb-close').addEventListener('click', close);
        q('.lb-prev').addEventListener('click', () => step(-1));
        q('.lb-next').addEventListener('click', () => step(1));
        q('.lb-open').addEventListener('click', () => window.open(items[idx].url, '_blank'));
        q('.lb-jump').addEventListener('click', () => { close(); jumpTo(items[idx].messageId); });
        q('.lb-regen').addEventListener('click', () => doRegen(undefined));
        q('.lb-edit').addEventListener('click', async () => {
            const ctx = getContext();
            const it = items[idx];
            const text = await ctx.callGenericPopup('Scene prompt (entities, style and quality/negative are re-applied on top):', ctx.POPUP_TYPE.INPUT, it.scene || it.prompt || '', { rows: 8, wide: true, okButton: 'Regenerate' });
            if (typeof text !== 'string' || !text.trim()) return;
            await doRegen(text.trim());
        });
        q('.lb-delete').addEventListener('click', async () => {
            const ctx = getContext();
            const ok = await ctx.callGenericPopup('Remove this image from the message?', ctx.POPUP_TYPE.CONFIRM);
            if (ok !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
            const it = items[idx];
            lock(true);
            try { await pipeline.removeImage(it.messageId, it.url); items.splice(idx, 1); onChanged(); if (!items.length) return close(); idx = Math.min(idx, items.length - 1); show(); }
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

export function mountGallery({ panel, getContext, viewer }) {
    const grid = panel.querySelector('.ifimgen-gallery');
    const info = panel.querySelector('.ifimgen-gallery-info');
    let items = [];

    function refresh() {
        const ctx = getContext();
        items = collectChatImages(ctx.chat);
        const chatName = ctx.characters?.[ctx.characterId]?.name || ctx.groups?.find?.(g => g.id === ctx.groupId)?.name || 'this chat';
        info.textContent = items.length ? `${items.length} image${items.length > 1 ? 's' : ''} in ${chatName}` : `No IF Imgen images in ${chatName} yet.`;
        grid.innerHTML = items.map((it, i) => `
            <figure class="ifimgen-thumb" data-i="${i}" title="${escapeHtml(it.scene || it.prompt)}">
                <img src="${escapeHtml(it.url)}" alt="" loading="lazy">
                <figcaption>#${it.messageId}</figcaption>
            </figure>`).join('');
    }

    grid.addEventListener('click', e => {
        const fig = e.target.closest('.ifimgen-thumb');
        if (fig) viewer.open(items, Number(fig.dataset.i));
    });
    panel.querySelector('.ifimgen-gallery-refresh').addEventListener('click', refresh);
    refresh();
    return { refresh };
}

export function galleryMarkup() {
    return `
    <div class="ifimgen-panel" data-panel="gallery">
        <div class="ifimgen-box">
            <div class="ifimgen-box-title">${ICONS.images} Gallery — current chat</div>
            <div class="ifimgen-row"><span class="ifimgen-note ifimgen-gallery-info" style="flex:1"></span>${btn({ cls: 'ifimgen-gallery-refresh', icon: 'refresh', title: 'Refresh' })}</div>
            <div class="ifimgen-note">Click a thumbnail (or an image in chat) to view, regenerate, edit its prompt, or delete it.</div>
            <div class="ifimgen-gallery"></div>
        </div>
    </div>`;
}
