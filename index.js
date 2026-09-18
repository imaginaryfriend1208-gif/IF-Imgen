// IF Imgen - SillyTavern extension entry.
// Paragraph-aware image generation: planner LLM picks paragraphs of the latest
// reply, compiler attaches bound character/persona/style fragments, backend
// renders, image is inserted right after that paragraph.
import { getContext, extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '../../../../script.js';
import { saveBase64AsFile } from '../../../utils.js';

import { ensureSettings, MODULE } from './src/settings.js';
import { createBackends } from './src/backends.js';
import { createLlm } from './src/llm.js';
import { createPipeline } from './src/pipeline.js';
import { mountDrawer } from './src/ui.js';
import { createViewer, collectChatImages } from './src/gallery.js';
import { t, setLang } from './src/i18n.js';
import { compareVersions } from './src/util.js';
import { countImages, stripImagesLoose, IMG_MARK } from './src/paragraphs.js';

const VERSION = '0.12.14';
const REPO_URL = 'https://github.com/imaginaryfriend1208-gif/IF-Imgen';
const MANIFEST_URL = 'https://raw.githubusercontent.com/imaginaryfriend1208-gif/IF-Imgen/main/manifest.json';
// Direct message: Discord only links profiles by numeric user id (username diuenmii). Opens the profile -> Message.
const DISCORD_URL = 'https://discord.com/users/1148686772281278585';
const KOFI_URL = 'https://ko-fi.com/holimo';
const LOG = (...a) => console.log('[IF Imgen]', ...a);

const settings = ensureSettings(extension_settings);
const save = () => saveSettingsDebounced();
setLang(settings.language);

const backends = createBackends({ getRequestHeaders, settings });
const llm = createLlm({ settings, getContext });

async function saveImage(b64, charName) {
    const safe = String(charName || 'IF_Imgen').replace(/[^\w\- ]/g, '_');
    return saveBase64AsFile(b64, safe, `ifimgen_${Date.now()}_${Math.floor(Math.random() * 1e4)}`, 'png');
}

let drawer = null;
let floater = null; // mounted last, from a dynamic import guarded by try/catch - see mountFloaterSafe()
const pipeline = createPipeline({ settings, getContext, backends, llm, saveImage, save, log: LOG, onChange: id => { drawer?.refreshGallery(); paintAllMessageButtons(); if (settings.generate.collapseImages && typeof id === 'number' && id >= 0) setTimeout(() => foldImages(id), 50); } });
const viewer = createViewer({ getContext, pipeline, onChanged: () => drawer?.refreshGallery() });

// ---- collapse: each IF Imgen image in chat sits behind a small toggle button (Generate → Behaviour).
function foldImages(messageId) {
    const scope = messageId === undefined ? document : document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!scope) return;
    scope.querySelectorAll('.mes_text img[alt="IF Imgen"]').forEach(img => {
        if (img.closest('.ifimgen-fold')) return;
        const fold = document.createElement('div');
        fold.className = 'ifimgen-fold';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ifimgen-fold-btn';
        b.title = t('chat_fold_title');
        b.innerHTML = `<i class="fa-solid fa-image"></i><span>${t('chat_fold_btn')}</span><i class="fa-solid fa-chevron-down ifimgen-fold-chev"></i>`;
        b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fold.classList.toggle('open'); });
        const body = document.createElement('div');
        body.className = 'ifimgen-fold-body';
        img.replaceWith(fold);
        body.appendChild(img);
        fold.append(b, body);
    });
}
function foldAll() { if (settings.generate.collapseImages) foldImages(); }
document.body.classList.toggle('ifimgen-collapse', Boolean(settings.generate.collapseImages));

// ---- alignment: body class drives where chat images (and their fold buttons) sit (Generate -> Behaviour).
function applyAlign(v) {
    const a = ['left', 'center', 'right'].includes(v) ? v : 'left';
    document.body.classList.remove('ifimgen-align-left', 'ifimgen-align-center', 'ifimgen-align-right');
    document.body.classList.add(`ifimgen-align-${a}`);
}
applyAlign(settings.generate.imageAlign);

// ---- update check: compare manifest.json on GitHub with VERSION; header pill turns into a blinking "Update".
let latestVersion = '';
function paintUpdateBadge() {
    const el = document.getElementById('ifimgen_hdr_ver');
    if (!el) return;
    const newer = latestVersion && compareVersions(latestVersion, VERSION) > 0;
    el.classList.toggle('update', Boolean(newer));
    el.textContent = newer ? t('hdr_update') : `v${VERSION}`;
    el.title = newer ? t('hdr_update_title', { v: latestVersion }) : `IF Image v${VERSION}`;
}
async function checkUpdate() {
    try {
        const r = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const m = await r.json();
        if (typeof m?.version === 'string') { latestVersion = m.version; paintUpdateBadge(); }
    } catch { /* offline or blocked: keep showing the current version */ }
}

// Click an IF Imgen image inside the chat -> viewer with regenerate / edit / delete.
document.addEventListener('click', e => {
    const img = e.target instanceof HTMLImageElement && e.target.alt === 'IF Imgen' && e.target.closest('#chat .mes_text') ? e.target : null;
    if (!img) return;
    e.preventDefault(); e.stopPropagation();
    const items = collectChatImages(getContext().chat);
    const url = new URL(img.getAttribute('src'), location.href).pathname;
    const i = items.findIndex(it => it.url === url || it.url === img.getAttribute('src'));
    if (i < 0) return toastr.warning(t('chat_img_not_found'), 'IF Imgen');
    viewer.open(items, i);
}, true);

// ---- prompt interceptor (manifest.generate_interceptor). SillyTavern calls this before every generation with a
// shallow copy of the chat: replacing items (never mutating them) changes only the prompt, not the saved chat.
// The chat LLM must not see our image markdown - models copy `<!--ifimgen-->\n![IF Imgen](url)` from the
// history into their next reply, which showed an OLD picture there and made the auto-run skip the message.
globalThis.ifimgenInterceptor = async function ifimgenInterceptor(chat) {
    if (!Array.isArray(chat)) return;
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || typeof m.mes !== 'string' || !(m.mes.includes('![IF Imgen](') || m.mes.includes(IMG_MARK))) continue;
        chat[i] = { ...m, mes: stripImagesLoose(m.mes) };
    }
};

// ---- per-message button: lives in the message's own action bar right next to the "..." button (always visible,
// not inside the collapsed extra-buttons menu). One button, three faces:
//   no images -> generate | has images -> regenerate all (step 2 again from the stored scene document; Alt+click = new
//   scene document first) | running -> cancel.   Shift+click removes the images.
function paintMessageButton(btn, id) {
    const m = getContext().chat[id];
    const running = pipeline.isRunning(id);
    const has = Boolean(m && countImages(m.mes) > 0);
    btn.classList.remove('fa-images', 'fa-arrows-rotate', 'fa-stop', 'running', 'has-images');
    btn.classList.add(running ? 'fa-stop' : has ? 'fa-arrows-rotate' : 'fa-images');
    if (running) btn.classList.add('running'); else if (has) btn.classList.add('has-images');
    btn.title = t(running ? 'msg_btn_cancel' : has ? 'msg_btn_regen' : 'msg_btn_gen');
}
function paintAllMessageButtons() {
    document.querySelectorAll('#chat .ifimgen_msg_btn').forEach(b => {
        const id = Number(b.closest('.mes')?.getAttribute('mesid'));
        if (Number.isFinite(id)) paintMessageButton(b, id);
    });
}
function addMessageButton(messageId) {
    if (!settings.generate.showButton) return;
    const mes = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mes || mes.getAttribute('is_user') === 'true' || mes.getAttribute('is_system') === 'true') return;
    const existing = mes.querySelector('.ifimgen_msg_btn');
    if (existing) return paintMessageButton(existing, messageId);
    const bar = mes.querySelector('.mes_buttons');
    const hint = bar?.querySelector('.extraMesButtonsHint');
    const extra = mes.querySelector('.extraMesButtons');
    if (!bar && !extra) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button ifimgen_msg_btn fa-solid';
    btn.addEventListener('click', async e => {
        e.preventDefault(); e.stopPropagation();
        const id = Number(btn.closest('.mes')?.getAttribute('mesid'));
        if (e.shiftKey) { await pipeline.clear(id); return paintMessageButton(btn, id); }
        if (pipeline.isRunning(id)) return pipeline.cancel(id);
        try {
            const m = getContext().chat[id];
            if (m && countImages(m.mes) > 0) {
                const r = await pipeline.regenerateAll(id, { newScene: e.altKey });
                if (r?.none) toastr.info(t('st_no_images'), 'IF Imgen');
            } else {
                const r = await pipeline.run(id, { force: true });
                if (r?.skipped) toastr.info(r.skipped, 'IF Imgen');
            }
        } catch (err) { toastr.error(err.message, 'IF Imgen'); }
        finally { paintMessageButton(btn, id); }
    });
    if (hint) hint.before(btn); else if (bar) bar.prepend(btn); else extra.prepend(btn);
    paintMessageButton(btn, messageId);
}
function addAllButtons() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(m => addMessageButton(Number(m.getAttribute('mesid'))));
}
function removeAllButtons() { document.querySelectorAll('#chat .ifimgen_msg_btn').forEach(b => b.remove()); }
// Faces follow the job state (auto-run, floater, slash command, viewer all go through the pipeline).
pipeline.onJobs(() => paintAllMessageButtons());

// ---- events
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
    addMessageButton(messageId);
    if (settings.generate.collapseImages) foldImages(messageId);
});
eventSource.on(event_types.GENERATION_ENDED, async () => {
    if (!settings.enabled || !settings.generate.auto) return;
    const ctx = getContext();
    const id = ctx.chat.length - 1;
    const m = ctx.chat[id];
    if (!m || m.is_user || m.is_system) return;
    try {
        const r = await pipeline.run(id);
        if (r?.skipped && r.skipped !== 'already has images') LOG('skipped:', r.skipped);
    } catch (e) { toastr.error(e.message, 'IF Imgen'); }
});
eventSource.on(event_types.CHAT_CHANGED, () => { pipeline.cancel(); viewer.close(); setTimeout(async () => { try { await pipeline.migrateChat(); } catch (e) { LOG('migrate failed', e); } addAllButtons(); foldAll(); drawer?.refreshGallery(); drawer?.refreshEntities(); /* role marks (official / guest) depend on the open chat */ floater?.repaint(); }, 300); });
eventSource.on(event_types.MESSAGE_DELETED, () => { drawer?.refreshGallery(); paintAllMessageButtons(); });
eventSource.on(event_types.MESSAGE_EDITED, id => { drawer?.refreshGallery(); paintAllMessageButtons(); if (settings.generate.collapseImages) setTimeout(() => foldImages(Number(id)), 50); setTimeout(() => floater?.repaint(), 60); });
eventSource.on(event_types.MESSAGE_SWIPED, id => { drawer?.refreshGallery(); paintAllMessageButtons(); if (settings.generate.collapseImages) setTimeout(() => foldImages(Number(id)), 50); setTimeout(() => floater?.repaint(), 60); });
eventSource.on(event_types.MORE_MESSAGES_LOADED, () => { addAllButtons(); foldAll(); floater?.repaint(); });

// ---- floating quick-action button (src/floater.js). Loaded AFTER the drawer through a dynamic import in
// try/catch: a broken floater must never stop index.js from evaluating (that is what removed the whole
// extension from the UI in the first attempt).
function openSettingsPanel(tab) {
    try {
        const block = document.getElementById('rm_extensions_block');
        if (block && block.offsetParent === null) document.querySelector('#extensions-settings-button .drawer-toggle')?.click();
        const wrap = document.getElementById('ifimgen_root')?.closest('.inline-drawer');
        const content = wrap?.querySelector('.inline-drawer-content');
        if (content && getComputedStyle(content).display === 'none') wrap.querySelector('.inline-drawer-toggle')?.click();
        drawer?.showTab(tab);
        setTimeout(() => wrap?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    } catch (e) { LOG('open settings failed', e); }
}
async function mountFloaterSafe() {
    try {
        const { mountFloater } = await import('./src/floater.js');
        floater = mountFloater({
            settings, save, pipeline, getContext,
            openSettings: () => openSettingsPanel('generate'),
            openGallery: () => openSettingsPanel('gallery'),
            onStylesChange: () => drawer?.refreshEntities(), // style saved / deleted / set default from the floater -> Styles tab re-reads the list
            onCollapseToggle: () => {
                settings.generate.collapseImages = !settings.generate.collapseImages; save();
                document.body.classList.toggle('ifimgen-collapse', settings.generate.collapseImages);
                if (settings.generate.collapseImages) foldImages();
                const cb = document.getElementById('ifimgen_collapse'); if (cb) cb.checked = settings.generate.collapseImages;
            },
        });
    } catch (e) { LOG('floater failed to load (extension keeps working without it)', e); }
}

// ---- slash command
getContext().SlashCommandParser?.addCommandObject?.(getContext().SlashCommand.fromProps({
    name: 'ifimgen',
    helpString: t('slash_help'),
    namedArgumentList: [
        getContext().SlashCommandNamedArgument.fromProps({ name: 'count', description: 'images', typeList: [getContext().ARGUMENT_TYPE.NUMBER], isRequired: false }),
        getContext().SlashCommandNamedArgument.fromProps({ name: 'preset', description: 'preset id', typeList: [getContext().ARGUMENT_TYPE.STRING], isRequired: false }),
    ],
    callback: async (args) => {
        const ctx = getContext();
        let id = ctx.chat.length - 1;
        while (id >= 0 && (ctx.chat[id].is_user || ctx.chat[id].is_system)) id--;
        if (id < 0) return 'no character message';
        const r = await pipeline.run(id, { force: true, count: args.count ? Number(args.count) : undefined, presetId: args.preset || undefined });
        return r.skipped ? `skipped: ${r.skipped}` : `generated ${r.generated}`;
    },
}));

// ---- drawer
jQuery(async () => {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    const wrap = document.createElement('div');
    wrap.className = 'extension_container';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>IF Image <span id="ifimgen_hdr_ver" class="ifimgen-hdr-ver">v${VERSION}</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" id="ifimgen_root"></div>
        </div>`;
    host.appendChild(wrap);
    // Version pill: when an update exists, clicking it opens GitHub without toggling the drawer.
    wrap.querySelector('#ifimgen_hdr_ver').addEventListener('click', e => {
        if (!e.currentTarget.classList.contains('update')) return;
        e.preventDefault(); e.stopPropagation(); window.open(REPO_URL, '_blank', 'noopener');
    });
    const drawerDeps = { root: wrap.querySelector('#ifimgen_root'), settings, save, backends, llm, pipeline, getContext, viewer, discordUrl: DISCORD_URL, kofiUrl: KOFI_URL };
    drawerDeps.onLanguageChange = tab => { drawer.remount(tab); paintUpdateBadge(); document.querySelectorAll('.ifimgen-fold-btn span').forEach(sp => sp.textContent = t('chat_fold_btn')); paintAllMessageButtons(); floater?.refresh(); };
    drawerDeps.onCollapseChange = on => { if (on) foldImages(); };
    drawerDeps.onShowButtonChange = on => { if (on) addAllButtons(); else removeAllButtons(); };
    drawerDeps.onAlignChange = v => applyAlign(v);
    drawerDeps.onFloaterChange = on => floater?.setEnabled(on);
    drawer = mountDrawer(drawerDeps);
    try { await pipeline.migrateChat(); } catch (e) { LOG('migrate failed', e); }
    addAllButtons();
    foldAll();
    await mountFloaterSafe();
    LOG(`v${VERSION} loaded (settings ns: ${MODULE})`);
    checkUpdate();
    setInterval(checkUpdate, 6 * 60 * 60 * 1000);
});
