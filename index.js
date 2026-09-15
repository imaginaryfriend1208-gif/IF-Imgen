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

const VERSION = '0.3.0';
const LOG = (...a) => console.log('[IF Imgen]', ...a);

const settings = ensureSettings(extension_settings);
const save = () => saveSettingsDebounced();

const backends = createBackends({ getRequestHeaders, settings });
const llm = createLlm({ settings, getContext });

async function saveImage(b64, charName) {
    const safe = String(charName || 'IF_Imgen').replace(/[^\w\- ]/g, '_');
    return saveBase64AsFile(b64, safe, `ifimgen_${Date.now()}_${Math.floor(Math.random() * 1e4)}`, 'png');
}

let drawer = null;
const pipeline = createPipeline({ settings, getContext, backends, llm, saveImage, log: LOG, onChange: () => drawer?.refreshGallery() });
const viewer = createViewer({ getContext, pipeline, onChanged: () => drawer?.refreshGallery() });

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
eventSource.on(event_types.CHAT_CHANGED, () => { pipeline.cancel(); viewer.close(); setTimeout(async () => { try { await pipeline.migrateChat(); } catch (e) { LOG('migrate failed', e); } addAllButtons(); drawer?.refreshGallery(); }, 300); });
eventSource.on(event_types.MESSAGE_DELETED, () => drawer?.refreshGallery());
eventSource.on(event_types.MESSAGE_EDITED, () => drawer?.refreshGallery());
eventSource.on(event_types.MESSAGE_SWIPED, () => drawer?.refreshGallery());
eventSource.on(event_types.MORE_MESSAGES_LOADED, addAllButtons);

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
            <div class="inline-drawer-toggle inline-drawer-header"><b>IF Imgen</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content" id="ifimgen_root"></div>
        </div>`;
    host.appendChild(wrap);
    drawer = mountDrawer({ root: wrap.querySelector('#ifimgen_root'), settings, save, backends, llm, pipeline, getContext, viewer, version: VERSION });
    try { await pipeline.migrateChat(); } catch (e) { LOG('migrate failed', e); }
    addAllButtons();
    LOG(`v${VERSION} loaded (settings ns: ${MODULE})`);
});
