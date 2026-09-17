// IF Imgen - small pure helpers. No DOM, no ST imports (testable in node).

export function uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function clamp(n, min, max) {
    n = Number(n);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

export function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/** Lowercase, strip diacritics (Vietnamese đ included), collapse whitespace. */
export function normalizeText(s) {
    return String(s ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/** "a, b ,c" | ["a","b"] -> ["a","b","c"] (trimmed, unique, non-empty). */
export function splitList(value) {
    const arr = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/);
    const out = [];
    for (const raw of arr) {
        const v = String(raw ?? '').trim();
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

/** Join comma tag fragments, dropping empties and duplicate commas. */
export function joinTags(...parts) {
    const out = [];
    for (const p of parts.flat()) {
        const s = String(p ?? '').trim().replace(/^,+|,+$/g, '').trim();
        if (s) out.push(s);
    }
    return out.join(', ');
}

/** Compare dotted versions: 1 if a > b, -1 if a < b, 0 if equal ("0.10.0" > "0.9.1"; leading "v" ignored). */
export function compareVersions(a, b) {
    const parse = v => String(v ?? '').trim().replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
    const pa = parse(a), pb = parse(b);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}

export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function b64ToBlob(b64, type = 'image/png') {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type });
}

export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
    });
}

/** Download an image URL as a file (fetch -> blob -> <a download>); falls back to opening it. */
export async function downloadUrl(url, filename = '') {
    try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename || decodeURIComponent(String(url).split('/').pop() || 'image.png');
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    } catch { window.open(url, '_blank'); }
}

export function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

export function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result ?? ''));
        fr.onerror = () => reject(fr.error);
        fr.readAsText(file);
    });
}
