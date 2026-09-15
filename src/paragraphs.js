// IF Imgen - paragraph splitting + image insertion in message text. Pure module.

export const IMG_MARK = '<!--ifimgen-->';

/**
 * Split message into paragraphs (blank-line separated). Skips code fences and
 * paragraphs that are already IF Imgen images. Returns 1-based indexes.
 * @returns {{index:number,text:string,start:number,end:number}[]}
 */
export function splitParagraphs(mes, minChars = 1) {
    const s = String(mes ?? '');
    const out = [];
    const re = /\n[ \t]*\n/g;
    let pos = 0, m, n = 0;
    const push = (start, end) => {
        const text = s.slice(start, end);
        const t = text.trim();
        if (!t) return;
        const lead = text.indexOf(t);
        const a = start + lead, b = a + t.length;
        n++;
        if (t.startsWith('```') || t.includes(IMG_MARK) || t.length < minChars) return; // numbered but unusable
        out.push({ index: n, text: t, start: a, end: b });
    };
    while ((m = re.exec(s))) { push(pos, m.index); pos = m.index + m[0].length; }
    push(pos, s.length);
    return out;
}

/**
 * Markdown image URLs must not contain whitespace or parentheses, otherwise
 * showdown leaves the ![..](..) as plain text (character folders often have spaces).
 */
export function safeImageUrl(url) {
    return String(url ?? '').trim()
        .replace(/\s/g, '%20')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
}

/** Markdown snippet for one generated image. */
export function imageSnippet(url, title = '') {
    const safeTitle = String(title).replace(/["\n]/g, ' ').slice(0, 300);
    return `${IMG_MARK}\n![IF Imgen](${safeImageUrl(url)} "${safeTitle}")`;
}

/**
 * Insert snippets after the given paragraphs. Applies from the last paragraph
 * backwards so earlier offsets stay valid.
 * @param {string} mes
 * @param {{index:number,text:string,start:number,end:number}[]} paragraphs
 * @param {{p:number, snippet:string}[]} inserts
 */
export function insertAfterParagraphs(mes, paragraphs, inserts) {
    let s = String(mes ?? '');
    const byIndex = new Map(paragraphs.map(p => [p.index, p]));
    const sorted = [...inserts].filter(i => byIndex.has(i.p)).sort((a, b) => b.p - a.p);
    for (const ins of sorted) {
        const para = byIndex.get(ins.p);
        s = s.slice(0, para.end) + '\n\n' + ins.snippet + s.slice(para.end);
    }
    return s;
}

/** Remove every IF Imgen image block from a message. */
export function stripImages(mes) {
    return String(mes ?? '')
        .replace(new RegExp(`\\n*${IMG_MARK}\\n!\\[IF Imgen\\]\\([^)]*\\)`, 'g'), '')
        .replace(/\n{3,}/g, '\n\n');
}

/**
 * All IF Imgen images in a message (also tolerates legacy URLs containing spaces).
 * @returns {{url:string,title:string}[]}
 */
export function listImages(mes) {
    const out = [];
    const re = /!\[IF Imgen\]\(([^)"]+?)\s*(?:"([^"]*)")?\)/g;
    let m;
    while ((m = re.exec(String(mes ?? '')))) out.push({ url: m[1].trim(), title: m[2] ?? '' });
    return out;
}

export function countImages(mes) {
    return (String(mes ?? '').match(new RegExp(IMG_MARK, 'g')) || []).length;
}
