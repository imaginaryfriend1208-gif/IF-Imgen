// IF Imgen - per-chat gallery: every IF Imgen image found in the current chat.
import { listImages, safeImageUrl } from './paragraphs.js';
import { escapeHtml } from './util.js';
import { ICONS, btn } from './icons.js';

/** @returns {{url:string,title:string,messageId:number,name:string}[]} */
export function collectChatImages(chat) {
    const out = [];
    (chat ?? []).forEach((m, i) => {
        if (!m?.mes) return;
        for (const img of listImages(m.mes)) out.push({ url: safeImageUrl(img.url), title: img.title, messageId: i, name: m.name ?? '' });
    });
    return out;
}

export function mountGallery({ panel, getContext }) {
    const grid = panel.querySelector('.ifimgen-gallery');
    const info = panel.querySelector('.ifimgen-gallery-info');
    let items = [];

    function refresh() {
        const ctx = getContext();
        items = collectChatImages(ctx.chat);
        const chatName = ctx.characters?.[ctx.characterId]?.name || ctx.groups?.find?.(g => g.id === ctx.groupId)?.name || 'this chat';
        info.textContent = items.length ? `${items.length} image${items.length > 1 ? 's' : ''} in ${chatName}` : `No IF Imgen images in ${chatName} yet.`;
        grid.innerHTML = items.map((it, i) => `
            <figure class="ifimgen-thumb" data-i="${i}" title="${escapeHtml(it.title)}">
                <img src="${escapeHtml(it.url)}" alt="" loading="lazy">
                <figcaption>#${it.messageId}</figcaption>
            </figure>`).join('');
    }

    function jumpTo(messageId) {
        const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!el) return toastr.info(`Message #${messageId} is not loaded in the chat view.`, 'IF Imgen');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ifimgen-flash');
        setTimeout(() => el.classList.remove('ifimgen-flash'), 1500);
    }

    function openLightbox(i) {
        let idx = i;
        const box = document.createElement('div');
        box.className = 'ifimgen-lightbox';
        box.innerHTML = `
            <img>
            <div class="ifimgen-lightbox-cap"></div>
            <div class="ifimgen-lightbox-bar">
                ${btn({ cls: 'lb-prev', icon: 'play', title: 'Previous', attrs: 'style="transform:scaleX(-1)"' })}
                ${btn({ cls: 'lb-jump', icon: 'locate', label: 'Go to message' })}
                ${btn({ cls: 'lb-open', icon: 'download', label: 'Open file' })}
                ${btn({ cls: 'lb-next', icon: 'play', title: 'Next' })}
                ${btn({ cls: 'lb-close', icon: 'x', title: 'Close' })}
            </div>`;
        const img = box.querySelector('img'), cap = box.querySelector('.ifimgen-lightbox-cap');
        const show = () => { const it = items[idx]; img.src = it.url; cap.textContent = `#${idx + 1}/${items.length} · message ${it.messageId}\n${it.title}`; };
        const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
        const step = d => { idx = (idx + d + items.length) % items.length; show(); };
        const onKey = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); };
        box.addEventListener('click', e => { if (e.target === box) close(); });
        box.querySelector('.lb-close').addEventListener('click', close);
        box.querySelector('.lb-prev').addEventListener('click', () => step(-1));
        box.querySelector('.lb-next').addEventListener('click', () => step(1));
        box.querySelector('.lb-open').addEventListener('click', () => window.open(items[idx].url, '_blank'));
        box.querySelector('.lb-jump').addEventListener('click', () => { close(); jumpTo(items[idx].messageId); });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(box);
        show();
    }

    grid.addEventListener('click', e => {
        const fig = e.target.closest('.ifimgen-thumb');
        if (fig) openLightbox(Number(fig.dataset.i));
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
            <div class="ifimgen-gallery"></div>
        </div>
    </div>`;
}
