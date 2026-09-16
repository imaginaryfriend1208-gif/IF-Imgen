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
import { mountFloater } from './src/floater.js';
import { createViewer, collectChatImages } from './src/gallery.js';
import { t, setLang } from './src/i18n.js';
import { compareVersions } from './src/util.js';

const VERSION = '0.10.0';
const REPO_URL = 'https://github.com/imaginaryfriend1208-gif/IF-Imgen';
const MANIFEST_URL = 'https://raw.githubusercontent.com/imaginaryfriend1208-gif/IF-Imgen/main/manifest.json';
// Direct message: Discord only links profiles by numeric user id (username diuenmii). Opens the profile -> Message.
const DISCORD_URL = 'https://discord.com/users/1148686772281278585';
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
let floater = null;
const pipeline = createPipeline({ settings, getContext, backends, llm, saveImage, save, log: LOG, onChange: id => { drawer?.refreshGallery(); if (settings.generate.collapseImages && typeof id === 'number' && id >= 0) setTimeout(() => foldImages(id), 50); } });
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
    if (i < 0) return toastr.warning('Image not found in chat data. Reload the chat.', 'IF Imgen');
    viewer.open(items, i);
}, true);

// ---- per-message button
function addMessageButton(messageId) {
    if (!settings.generate.showButton) return;
    const mes = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mes || mes.getAttribute('is_user') === 'true' || mes.getAttribute('is_system') === 'true') return;
    const bar = mes.querySelector('.extraMesButtons');
    if (!bar || bar.querySelector('.ifimgen_msg_btn')) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button ifimgen_msg_btn fa-solid fa-images';
    btn.title = 'IF Imgen: generate images for this message (again = regenerate all; Shift+click: remove images). Click an image to regenerate just that one.';
    btn.addEventListener('click', async e => {
        const id = Number(btn.closest('.mes')?.getAttribute('mesid'));
        if (e.shiftKey) return pipeline.clear(id);
        if (pipeline.isRunning(id)) return pipeline.cancel(id);
        btn.classList.replace('fa-images', 'fa-hourglass');
        try {
            const r = await pipeline.run(id, { force: true });
            if (r?.skipped) toastr.info(r.skipped, 'IF Imgen');
        } catch (err) { toastr.error(err.message, 'IF Imgen'); }
        finally { btn.classList.replace('fa-hourglass', 'fa-images'); }
    });
    bar.prepend(btn);
}

function addAllButtons() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(m => addMessageButton(Number(m.getAttribute('mesid'))));
}

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
eventSource.on(event_types.CHAT_CHANGED, () => { pipeline.cancel(); viewer.close(); setTimeout(async () => { try { await pipeline.migrateChat(); } catch (e) { LOG('migrate failed', e); } addAllButtons(); foldAll(); drawer?.refreshGallery(); }, 300); });
eventSource.on(event_types.MESSAGE_DELETED, () => drawer?.refreshGallery());
eventSource.on(event_types.MESSAGE_EDITED, id => { drawer?.refreshGallery(); if (settings.generate.collapseImages) setTimeout(() => foldImages(Number(id)), 50); });
eventSource.on(event_types.MESSAGE_SWIPED, id => { drawer?.refreshGallery(); if (settings.generate.collapseImages) setTimeout(() => foldImages(Number(id)), 50); });
eventSource.on(event_types.MORE_MESSAGES_LOADED, () => { addAllButtons(); foldAll(); });

// ---- slash command
getContext().SlashCommandParser?.addCommandObject?.(getContext().SlashCommand.fromProps({
    name: 'ifimgen',
    helpString: 'Generate IF Imgen images for the last character reply. Optional: /ifimgen count=2 preset=action_wide',
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
    const drawerDeps = { root: wrap.querySelector('#ifimgen_root'), settings, save, backends, llm, pipeline, getContext, viewer, discordUrl: DISCORD_URL };
    drawerDeps.onLanguageChange = tab => { drawer.remount(tab); paintUpdateBadge(); document.querySelectorAll('.ifimgen-fold-btn span').forEach(sp => sp.textContent = t('chat_fold_btn')); };
    drawerDeps.onCollapseChange = on => { if (on) foldImages(); };
    drawerDeps.onAlignChange = v => applyAlign(v);
    drawerDeps.onFloaterChange = on => floater?.setEnabled(on);
    drawer = mountDrawer(drawerDeps);
    // Floating quick-action button + in-chat progress (Generate -> Behaviour toggle). Mounted after the drawer; never allowed to break it.
    try {
        floater = mountFloater({
            settings, save, pipeline, getContext,
            openDrawer: tab => { drawer?.remount(tab ?? 'settings'); const c = wrap.querySelector('.inline-drawer-content'); if (c) c.style.display = 'block'; wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
            onCollapseToggle: () => { settings.generate.collapseImages = !settings.generate.collapseImages; save(); document.body.classList.toggle('ifimgen-collapse', settings.generate.collapseImages); drawer?.refresh(); },
        });
    } catch (e) { console.error('[IF Imgen] floater failed to mount', e); }
    try { await pipeline.migrateChat(); } catch (e) { LOG('migrate failed', e); }
    addAllButtons();
    foldAll();
    LOG(`v${VERSION} loaded (settings ns: ${MODULE})`);
    checkUpdate();
    setInterval(checkUpdate, 6 * 60 * 60 * 1000);
});
