// IF Imgen - drawer UI: Settings / Characters / Personas / Styles / Gallery / Generate.
import { escapeHtml, downloadJson, readFileAsText } from './util.js';
import { createEntity, upsertEntity, removeEntity, exportEntities, importEntities, LORA_POSITIONS } from './entities.js';
import { allPresets, createPreset, BUILTIN_PRESETS } from './presets.js';
import { NAI_MODELS, NAI_SAMPLERS, NAI_SCHEDULERS } from './backends.js';
import { PARAM_KEYS } from './settings.js';
import { modelParams, hasProfile } from './prompt.js';
import { ICONS, btn, fileBtn } from './icons.js';
import { mountGallery, galleryMarkup } from './gallery.js';

const ENTITY_TABS = [
    { kind: 'characters', tab: 'chars', label: 'Characters', icon: 'users', hint: 'Bind to ST character cards. Mentioned in plan via $keyword.' },
    { kind: 'personas', tab: 'personas', label: 'Personas', icon: 'user', hint: 'Your user personas. Bind to ST persona avatars.' },
    { kind: 'styles', tab: 'styles', label: 'Styles', icon: 'palette', hint: 'One style per image: bound style > keyword > default.' },
];
// Tab order: configure everything first, Generate last.
const MAIN_TABS = [
    { tab: 'settings', label: 'Settings', icon: 'settings' },
    ...ENTITY_TABS,
    { tab: 'gallery', label: 'Gallery', icon: 'images' },
    { tab: 'generate', label: 'Generate', icon: 'sparkles' },
];
const BACKENDS = [
    { id: 'sd', label: 'Comfy / A1111', icon: 'box' },
    { id: 'nai', label: 'NovelAI', icon: 'cloud' },
];

export function mountDrawer({ root, settings, save, backends, llm, pipeline, getContext, version }) {
    root.innerHTML = markup(version);
    const $ = id => root.querySelector(`#${id}`);
    const status = (id, text, cls = '') => { const n = $(id); if (!n) return; n.textContent = text; n.className = `ifimgen-status ${cls}`; };

    // ---- main tabs
    root.querySelectorAll('.ifimgen-tabs .ifimgen-btn').forEach(b => b.addEventListener('click', () => {
        root.querySelectorAll('.ifimgen-tabs .ifimgen-btn').forEach(x => x.classList.toggle('active', x === b));
        root.querySelectorAll('.ifimgen-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === b.dataset.tab));
        if (b.dataset.tab === 'gallery') gallery.refresh();
    }));

    const bind = (id, get, set, evt = 'change') => {
        const el = $(id); if (!el) return;
        if (el.type === 'checkbox') el.checked = Boolean(get()); else el.value = get() ?? '';
        el.addEventListener(evt, () => { set(el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value); save(); });
    };

    // ============================================================ Settings
    const c = settings.connection;
    let viewing = c.backend; // sub-tab currently shown (may differ from the ACTIVE backend)

    // ---- Box 1: Image API (sub-tabs + Active toggle)
    function renderBackendTabs() {
        root.querySelectorAll('.ifimgen-subtab').forEach(t => {
            t.classList.toggle('viewing', t.dataset.be === viewing);
            t.querySelector('.ifimgen-dot').classList.toggle('on', t.dataset.be === c.backend);
        });
        root.querySelectorAll('[data-backend]').forEach(b => b.style.display = b.dataset.backend === viewing ? '' : 'none');
        const act = $('ifimgen_activate');
        const isActive = c.backend === viewing;
        act.classList.toggle('active', isActive);
        act.querySelector('span').textContent = isActive ? 'Active' : 'Set active';
        act.disabled = isActive;
        $('ifimgen_model_be').textContent = BACKENDS.find(b => b.id === viewing)?.label ?? viewing;
        fillModels();
    }
    root.querySelectorAll('.ifimgen-subtab').forEach(t => t.addEventListener('click', () => { viewing = t.dataset.be; renderBackendTabs(); }));
    $('ifimgen_activate').addEventListener('click', () => { c.backend = viewing; save(); renderBackendTabs(); status('ifimgen_conn_status', `${BACKENDS.find(b => b.id === viewing).label} is now the active image API.`, 'ok'); });
    bind('ifimgen_sd_url', () => c.sd.url, v => c.sd.url = v.trim());
    bind('ifimgen_sd_auth', () => c.sd.auth, v => c.sd.auth = v.trim());
    bind('ifimgen_nai_key', () => c.nai.apiKey, v => c.nai.apiKey = v.trim());
    bind('ifimgen_nai_variety', () => c.nai.variety, v => c.nai.variety = v);
    $('ifimgen_test').addEventListener('click', async () => {
        status('ifimgen_conn_status', 'Testing…');
        try { status('ifimgen_conn_status', await backends.get(viewing).test(), 'ok'); }
        catch (e) { status('ifimgen_conn_status', e.message, 'error'); }
    });

    // ---- Box 2: model + per-model profile
    const modelSel = $('ifimgen_model');
    let editingModel = ''; // model whose params are shown in the box
    function fillModels() {
        const list = viewing === 'nai' ? NAI_MODELS : c.sd.models;
        editingModel = list.includes(editingModel) ? editingModel : (c[viewing].model || list[0] || '');
        fillSelect(modelSel, list.map(m => ({ value: m, label: `${m === c[viewing].model ? '★ ' : ''}${m}${hasProfile(settings, viewing, m) ? '' : '  (no profile)'}` })), editingModel, list.length ? null : '-- Fetch models first --');
        loadParams();
    }
    function loadParams() {
        const p = modelParams(settings, viewing, editingModel);
        const naiMode = viewing === 'nai';
        $('ifimgen_p_sampler_sd').style.display = naiMode ? 'none' : '';
        $('ifimgen_p_scheduler_sd').style.display = naiMode ? 'none' : '';
        $('ifimgen_p_sampler_nai').style.display = naiMode ? '' : 'none';
        $('ifimgen_p_scheduler_nai').style.display = naiMode ? '' : 'none';
        if (naiMode) { fillSelect($('ifimgen_p_sampler_nai'), NAI_SAMPLERS, p.sampler); fillSelect($('ifimgen_p_scheduler_nai'), NAI_SCHEDULERS, p.scheduler); }
        else { $('ifimgen_p_sampler_sd').value = p.sampler; $('ifimgen_p_scheduler_sd').value = p.scheduler; }
        for (const k of ['steps', 'cfg', 'width', 'height']) $(`ifimgen_p_${k}`).value = p[k];
        const isDefault = editingModel && editingModel === c[viewing].model;
        $('ifimgen_model_badge').style.display = isDefault ? '' : 'none';
        $('ifimgen_profile_badge').textContent = hasProfile(settings, viewing, editingModel) ? 'profile saved' : 'using fallback params';
        $('ifimgen_profile_badge').classList.toggle('active', hasProfile(settings, viewing, editingModel));
        $('ifimgen_set_default').disabled = !editingModel || isDefault;
        $('ifimgen_save_profile').disabled = !editingModel;
    }
    function readParams() {
        const naiMode = viewing === 'nai';
        return {
            sampler: naiMode ? $('ifimgen_p_sampler_nai').value : $('ifimgen_p_sampler_sd').value.trim(),
            scheduler: naiMode ? $('ifimgen_p_scheduler_nai').value : $('ifimgen_p_scheduler_sd').value.trim(),
            steps: Number($('ifimgen_p_steps').value), cfg: Number($('ifimgen_p_cfg').value),
            width: Number($('ifimgen_p_width').value), height: Number($('ifimgen_p_height').value),
        };
    }
    modelSel.addEventListener('change', () => { editingModel = modelSel.value; loadParams(); });
    $('ifimgen_fetch_models').addEventListener('click', async () => {
        status('ifimgen_model_status', 'Fetching…');
        try {
            const models = await backends.get(viewing).fetchModels();
            if (viewing === 'sd') c.sd.models = models;
            if (!c[viewing].model && models[0]) c[viewing].model = models[0];
            save(); fillModels();
            status('ifimgen_model_status', `${models.length} model(s) available.`, 'ok');
        } catch (e) { status('ifimgen_model_status', e.message, 'error'); }
    });
    $('ifimgen_save_profile').addEventListener('click', () => {
        if (!editingModel) return;
        c.profiles[viewing] ??= {};
        c.profiles[viewing][editingModel] = readParams();
        save(); fillModels();
        status('ifimgen_model_status', `Profile saved for ${editingModel}.`, 'ok');
    });
    $('ifimgen_set_default').addEventListener('click', () => {
        if (!editingModel) return;
        c[viewing].model = editingModel;
        if (!hasProfile(settings, viewing, editingModel)) { c.profiles[viewing] ??= {}; c.profiles[viewing][editingModel] = readParams(); }
        save(); fillModels();
        status('ifimgen_model_status', `${editingModel} is now the default model for ${BACKENDS.find(b => b.id === viewing).label}.`, 'ok');
    });
    renderBackendTabs();

    // ---- Box 3: LLM
    const l = c.llm;
    const showLlm = () => root.querySelectorAll('[data-llm]').forEach(b => b.style.display = b.dataset.llm === l.mode ? '' : 'none');
    bind('ifimgen_llm_mode', () => l.mode, v => { l.mode = v; showLlm(); });
    bind('ifimgen_llm_url', () => l.custom.baseUrl, v => l.custom.baseUrl = v.trim());
    bind('ifimgen_llm_key', () => l.custom.apiKey, v => l.custom.apiKey = v.trim());
    bind('ifimgen_llm_model', () => l.custom.model, v => l.custom.model = v.trim());
    bind('ifimgen_llm_maxtokens', () => l.maxTokens, v => l.maxTokens = v);
    const profSel = $('ifimgen_llm_profile');
    const profiles = llm.listProfiles();
    profSel.innerHTML = profiles.length ? profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('') : '<option value="">-- no connection profiles --</option>';
    if (profiles.some(p => p.id === l.profileId)) profSel.value = l.profileId;
    profSel.addEventListener('change', () => { l.profileId = profSel.value; save(); });
    showLlm();
    $('ifimgen_llm_test').addEventListener('click', async () => {
        status('ifimgen_llm_status', 'Asking…');
        try { const r = await llm.chat({ system: '', user: 'Reply with the single word OK.' }); status('ifimgen_llm_status', `Replied: ${r.slice(0, 80)}`, 'ok'); }
        catch (e) { status('ifimgen_llm_status', e.message, 'error'); }
    });

    // ============================================================ Generate
    const g = settings.generate;
    bind('ifimgen_enabled', () => settings.enabled, v => settings.enabled = v);
    bind('ifimgen_auto', () => g.auto, v => g.auto = v);
    bind('ifimgen_show_button', () => g.showButton, v => g.showButton = v);
    bind('ifimgen_count', () => g.imagesPerResponse, v => g.imagesPerResponse = v);
    bind('ifimgen_ctx', () => g.contextMessages, v => g.contextMessages = v);
    bind('ifimgen_dialect', () => g.dialect, v => g.dialect = v);
    bind('ifimgen_quality', () => g.qualityPrefix, v => g.qualityPrefix = v);
    bind('ifimgen_negative', () => g.negative, v => g.negative = v);
    bind('ifimgen_minchars', () => g.minParagraphChars, v => g.minParagraphChars = v);
    for (const k of ['steps', 'cfg', 'width', 'height']) bind(`ifimgen_ov_${k}`, () => g.overrides[k], v => g.overrides[k] = v);
    const frameRow = (chk, row, key) => {
        const apply = () => root.querySelector(row).classList.toggle('off', !g[key]);
        bind(chk, () => g[key], v => { g[key] = v; apply(); });
        apply();
    };
    frameRow('ifimgen_use_quality', '#ifimgen_quality_row', 'useQualityPrefix');
    frameRow('ifimgen_use_negative', '#ifimgen_negative_row', 'useNegative');

    const presetSel = $('ifimgen_preset');
    const presetText = $('ifimgen_preset_text');
    function fillPresets() {
        const list = allPresets(settings);
        fillSelect(presetSel, list.map(p => ({ value: p.id, label: p.builtin ? `★ ${p.name}` : p.name })), g.presetId);
        const cur = list.find(p => p.id === g.presetId) ?? list[0];
        presetText.value = cur?.system ?? '';
        presetText.readOnly = Boolean(cur?.builtin);
        $('ifimgen_preset_delete').disabled = Boolean(cur?.builtin);
    }
    fillPresets();
    presetSel.addEventListener('change', () => { g.presetId = presetSel.value; save(); fillPresets(); });
    presetText.addEventListener('change', () => {
        const cur = settings.data.presets.find(p => p.id === g.presetId);
        if (cur) { cur.system = presetText.value; save(); }
    });
    $('ifimgen_preset_saveas').addEventListener('click', async () => {
        const name = await getContext().callGenericPopup('Preset name:', getContext().POPUP_TYPE.INPUT, '');
        if (!name) return;
        const p = createPreset({ name: String(name), system: presetText.value });
        settings.data.presets.push(p); g.presetId = p.id; save(); fillPresets();
    });
    $('ifimgen_preset_delete').addEventListener('click', () => {
        const i = settings.data.presets.findIndex(p => p.id === g.presetId);
        if (i < 0) return;
        settings.data.presets.splice(i, 1); g.presetId = BUILTIN_PRESETS[0].id; save(); fillPresets();
    });
    $('ifimgen_preset_export').addEventListener('click', () => downloadJson('ifimgen-presets.json', { app: 'IF_Imgen', kind: 'presets', items: settings.data.presets }));
    $('ifimgen_preset_import').addEventListener('change', async e => {
        const f = e.target.files?.[0]; if (!f) return;
        try {
            const data = JSON.parse(await readFileAsText(f));
            const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
            for (const it of items) if (it?.name && it?.system) settings.data.presets.push(createPreset(it));
            save(); fillPresets(); status('ifimgen_gen_status', `Imported ${items.length} preset(s).`, 'ok');
        } catch (err) { status('ifimgen_gen_status', err.message, 'error'); }
        e.target.value = '';
    });
    $('ifimgen_run_last').addEventListener('click', async () => {
        const ctx = getContext();
        let id = ctx.chat.length - 1;
        while (id >= 0 && (ctx.chat[id].is_user || ctx.chat[id].is_system)) id--;
        if (id < 0) return status('ifimgen_gen_status', 'No character message.', 'error');
        try { const r = await pipeline.run(id, { force: true, onStatus: s => status('ifimgen_gen_status', s) }); if (r.skipped) status('ifimgen_gen_status', `Skipped: ${r.skipped}`, 'error'); }
        catch (e) { status('ifimgen_gen_status', e.message, 'error'); }
    });

    // ============================================================ Entities
    for (const t of ENTITY_TABS) mountEntityTab(t);

    function mountEntityTab({ kind, tab }) {
        const panel = root.querySelector(`[data-panel="${tab}"]`);
        const q = sel => panel.querySelector(sel);
        const list = () => settings.data[kind];
        let currentId = list()[0]?.id ?? null;
        const isStyle = kind === 'styles';

        function refreshList() {
            const sel = q('.ent-select');
            fillSelect(sel, list().map(e => ({ value: e.id, label: e.name || '(unnamed)' })), currentId, list().length ? null : '-- none --');
            q('.ent-count').textContent = `${list().length} saved`;
            const def = q('.ent-default');
            if (def) {
                const isDef = settings.defaultStyleId === currentId && currentId;
                def.classList.toggle('active', Boolean(isDef));
                def.querySelector('span').textContent = isDef ? 'Default ✓' : 'Set default';
            }
        }
        function load(e) {
            e ??= createEntity(kind);
            q('.ent-name').value = e.name; q('.ent-keyword').value = e.keyword; q('.ent-aliases').value = e.aliases.join(', ');
            q('.ent-tags').value = e.tags; q('.ent-natural').value = e.natural; q('.ent-negative').value = e.negative;
            q('.ent-loras').value = e.loras.join('\n'); q('.ent-lorapos').value = e.loraPosition;
            q('.ent-always').checked = e.bind.always;
            renderBind(e);
        }
        function renderBind(e) {
            const ctx = getContext();
            const chars = (ctx.characters ?? []).map(ch => ({ id: ch.avatar, name: ch.name }));
            const personas = Object.entries(ctx.powerUserSettings?.personas ?? {}).map(([id, name]) => ({ id, name: name || id }));
            const box = (items, key) => items.map(it => `<label><input type="checkbox" data-bind="${key}" value="${escapeHtml(it.id)}" ${e.bind[key].includes(it.id) ? 'checked' : ''}> ${escapeHtml(it.name)}</label>`).join('') || '<span class="ifimgen-note">none</span>';
            q('.ent-bind-chars').innerHTML = box(chars, 'characters');
            q('.ent-bind-personas').innerHTML = box(personas, 'personas');
        }
        function read() {
            const base = list().find(e => e.id === currentId);
            return createEntity(kind, {
                id: base?.id, name: q('.ent-name').value, keyword: q('.ent-keyword').value || q('.ent-name').value,
                aliases: q('.ent-aliases').value, tags: q('.ent-tags').value, natural: q('.ent-natural').value,
                negative: q('.ent-negative').value, loras: q('.ent-loras').value, loraPosition: q('.ent-lorapos').value,
                bind: {
                    always: q('.ent-always').checked,
                    characters: [...panel.querySelectorAll('[data-bind="characters"]:checked')].map(x => x.value),
                    personas: [...panel.querySelectorAll('[data-bind="personas"]:checked')].map(x => x.value),
                },
            });
        }
        q('.ent-select').addEventListener('change', e => { currentId = e.target.value; load(list().find(x => x.id === currentId)); refreshList(); });
        q('.ent-new').addEventListener('click', () => { currentId = null; load(null); refreshList(); });
        q('.ent-save').addEventListener('click', () => {
            const e = read();
            if (!e.name) return setStatus('Name is required.', 'error');
            const dup = list().find(x => x.keyword === e.keyword && x.id !== e.id);
            if (dup) return setStatus(`Keyword "$${e.keyword}" already used by "${dup.name}".`, 'error');
            upsertEntity(list(), e); currentId = e.id; save(); refreshList(); setStatus(`Saved "${e.name}" as $${e.keyword}.`, 'ok');
        });
        q('.ent-delete').addEventListener('click', () => {
            if (!currentId) return;
            removeEntity(list(), currentId); if (settings.defaultStyleId === currentId) settings.defaultStyleId = '';
            currentId = list()[0]?.id ?? null; save(); load(list().find(x => x.id === currentId)); refreshList(); setStatus('Deleted.', 'ok');
        });
        q('.ent-export').addEventListener('click', () => downloadJson(`ifimgen-${kind}.json`, exportEntities(kind, list())));
        q('.ent-import').addEventListener('change', async ev => {
            const f = ev.target.files?.[0]; if (!f) return;
            try {
                const r = importEntities(kind, list(), JSON.parse(await readFileAsText(f)), q('.ent-import-mode').value);
                save(); currentId = list()[0]?.id ?? null; load(list().find(x => x.id === currentId)); refreshList();
                setStatus(`Imported: +${r.added} / updated ${r.updated}${r.errors.length ? ` · ${r.errors.length} warning(s)` : ''}`, r.errors.length ? 'error' : 'ok');
            } catch (e) { setStatus(e.message, 'error'); }
            ev.target.value = '';
        });
        if (isStyle) q('.ent-default').addEventListener('click', () => { if (!currentId) return; settings.defaultStyleId = currentId; save(); refreshList(); });
        const setStatus = (t, cls) => { const n = q('.ent-status'); n.textContent = t; n.className = `ifimgen-status ${cls}`; };
        load(list().find(x => x.id === currentId)); refreshList();
    }

    // ============================================================ Gallery
    const gallery = mountGallery({ panel: root.querySelector('[data-panel="gallery"]'), getContext });

    return { refresh() { fillModels(); fillPresets(); gallery.refresh(); }, refreshGallery: () => gallery.refresh() };
}

function fillSelect(sel, items, value, emptyLabel = null) {
    if (!sel) return;
    const opts = items.map(it => typeof it === 'string' ? { value: it, label: it } : it);
    sel.innerHTML = opts.length ? opts.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('') : `<option value="">${escapeHtml(emptyLabel ?? '--')}</option>`;
    if (opts.some(o => o.value === value)) sel.value = value;
}

function numRow(id, label, min, max, step = 1) {
    return `<div class="ifimgen-row"><label for="${id}">${label}</label><input id="${id}" type="number" class="text_pole" min="${min}" max="${max}" step="${step}"></div>`;
}

const boxTitle = (icon, text, extra = '') => `<div class="ifimgen-box-title">${ICONS[icon]} ${text}${extra}</div>`;

function entityPanel({ kind, tab, label, icon, hint }) {
    const isStyle = kind === 'styles';
    return `
    <div class="ifimgen-panel" data-panel="${tab}">
        <div class="ifimgen-box">
            ${boxTitle(icon, label, '<span class="ifimgen-chip ent-count"></span>')}
            <div class="ifimgen-row"><select class="text_pole ent-select"></select>${btn({ cls: 'ent-new', icon: 'plus', label: 'New' })}</div>
            <div class="ifimgen-note">${hint}</div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('user', 'Identity')}
            <div class="ifimgen-row"><label>Name</label><input class="text_pole ent-name" type="text"></div>
            <div class="ifimgen-row"><label>Keyword ($)</label><input class="text_pole ent-keyword" type="text" placeholder="lyna → $lyna"></div>
            <div class="ifimgen-row"><label>Aliases</label><input class="text_pole ent-aliases" type="text" placeholder="comma separated"></div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('sparkles', 'Prompt fragments')}
            <div class="ifimgen-row"><label>Tags (danbooru)</label><textarea class="text_pole ent-tags"></textarea></div>
            <div class="ifimgen-row"><label>Natural description</label><textarea class="text_pole ent-natural"></textarea></div>
            <div class="ifimgen-row"><label>Negative</label><input class="text_pole ent-negative" type="text"></div>
            <div class="ifimgen-row"><label>LoRA lines</label><textarea class="text_pole ent-loras" placeholder="&lt;lora:name:0.8&gt; one per line"></textarea></div>
            <div class="ifimgen-row"><label>LoRA position</label><select class="text_pole ent-lorapos">${LORA_POSITIONS.map(p => `<option value="${p}">${p}</option>`).join('')}</select></div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('plug', 'Bind')}
            <div class="ifimgen-row"><label class="checkbox_label"><input type="checkbox" class="ent-always"> Always active (every chat)</label></div>
            <div class="ifimgen-row"><label>ST characters</label><div class="ifimgen-bind ent-bind-chars"></div></div>
            <div class="ifimgen-row"><label>ST personas</label><div class="ifimgen-bind ent-bind-personas"></div></div>
        </div>
        <div class="ifimgen-row">
            ${btn({ cls: 'ent-save primary', icon: 'save', label: 'Save' })}
            ${isStyle ? btn({ cls: 'ent-default', icon: 'star', label: 'Set default' }) : ''}
            ${btn({ cls: 'ent-delete danger', icon: 'trash', title: 'Delete' })}
            ${btn({ cls: 'ent-export', icon: 'download', title: 'Export JSON' })}
            ${fileBtn({ inputCls: 'ent-import', title: 'Import JSON' })}
            <select class="text_pole ent-import-mode" style="flex:0 0 auto;height:32px;margin:0"><option value="merge">merge</option><option value="replace">replace</option></select>
        </div>
        <div class="ifimgen-status ent-status"></div>
    </div>`;
}

function settingsPanel() {
    return `
    <div class="ifimgen-panel active" data-panel="settings">
        <div class="ifimgen-box">
            ${boxTitle('plug', '1 · Image API')}
            <div class="ifimgen-subtabs">
                ${BACKENDS.map(b => `<div class="ifimgen-subtab" data-be="${b.id}"><span class="ifimgen-dot"></span>${ICONS[b.icon]} ${b.label}</div>`).join('')}
            </div>
            <div data-backend="sd">
                <div class="ifimgen-row"><label for="ifimgen_sd_url">URL</label><input id="ifimgen_sd_url" class="text_pole" type="text" placeholder="http://127.0.0.1:7861"></div>
                <div class="ifimgen-row"><label for="ifimgen_sd_auth">Auth user:pass</label><input id="ifimgen_sd_auth" class="text_pole" type="password" autocomplete="off"></div>
                <div class="ifimgen-note">A1111-compatible endpoint (Comfy proxy / Forge / WebUI). Requests go through SillyTavern's /api/sd proxy, so no CORS needed.</div>
            </div>
            <div data-backend="nai" style="display:none">
                <div class="ifimgen-row"><label for="ifimgen_nai_key">API key (pst-…)</label><input id="ifimgen_nai_key" class="text_pole" type="password" autocomplete="off"></div>
                <div class="ifimgen-row"><label class="checkbox_label"><input id="ifimgen_nai_variety" type="checkbox"> Variety+</label></div>
            </div>
            <div class="ifimgen-row">
                ${btn({ id: 'ifimgen_activate', icon: 'power', label: 'Set active' })}
                ${btn({ id: 'ifimgen_test', icon: 'plug', label: 'Test' })}
                <span id="ifimgen_conn_status" class="ifimgen-status"></span>
            </div>
        </div>

        <div class="ifimgen-box">
            ${boxTitle('box', '2 · Model — <span id="ifimgen_model_be"></span>', '<span id="ifimgen_model_badge" class="ifimgen-chip active" style="display:none">default</span>')}
            <div class="ifimgen-row">${btn({ id: 'ifimgen_fetch_models', icon: 'refresh', title: 'Fetch models' })}<select id="ifimgen_model" class="text_pole"></select></div>
            <div class="ifimgen-grid2">
                <div class="ifimgen-row"><label>Sampler</label><input id="ifimgen_p_sampler_sd" class="text_pole" type="text"><select id="ifimgen_p_sampler_nai" class="text_pole" style="display:none"></select></div>
                <div class="ifimgen-row"><label>Scheduler</label><input id="ifimgen_p_scheduler_sd" class="text_pole" type="text"><select id="ifimgen_p_scheduler_nai" class="text_pole" style="display:none"></select></div>
                ${numRow('ifimgen_p_steps', 'Steps', 1, 150)}${numRow('ifimgen_p_cfg', 'CFG', 0, 30, 0.5)}
                ${numRow('ifimgen_p_width', 'Width', 256, 2048, 64)}${numRow('ifimgen_p_height', 'Height', 256, 2048, 64)}
            </div>
            <div class="ifimgen-row">
                ${btn({ id: 'ifimgen_save_profile', cls: 'primary', icon: 'save', label: 'Save profile' })}
                ${btn({ id: 'ifimgen_set_default', icon: 'star', label: 'Set default' })}
                <span id="ifimgen_profile_badge" class="ifimgen-chip"></span>
            </div>
            <div id="ifimgen_model_status" class="ifimgen-status"></div>
            <div class="ifimgen-note">Each model keeps its own sampler/steps/CFG/size profile. ★ = default model used for generation.</div>
        </div>

        <div class="ifimgen-box">
            ${boxTitle('brain', '3 · LLM (planner)')}
            <div class="ifimgen-row"><label for="ifimgen_llm_mode">Source</label>
                <select id="ifimgen_llm_mode" class="text_pole"><option value="st_profile">SillyTavern connection profile</option><option value="custom">Custom OpenAI-compatible</option></select></div>
            <div data-llm="st_profile" class="ifimgen-row"><label>Profile</label><select id="ifimgen_llm_profile" class="text_pole"></select></div>
            <div data-llm="custom" style="display:none">
                <div class="ifimgen-row"><label>Base URL</label><input id="ifimgen_llm_url" class="text_pole" type="text" placeholder="https://api.openai.com/v1"></div>
                <div class="ifimgen-row"><label>API key</label><input id="ifimgen_llm_key" class="text_pole" type="password" autocomplete="off"></div>
                <div class="ifimgen-row"><label>Model</label><input id="ifimgen_llm_model" class="text_pole" type="text"></div>
            </div>
            ${numRow('ifimgen_llm_maxtokens', 'Max tokens', 200, 8000, 100)}
            <div class="ifimgen-row">${btn({ id: 'ifimgen_llm_test', icon: 'plug', label: 'Test LLM' })}<span id="ifimgen_llm_status" class="ifimgen-status"></span></div>
        </div>
    </div>`;
}

function generatePanel() {
    return `
    <div class="ifimgen-panel" data-panel="generate">
        <div class="ifimgen-box">
            ${boxTitle('power', 'Behaviour')}
            <div class="ifimgen-row"><label class="checkbox_label"><input id="ifimgen_enabled" type="checkbox"> Extension enabled</label></div>
            <div class="ifimgen-row"><label class="checkbox_label"><input id="ifimgen_auto" type="checkbox"> Auto-generate on every character reply</label></div>
            <div class="ifimgen-row"><label class="checkbox_label"><input id="ifimgen_show_button" type="checkbox"> Show per-message button</label></div>
            <div class="ifimgen-grid2">
                ${numRow('ifimgen_count', 'Images per response', 1, 8)}${numRow('ifimgen_ctx', 'Context messages', 0, 20)}
                ${numRow('ifimgen_minchars', 'Min paragraph chars', 0, 500)}
                <div class="ifimgen-row"><label for="ifimgen_dialect">Prompt dialect</label><select id="ifimgen_dialect" class="text_pole"><option value="tags">Tags (danbooru)</option><option value="natural">Natural language</option></select></div>
            </div>
            <div class="ifimgen-note">The planner reads the reply as numbered paragraphs and places each image right after the paragraph it illustrates.</div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('brain', 'Planner preset')}
            <div class="ifimgen-row"><select id="ifimgen_preset" class="text_pole"></select>
                ${btn({ id: 'ifimgen_preset_saveas', icon: 'save', title: 'Save as…' })}
                ${btn({ id: 'ifimgen_preset_delete', cls: 'danger', icon: 'trash', title: 'Delete preset' })}
                ${btn({ id: 'ifimgen_preset_export', icon: 'download', title: 'Export presets' })}
                ${fileBtn({ inputId: 'ifimgen_preset_import', title: 'Import presets' })}</div>
            <textarea id="ifimgen_preset_text" class="text_pole" rows="8"></textarea>
            <div class="ifimgen-note">Built-in (★) presets are read-only — use “Save as…” to fork. Placeholders: {{count}}, {{dialect_rule}}.</div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('sparkles', 'Prompt frame')}
            <div class="ifimgen-row" id="ifimgen_quality_row"><label class="ifimgen-toggle"><input id="ifimgen_use_quality" type="checkbox"> Quality prefix</label><input id="ifimgen_quality" class="text_pole" type="text"></div>
            <div class="ifimgen-row" id="ifimgen_negative_row"><label class="ifimgen-toggle"><input id="ifimgen_use_negative" type="checkbox"> Negative</label><textarea id="ifimgen_negative" class="text_pole"></textarea></div>
            <div class="ifimgen-note">Untick Negative for models that ignore it (e.g. Krea); entity negatives are skipped as well.</div>
            <h4>Overrides (0 = use model profile)</h4>
            <div class="ifimgen-grid2">${numRow('ifimgen_ov_steps', 'Steps', 0, 150)}${numRow('ifimgen_ov_cfg', 'CFG', 0, 30, 0.5)}${numRow('ifimgen_ov_width', 'Width', 0, 2048, 64)}${numRow('ifimgen_ov_height', 'Height', 0, 2048, 64)}</div>
        </div>
        <div class="ifimgen-row">${btn({ id: 'ifimgen_run_last', cls: 'primary', icon: 'play', label: 'Generate for last reply' })}<span id="ifimgen_gen_status" class="ifimgen-status"></span></div>
    </div>`;
}

function markup(version) {
    return `
    <div class="ifimgen">
        <div class="ifimgen-title"><h3>IF Imgen</h3><small>v${escapeHtml(version)}</small></div>
        <div class="ifimgen-tabs">
            ${MAIN_TABS.map((t, i) => btn({ cls: i === 0 ? 'active' : '', icon: t.icon, label: t.label, attrs: `data-tab="${t.tab}"` })).join('')}
        </div>
        ${settingsPanel()}
        ${ENTITY_TABS.map(entityPanel).join('')}
        ${galleryMarkup()}
        ${generatePanel()}
    </div>`;
}
