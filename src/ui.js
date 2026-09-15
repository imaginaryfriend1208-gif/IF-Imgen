// IF Imgen - drawer UI: Settings / Characters / Personas / Styles / Gallery / How to use / Generate.
import { escapeHtml, downloadJson, readFileAsText } from './util.js';
import { createEntity, upsertEntity, removeEntity, exportEntities, importEntities, LORA_POSITIONS } from './entities.js';
import { allPresets, createPreset, BUILTIN_PRESETS } from './presets.js';
import { NAI_MODELS, NAI_SAMPLERS, NAI_SCHEDULERS } from './backends.js';
import { modelParams, hasProfile } from './prompt.js';
import { ICONS, btn, fileBtn } from './icons.js';
import { mountGallery, galleryMarkup } from './gallery.js';
import { facetsText, FACET_KEYS, DEFAULT_REFINE_SYSTEM } from './scene.js';
import { t, setLang, getLang, LANGS, FLAGS } from './i18n.js';

// Labels are resolved at render time (t()) so the language switch re-renders everything.
const ENTITY_TABS = () => [
    { kind: 'characters', tab: 'chars', label: t('tab_chars'), icon: 'users', hint: t('hint_chars') },
    { kind: 'personas', tab: 'personas', label: t('tab_personas'), icon: 'user', hint: t('hint_personas') },
    { kind: 'styles', tab: 'styles', label: t('tab_styles'), icon: 'palette', hint: t('hint_styles') },
];
// Tab order: configure everything first, Generate last.
const MAIN_TABS = () => [
    { tab: 'settings', label: t('tab_settings'), icon: 'settings' },
    ...ENTITY_TABS(),
    { tab: 'gallery', label: t('tab_gallery'), icon: 'images' },
    { tab: 'help', label: t('tab_help'), icon: 'help' },
    { tab: 'generate', label: t('tab_generate'), icon: 'sparkles' },
];
const BACKENDS = [
    { id: 'sd', label: 'Comfy / A1111', icon: 'box' },
    { id: 'nai', label: 'NovelAI', icon: 'cloud' },
];

/**
 * Mount the drawer. Switching language re-runs the whole mount (cheap: it is just
 * markup + listeners) and keeps the currently open tab.
 */
export function mountDrawer(deps) {
    setLang(deps.settings.language);
    let api = mountOnce(deps, 'settings');
    // Proxy so index.js keeps a stable handle across re-mounts.
    return {
        refresh: () => api.refresh(),
        refreshGallery: () => api.refreshGallery(),
        remount(tab) { api = mountOnce(deps, tab); },
    };
}

function mountOnce({ root, settings, save, backends, llm, pipeline, getContext, viewer, version, onLanguageChange, onCollapseChange }, openTab) {
    root.innerHTML = markup(version);
    const $ = id => root.querySelector(`#${id}`);
    const status = (id, text, cls = '') => { const n = $(id); if (!n) return; n.textContent = text; n.className = `ifimgen-status ${cls}`; };

    // ---- main tabs
    const showTab = tab => {
        root.querySelectorAll('.ifimgen-tabs .ifimgen-btn').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
        root.querySelectorAll('.ifimgen-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
        if (tab === 'gallery') gallery.refresh();
    };
    root.querySelectorAll('.ifimgen-tabs .ifimgen-btn').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

    // ---- language flags
    root.querySelectorAll('.ifimgen-lang [data-lang]').forEach(b => b.addEventListener('click', () => {
        const lang = b.dataset.lang;
        if (lang === getLang()) return;
        settings.language = lang; save(); setLang(lang);
        const cur = root.querySelector('.ifimgen-tabs .ifimgen-btn.active')?.dataset.tab || 'settings';
        onLanguageChange?.(cur);
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
        root.querySelectorAll('.ifimgen-subtab').forEach(tab => {
            tab.classList.toggle('viewing', tab.dataset.be === viewing);
            tab.querySelector('.ifimgen-dot').classList.toggle('on', tab.dataset.be === c.backend);
        });
        root.querySelectorAll('[data-backend]').forEach(b => b.style.display = b.dataset.backend === viewing ? '' : 'none');
        const act = $('ifimgen_activate');
        const isActive = c.backend === viewing;
        act.classList.toggle('active', isActive);
        act.querySelector('span').textContent = isActive ? t('st_active') : t('btn_set_active');
        act.disabled = isActive;
        $('ifimgen_model_be').textContent = BACKENDS.find(b => b.id === viewing)?.label ?? viewing;
        fillModels();
    }
    root.querySelectorAll('.ifimgen-subtab').forEach(tab => tab.addEventListener('click', () => { viewing = tab.dataset.be; renderBackendTabs(); }));
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
        // Always include the current default model, even before "Fetch models" (e.g. right after migration).
        const list = [...new Set([...(viewing === 'nai' ? NAI_MODELS : c.sd.models), c[viewing].model].filter(Boolean))];
        editingModel = list.includes(editingModel) ? editingModel : (c[viewing].model || list[0] || '');
        fillSelect(modelSel, list.map(m => ({ value: m, label: `${m === c[viewing].model ? '★ ' : ''}${m}${hasProfile(settings, viewing, m) ? '' : `  ${t('st_no_profile')}`}` })), editingModel, list.length ? null : t('st_fetch_first'));
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
        $('ifimgen_profile_badge').textContent = hasProfile(settings, viewing, editingModel) ? t('chip_profile_saved') : t('chip_fallback');
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
    profSel.innerHTML = profiles.length ? profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('') : `<option value="">${t('st_no_profiles')}</option>`;
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
    bind('ifimgen_collapse', () => g.collapseImages, v => { g.collapseImages = v; document.body.classList.toggle('ifimgen-collapse', v); onCollapseChange?.(v); });
    document.body.classList.toggle('ifimgen-collapse', Boolean(g.collapseImages));
    bind('ifimgen_count', () => g.imagesPerResponse, v => g.imagesPerResponse = v);
    bind('ifimgen_ctx', () => g.contextMessages, v => g.contextMessages = v);
    bind('ifimgen_dialect', () => g.dialect, v => g.dialect = v);
    const showMode = () => root.querySelectorAll('[data-mode]').forEach(b => b.style.display = b.dataset.mode === g.mode ? '' : 'none');
    bind('ifimgen_mode', () => g.mode, v => { g.mode = v; showMode(); });
    bind('ifimgen_refine_system', () => g.refineSystem, v => g.refineSystem = v);
    $('ifimgen_refine_reset').addEventListener('click', () => { g.refineSystem = DEFAULT_REFINE_SYSTEM; $('ifimgen_refine_system').value = g.refineSystem; save(); });
    showMode();
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

    // ---- Prompt preview & test: Compile -> Key / Prompt 1-call / Prompt 2-call, each with its own Generate.
    const pvScene = $('ifimgen_preview_scene');
    const pvOut = $('ifimgen_preview_result');
    let pvNegative = { plan: '', refine: '' };
    pvScene.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('ifimgen_preview').click(); });
    $('ifimgen_preview').addEventListener('click', async () => {
        const scene = pvScene.value.trim() || '$keyword does something in a place';
        pvOut.style.display = '';
        status('ifimgen_preview_status', t('pv_compiling_llm'));
        $('ifimgen_pv_key').textContent = '';
        $('ifimgen_pv_p1').value = ''; $('ifimgen_pv_p2').value = '';
        try {
            const r = await pipeline.compileBoth(scene);
            const key = [
                `[${t('pv_chars')}] ${r.ents.characters.map(e => `${e.name} ($${e.keyword})`).join(', ') || '-'}`,
                `[${t('pv_personas')}] ${r.ents.personas.map(e => `${e.name} ($${e.keyword})`).join(', ') || '-'}`,
                `[${t('pv_style')}] ${r.ents.style?.name ?? '-'}`,
                r.unknown.length ? `[${t('pv_unresolved')}] ${r.unknown.join(' ')}` : '',
                '', `${t('pv_expanded')}:`, r.expanded,
                '', `${t('pv_negative')}:`, r.plan.negative || t('pv_disabled'),
            ].filter(x => x !== undefined).join('\n');
            $('ifimgen_pv_key').textContent = key;
            $('ifimgen_pv_p1').value = r.plan.prompt;
            $('ifimgen_pv_p2').value = r.refine?.error ? `Error: ${r.refine.error}` : (r.refine?.prompt ?? '');
            $('ifimgen_pv_gen2').disabled = Boolean(r.refine?.error);
            pvNegative = { plan: r.plan.negative, refine: r.refine?.negative ?? r.plan.negative };
            status('ifimgen_preview_status', '');
        } catch (e) { status('ifimgen_preview_status', `Error: ${e.message}`, 'error'); }
    });
    const genTest = async (mode, ta, btnEl) => {
        const prompt = ta.value.trim();
        if (!prompt || prompt.startsWith('Error:')) return;
        btnEl.disabled = true;
        try {
            await pipeline.runTest({ prompt, negative: pvNegative[mode], scene: pvScene.value.trim(), mode, onStatus: s => status('ifimgen_preview_status', s) });
            status('ifimgen_preview_status', t('st_test_done'), 'ok');
            gallery.refresh();
        } catch (e) { status('ifimgen_preview_status', e.message, 'error'); }
        finally { btnEl.disabled = false; }
    };
    $('ifimgen_pv_gen1').addEventListener('click', e => genTest('plan', $('ifimgen_pv_p1'), e.currentTarget));
    $('ifimgen_pv_gen2').addEventListener('click', e => genTest('refine', $('ifimgen_pv_p2'), e.currentTarget));

    // ---- run / regen for last reply
    const lastCharMessage = () => {
        const ctx = getContext();
        let id = ctx.chat.length - 1;
        while (id >= 0 && (ctx.chat[id].is_user || ctx.chat[id].is_system)) id--;
        return id;
    };
    $('ifimgen_run_last').addEventListener('click', async () => {
        const id = lastCharMessage();
        if (id < 0) return status('ifimgen_gen_status', t('st_no_char_msg'), 'error');
        try { const r = await pipeline.run(id, { force: true, onStatus: s => status('ifimgen_gen_status', s) }); if (r.skipped) status('ifimgen_gen_status', `${t('st_skipped')}: ${r.skipped}`, 'error'); }
        catch (e) { status('ifimgen_gen_status', e.message, 'error'); }
    });
    $('ifimgen_regen_last').addEventListener('click', async () => {
        const id = lastCharMessage();
        if (id < 0) return status('ifimgen_gen_status', t('st_no_char_msg'), 'error');
        try {
            const r = await pipeline.regenerateAll(id, { onStatus: s => status('ifimgen_gen_status', `${t('st_regen')} ${s}`) });
            if (r.none) return status('ifimgen_gen_status', t('st_no_images'), 'error');
            status('ifimgen_gen_status', `${t('st_done')} ${r.regenerated}${r.skipped ? ` (+${r.skipped} skipped: no stored scene)` : ''}`, 'ok');
        } catch (e) { status('ifimgen_gen_status', e.message, 'error'); }
    });

    // ============================================================ Entities
    for (const tab of ENTITY_TABS()) mountEntityTab(tab);

    function mountEntityTab({ kind, tab }) {
        const panel = root.querySelector(`[data-panel="${tab}"]`);
        const q = sel => panel.querySelector(sel);
        const list = () => settings.data[kind];
        let currentId = list()[0]?.id ?? null;
        const isStyle = kind === 'styles';

        function refreshList() {
            const sel = q('.ent-select');
            fillSelect(sel, list().map(e => ({ value: e.id, label: (isStyle && e.id === settings.defaultStyleId ? '★ ' : '') + (e.name || '(unnamed)') })), currentId, list().length ? null : t('st_none_opt'));
            q('.ent-count').textContent = t('st_saved_count', { n: list().length });
            const def = q('.ent-default');
            if (def) {
                const isDef = settings.defaultStyleId === currentId && currentId;
                def.classList.toggle('active', Boolean(isDef));
                def.querySelector('span').textContent = isDef ? t('btn_default_on') : t('btn_set_default');
            }
        }
        function load(e) {
            e ??= createEntity(kind);
            q('.ent-name').value = e.name;
            q('.ent-tags').value = e.tags; q('.ent-natural').value = e.natural; q('.ent-negative').value = e.negative;
            q('.ent-loras').value = e.loras.join('\n'); q('.ent-lorapos').value = e.loraPosition;
            if (isStyle) return;
            q('.ent-keyword').value = e.keyword; q('.ent-aliases').value = e.aliases.join(', ');
            q('.ent-facets').value = facetsText(e.facets);
            q('.ent-always').checked = e.bind.always;
            renderBind(e);
        }
        // Working copy of the binding lists while editing (committed on Save).
        let bindState = { chats: [], characters: [], personas: [] };
        const currentChatId = () => { const ctx = getContext(); return String((typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId) ?? ''); };
        // Only identifiers + display names are taken from ST here (avatar filename, card name, persona key).
        const cardList = () => (getContext().characters ?? []).map(ch => ({ id: ch.avatar, name: ch.name || ch.avatar }));
        const personaList = () => Object.entries(getContext().powerUserSettings?.personas ?? {}).map(([id, name]) => ({ id, name: name || id }));
        function renderBind(e) {
            if (e) bindState = { chats: [...e.bind.chats], characters: [...e.bind.characters], personas: [...e.bind.personas] };
            const chatId = currentChatId();
            const boundHere = Boolean(chatId) && bindState.chats.includes(chatId);
            q('.ent-bind-chat-name').textContent = chatId ? `${boundHere ? t('st_bound_to') : t('st_not_bound_to')}: ${chatId}${bindState.chats.length > 1 || (bindState.chats.length === 1 && !boundHere) ? ` (+${bindState.chats.length - (boundHere ? 1 : 0)})` : ''}` : t('st_no_chat');
            const tog = q('.ent-bind-chat-toggle');
            tog.classList.toggle('active', boundHere);
            tog.querySelector('span').textContent = boundHere ? t('btn_unbind_chat') : t('btn_bind_chat');
            tog.disabled = !chatId;
            const chips = (ids, all, key) => ids.map(id => `<span class="ifimgen-chip bound" title="${escapeHtml(id)}">${escapeHtml(all.find(x => x.id === id)?.name ?? id)}<span class="ifimgen-chip-x" data-unbind="${key}" data-id="${escapeHtml(id)}">&times;</span></span>`).join('') || `<span class="ifimgen-note">${t('st_none')}</span>`;
            const cards = cardList(), pers = personaList();
            q('.ent-bind-chars').innerHTML = chips(bindState.characters, cards, 'characters');
            q('.ent-bind-personas').innerHTML = chips(bindState.personas, pers, 'personas');
            fillSelect(q('.ent-bind-char-select'), cards.filter(x => !bindState.characters.includes(x.id)).map(x => ({ value: x.id, label: x.name })), '', t('st_all_cards'));
            fillSelect(q('.ent-bind-persona-select'), pers.filter(p => !bindState.personas.includes(p.id)).map(p => ({ value: p.id, label: p.name })), '', t('st_none_opt'));
        }
        if (!isStyle) {
            q('.ent-bind-chat-toggle').addEventListener('click', () => {
                const id = currentChatId(); if (!id) return;
                bindState.chats = bindState.chats.includes(id) ? bindState.chats.filter(x => x !== id) : [...bindState.chats, id];
                renderBind(null);
            });
            q('.ent-bind-char-add').addEventListener('click', () => { const v = q('.ent-bind-char-select').value; if (v && !bindState.characters.includes(v)) { bindState.characters.push(v); renderBind(null); } });
            q('.ent-bind-persona-add').addEventListener('click', () => { const v = q('.ent-bind-persona-select').value; if (v && !bindState.personas.includes(v)) { bindState.personas.push(v); renderBind(null); } });
            panel.addEventListener('click', ev => {
                const x = ev.target.closest('[data-unbind]'); if (!x) return;
                const key = x.dataset.unbind; bindState[key] = bindState[key].filter(id => id !== x.dataset.id); renderBind(null);
            });
        }
        function read() {
            const base = list().find(e => e.id === currentId);
            if (isStyle) {
                return createEntity(kind, {
                    id: base?.id, name: q('.ent-name').value, keyword: base?.keyword || q('.ent-name').value,
                    tags: q('.ent-tags').value, natural: q('.ent-natural').value, negative: q('.ent-negative').value,
                    loras: q('.ent-loras').value, loraPosition: q('.ent-lorapos').value,
                });
            }
            return createEntity(kind, {
                id: base?.id, name: q('.ent-name').value, keyword: q('.ent-keyword').value || q('.ent-name').value,
                aliases: q('.ent-aliases').value, tags: q('.ent-tags').value, natural: q('.ent-natural').value,
                negative: q('.ent-negative').value, facets: q('.ent-facets').value, loras: q('.ent-loras').value, loraPosition: q('.ent-lorapos').value,
                bind: { always: q('.ent-always').checked, chats: [...bindState.chats], characters: [...bindState.characters], personas: [...bindState.personas] },
            });
        }
        q('.ent-select').addEventListener('change', e => { currentId = e.target.value; load(list().find(x => x.id === currentId)); refreshList(); });
        q('.ent-new').addEventListener('click', () => { currentId = null; load(null); refreshList(); });
        q('.ent-save').addEventListener('click', () => {
            const e = read();
            if (!e.name) return setStatus('Name is required.', 'error');
            if (!isStyle) {
                const dup = list().find(x => x.keyword === e.keyword && x.id !== e.id);
                if (dup) return setStatus(`Keyword "${e.keyword}" already used by "${dup.name}".`, 'error');
            }
            upsertEntity(list(), e); currentId = e.id;
            if (isStyle && !list().some(x => x.id === settings.defaultStyleId)) settings.defaultStyleId = e.id;
            save(); refreshList();
            const empty = !e.tags && !e.natural && !e.loras.length;
            const label = isStyle ? `Saved style "${e.name}"${settings.defaultStyleId === e.id ? ' (default)' : ''}.` : `Saved "${e.name}" as $${e.keyword}.`;
            setStatus(`${label}${empty ? ' Warning: no tags / natural description / LoRA — this entry adds nothing to the prompt.' : ''}`, empty ? 'error' : 'ok');
        });
        q('.ent-delete').addEventListener('click', () => {
            if (!currentId) return;
            removeEntity(list(), currentId); if (settings.defaultStyleId === currentId) settings.defaultStyleId = list()[0]?.id ?? '';
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
        if (isStyle) q('.ent-default').addEventListener('click', () => { if (!currentId) return setStatus('Save the style first.', 'error'); settings.defaultStyleId = currentId; save(); refreshList(); setStatus('This style is now the default for every image.', 'ok'); });
        const setStatus = (text, cls) => { const n = q('.ent-status'); n.textContent = text; n.className = `ifimgen-status ${cls}`; };
        load(list().find(x => x.id === currentId)); refreshList();
    }

    // ============================================================ Gallery
    const gallery = mountGallery({ panel: root.querySelector('[data-panel="gallery"]'), getContext, viewer, pipeline });

    showTab(openTab);
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
    if (isStyle) return stylePanel({ tab, label, icon, hint });
    return `
    <div class="ifimgen-panel" data-panel="${tab}">
        <div class="ifimgen-box">
            ${boxTitle(icon, label, '<span class="ifimgen-chip ent-count"></span>')}
            <div class="ifimgen-row"><select class="text_pole ent-select"></select>${btn({ cls: 'ent-new', icon: 'plus', label: t('btn_new') })}</div>
            <div class="ifimgen-note">${hint}</div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('user', t('box_identity'))}
            <div class="ifimgen-row"><label>${t('lbl_name')}</label><input class="text_pole ent-name" type="text"></div>
            <div class="ifimgen-row"><label>${t('lbl_keyword')}</label><input class="text_pole ent-keyword" type="text" placeholder="lyna → $lyna"></div>
            <div class="ifimgen-row"><label>${t('lbl_aliases')}</label><input class="text_pole ent-aliases" type="text" placeholder="${escapeHtml(t('ph_aliases'))}"></div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('sparkles', t('box_fragments'))}
            <div class="ifimgen-row"><label>${t('lbl_tags')}</label><textarea class="text_pole ent-tags"></textarea></div>
            <div class="ifimgen-row"><label>${t('lbl_natural')}</label><textarea class="text_pole ent-natural"></textarea></div>
            <div class="ifimgen-row"><label>${t('lbl_negative')}</label><input class="text_pole ent-negative" type="text"></div>
            <div class="ifimgen-row"><label>${t('lbl_details')}</label><textarea class="text_pole ent-facets" rows="5" placeholder="${escapeHtml(t('ph_details')).replaceAll('\n', '&#10;')}"></textarea></div>
            <div class="ifimgen-note">${t('note_details', { keys: FACET_KEYS.join(', ') })}</div>
            <div class="ifimgen-row"><label>${t('lbl_loras')}</label><textarea class="text_pole ent-loras" placeholder="${escapeHtml(t('ph_loras'))}"></textarea></div>
            <div class="ifimgen-row"><label>${t('lbl_lorapos')}</label><select class="text_pole ent-lorapos">${LORA_POSITIONS.map(p => `<option value="${p}">${p}</option>`).join('')}</select></div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('plug', t('box_bind'))}
            <div class="ifimgen-note">${t('note_bind')}</div>
            <div class="ifimgen-row"><label>${t('lbl_this_chat')}</label>
                <div class="ifimgen-bind-cur"><span class="ent-bind-chat-name ifimgen-note"></span>${btn({ cls: 'ent-bind-chat-toggle', icon: 'plug', label: t('btn_bind_chat') })}</div></div>
            <div class="ifimgen-row"><label>${t('lbl_cards')}</label>
                <div class="ifimgen-bind-pick"><select class="text_pole ent-bind-char-select"></select>${btn({ cls: 'ent-bind-char-add', icon: 'plus', title: t('btn_add_card') })}</div></div>
            <div class="ifimgen-row"><label></label><div class="ifimgen-list ent-bind-chars"></div></div>
            <div class="ifimgen-row"><label>${t('lbl_st_personas')}</label>
                <div class="ifimgen-bind-pick"><select class="text_pole ent-bind-persona-select"></select>${btn({ cls: 'ent-bind-persona-add', icon: 'plus', title: t('btn_add_persona') })}</div></div>
            <div class="ifimgen-row"><label></label><div class="ifimgen-list ent-bind-personas"></div></div>
            <div class="ifimgen-row"><label class="checkbox_label"><input type="checkbox" class="ent-always"> ${t('lbl_always')}</label></div>
        </div>
        <div class="ifimgen-row">
            ${btn({ cls: 'ent-save primary', icon: 'save', label: t('btn_save') })}
            ${btn({ cls: 'ent-delete danger', icon: 'trash', title: t('btn_delete') })}
            ${btn({ cls: 'ent-export', icon: 'download', title: t('btn_export_json') })}
            ${fileBtn({ inputCls: 'ent-import', title: t('btn_import_json') })}
            <select class="text_pole ent-import-mode" style="flex:0 0 auto;height:32px;margin:0"><option value="merge">${t('opt_merge')}</option><option value="replace">${t('opt_replace')}</option></select>
        </div>
        <div class="ifimgen-status ent-status"></div>
    </div>`;
}

function settingsPanel() {
    return `
    <div class="ifimgen-panel" data-panel="settings">
        <div class="ifimgen-box">
            ${boxTitle('plug', t('box_api'))}
            <div class="ifimgen-subtabs">
                ${BACKENDS.map(b => `<div class="ifimgen-subtab" data-be="${b.id}"><span class="ifimgen-dot"></span>${ICONS[b.icon]} ${b.label}</div>`).join('')}
            </div>
            <div data-backend="sd">
                <div class="ifimgen-row"><label for="ifimgen_sd_url">${t('lbl_url')}</label><input id="ifimgen_sd_url" class="text_pole" type="text" placeholder="http://127.0.0.1:7861"></div>
                <div class="ifimgen-row"><label for="ifimgen_sd_auth">${t('lbl_auth')}</label><input id="ifimgen_sd_auth" class="text_pole" type="password" autocomplete="off"></div>
                <div class="ifimgen-note">${t('note_sd')}</div>
            </div>
            <div data-backend="nai" style="display:none">
                <div class="ifimgen-row"><label for="ifimgen_nai_key">${t('lbl_nai_key')}</label><input id="ifimgen_nai_key" class="text_pole" type="password" autocomplete="off"></div>
                <div class="ifimgen-row"><label class="checkbox_label"><input id="ifimgen_nai_variety" type="checkbox"> ${t('lbl_variety')}</label></div>
            </div>
            <div class="ifimgen-row">
                ${btn({ id: 'ifimgen_activate', icon: 'power', label: t('btn_set_active') })}
                ${btn({ id: 'ifimgen_test', icon: 'plug', label: t('btn_test') })}
                <span id="ifimgen_conn_status" class="ifimgen-status"></span>
            </div>
        </div>

        <div class="ifimgen-box">
            ${boxTitle('box', `${t('box_model')} — <span id="ifimgen_model_be"></span>`, `<span id="ifimgen_model_badge" class="ifimgen-chip active" style="display:none">${t('chip_default')}</span>`)}
            <div class="ifimgen-row">${btn({ id: 'ifimgen_fetch_models', icon: 'refresh', title: t('btn_fetch_models') })}<select id="ifimgen_model" class="text_pole"></select></div>
            <div class="ifimgen-grid2">
                <div class="ifimgen-row"><label>${t('lbl_sampler')}</label><input id="ifimgen_p_sampler_sd" class="text_pole" type="text"><select id="ifimgen_p_sampler_nai" class="text_pole" style="display:none"></select></div>
                <div class="ifimgen-row"><label>${t('lbl_scheduler')}</label><input id="ifimgen_p_scheduler_sd" class="text_pole" type="text"><select id="ifimgen_p_scheduler_nai" class="text_pole" style="display:none"></select></div>
                ${numRow('ifimgen_p_steps', t('lbl_steps'), 1, 150)}${numRow('ifimgen_p_cfg', t('lbl_cfg'), 0, 30, 0.5)}
                ${numRow('ifimgen_p_width', t('lbl_width'), 256, 2048, 64)}${numRow('ifimgen_p_height', t('lbl_height'), 256, 2048, 64)}
            </div>
            <div class="ifimgen-row">
                ${btn({ id: 'ifimgen_save_profile', cls: 'primary', icon: 'save', label: t('btn_save_profile') })}
                ${btn({ id: 'ifimgen_set_default', icon: 'star', label: t('btn_set_default') })}
                <span id="ifimgen_profile_badge" class="ifimgen-chip"></span>
            </div>
            <div id="ifimgen_model_status" class="ifimgen-status"></div>
            <div class="ifimgen-note">${t('note_model')}</div>
        </div>

        <div class="ifimgen-box">
            ${boxTitle('brain', t('box_llm'))}
            <div class="ifimgen-row"><label for="ifimgen_llm_mode">${t('lbl_source')}</label>
                <select id="ifimgen_llm_mode" class="text_pole"><option value="st_profile">${t('opt_st_profile')}</option><option value="custom">${t('opt_custom')}</option></select></div>
            <div data-llm="st_profile" class="ifimgen-row"><label>${t('lbl_profile')}</label><select id="ifimgen_llm_profile" class="text_pole"></select></div>
            <div data-llm="custom" style="display:none">
                <div class="ifimgen-row"><label>${t('lbl_base_url')}</label><input id="ifimgen_llm_url" class="text_pole" type="text" placeholder="https://api.openai.com/v1"></div>
                <div class="ifimgen-row"><label>${t('lbl_api_key')}</label><input id="ifimgen_llm_key" class="text_pole" type="password" autocomplete="off"></div>
                <div class="ifimgen-row"><label>${t('lbl_model')}</label><input id="ifimgen_llm_model" class="text_pole" type="text"></div>
            </div>
            ${numRow('ifimgen_llm_maxtokens', t('lbl_max_tokens'), 200, 8000, 100)}
            <div class="ifimgen-row">${btn({ id: 'ifimgen_llm_test', icon: 'plug', label: t('btn_test_llm') })}<span id="ifimgen_llm_status" class="ifimgen-status"></span></div>
        </div>
    </div>`;
}

function generatePanel() {
    return `
    <div class="ifimgen-panel" data-panel="generate">
        <div class="ifimgen-box">
            ${boxTitle('power', t('box_behaviour'))}
            <div class="ifimgen-row"><label class="checkbox_label"><input id="ifimgen_enabled" type="checkbox"> ${t('lbl_enabled')}</label></div>
            <div class="ifimgen-row"><label class="checkbox_label"><input id="ifimgen_auto" type="checkbox"> ${t('lbl_auto')}</label></div>
            <div class="ifimgen-row"><label class="checkbox_label"><input id="ifimgen_show_button" type="checkbox"> ${t('lbl_show_button')}</label></div>
            <div class="ifimgen-row"><label class="checkbox_label"><input id="ifimgen_collapse" type="checkbox"> ${t('lbl_collapse')}</label></div>
            <div class="ifimgen-grid2">
                ${numRow('ifimgen_count', t('lbl_count'), 1, 8)}${numRow('ifimgen_ctx', t('lbl_ctx'), 0, 20)}
                ${numRow('ifimgen_minchars', t('lbl_minchars'), 0, 500)}
                <div class="ifimgen-row"><label for="ifimgen_dialect">${t('lbl_dialect')}</label><select id="ifimgen_dialect" class="text_pole"><option value="tags">${t('opt_tags')}</option><option value="natural">${t('opt_natural')}</option></select></div>
            </div>
            <div class="ifimgen-note">${t('note_behaviour')}</div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('brain', t('box_calls'))}
            <div class="ifimgen-row"><label for="ifimgen_mode">${t('lbl_mode')}</label>
                <select id="ifimgen_mode" class="text_pole">
                    <option value="plan">${t('opt_mode_plan')}</option>
                    <option value="refine">${t('opt_mode_refine')}</option>
                </select></div>
            <div data-mode="refine" style="display:none">
                <div class="ifimgen-row"><label>${t('lbl_refine_system')}</label>${btn({ id: 'ifimgen_refine_reset', icon: 'refresh', title: t('btn_reset_default') })}</div>
                <textarea id="ifimgen_refine_system" class="text_pole" rows="7"></textarea>
                <div class="ifimgen-note">${t('note_refine')}</div>
            </div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('brain', t('box_preset'))}
            <div class="ifimgen-row"><select id="ifimgen_preset" class="text_pole"></select>
                ${btn({ id: 'ifimgen_preset_saveas', icon: 'save', title: t('btn_save_as') })}
                ${btn({ id: 'ifimgen_preset_delete', cls: 'danger', icon: 'trash', title: t('btn_delete_preset') })}
                ${btn({ id: 'ifimgen_preset_export', icon: 'download', title: t('btn_export_presets') })}
                ${fileBtn({ inputId: 'ifimgen_preset_import', title: t('btn_import_presets') })}</div>
            <textarea id="ifimgen_preset_text" class="text_pole" rows="8"></textarea>
            <div class="ifimgen-note">${t('note_preset')}</div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('sparkles', t('box_frame'))}
            <div class="ifimgen-row" id="ifimgen_quality_row"><label class="ifimgen-toggle"><input id="ifimgen_use_quality" type="checkbox"> ${t('lbl_quality')}</label><input id="ifimgen_quality" class="text_pole" type="text"></div>
            <div class="ifimgen-row" id="ifimgen_negative_row"><label class="ifimgen-toggle"><input id="ifimgen_use_negative" type="checkbox"> ${t('lbl_negative')}</label><textarea id="ifimgen_negative" class="text_pole"></textarea></div>
            <div class="ifimgen-note">${t('note_negative')}</div>
            <h4>${t('h_overrides')}</h4>
            <div class="ifimgen-grid2">${numRow('ifimgen_ov_steps', t('lbl_steps'), 0, 150)}${numRow('ifimgen_ov_cfg', t('lbl_cfg'), 0, 30, 0.5)}${numRow('ifimgen_ov_width', t('lbl_width'), 0, 2048, 64)}${numRow('ifimgen_ov_height', t('lbl_height'), 0, 2048, 64)}</div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('locate', t('box_preview'))}
            <textarea id="ifimgen_preview_scene" class="text_pole ifimgen-preview-scene" rows="4" placeholder="${escapeHtml(t('ph_preview'))}"></textarea>
            <div class="ifimgen-row">${btn({ id: 'ifimgen_preview', cls: 'primary', icon: 'locate', label: t('btn_compile') })}<span id="ifimgen_preview_status" class="ifimgen-status"></span></div>
            <div class="ifimgen-note">${t('note_preview')}</div>
            <div id="ifimgen_preview_result" class="ifimgen-preview-result" style="display:none">
                <div class="ifimgen-pv-block">
                    <div class="ifimgen-pv-head">${ICONS.users} ${t('pv_key')}</div>
                    <pre id="ifimgen_pv_key" class="ifimgen-pre"></pre>
                </div>
                <div class="ifimgen-pv-block">
                    <div class="ifimgen-pv-head">${ICONS.sparkles} ${t('pv_p1')}</div>
                    <textarea id="ifimgen_pv_p1" class="text_pole" rows="6"></textarea>
                    <div class="ifimgen-row">${btn({ id: 'ifimgen_pv_gen1', icon: 'play', label: t('btn_gen_test') })}</div>
                </div>
                <div class="ifimgen-pv-block">
                    <div class="ifimgen-pv-head">${ICONS.brain} ${t('pv_p2')}</div>
                    <textarea id="ifimgen_pv_p2" class="text_pole" rows="6"></textarea>
                    <div class="ifimgen-row">${btn({ id: 'ifimgen_pv_gen2', icon: 'play', label: t('btn_gen_test') })}</div>
                </div>
            </div>
        </div>
        <div class="ifimgen-row">
            ${btn({ id: 'ifimgen_run_last', cls: 'primary', icon: 'play', label: t('btn_run_last') })}
            ${btn({ id: 'ifimgen_regen_last', icon: 'refresh', label: t('btn_regen_last'), title: t('tip_regen_last') })}
            <span id="ifimgen_gen_status" class="ifimgen-status"></span>
        </div>
    </div>`;
}

function helpPanel() {
    const steps = t('help_steps');
    const tips = t('help_tips');
    return `
    <div class="ifimgen-panel" data-panel="help">
        <div class="ifimgen-box ifimgen-help">
            ${boxTitle('help', t('help_title'))}
            <div class="ifimgen-note">${t('help_intro')}</div>
            <ol class="ifimgen-steps">
                ${(Array.isArray(steps) ? steps : []).map(([title, body]) => `<li><b>${title}</b><div>${body}</div></li>`).join('')}
            </ol>
            <h4>${t('help_tips_title')}</h4>
            <ul class="ifimgen-tips">${(Array.isArray(tips) ? tips : []).map(x => `<li>${x}</li>`).join('')}</ul>
        </div>
    </div>`;
}

function langSwitch() {
    return `<div class="ifimgen-lang" title="${t('lang_title')}">
        ${LANGS.map(l => `<button type="button" class="ifimgen-lang-btn ${l.id === getLang() ? 'active' : ''}" data-lang="${l.id}" title="${l.title}" aria-label="${l.title}">${FLAGS[l.id]}<span>${l.label}</span></button>`).join('')}
    </div>`;
}

function markup(version) {
    const tabs = MAIN_TABS();
    return `
    <div class="ifimgen">
        <div class="ifimgen-title"><h3>IF Imgen</h3><small>v${escapeHtml(version)}</small>${langSwitch()}</div>
        <div class="ifimgen-tabs">
            ${tabs.map(tab => btn({ icon: tab.icon, label: tab.label, attrs: `data-tab="${tab.tab}"` })).join('')}
        </div>
        ${settingsPanel()}
        ${ENTITY_TABS().map(entityPanel).join('')}
        ${galleryMarkup()}
        ${helpPanel()}
        ${generatePanel()}
    </div>`;
}

/** Style tab: name + prompt frame + default. No keyword, no details, no binding. */
function stylePanel({ tab, label, icon, hint }) {
    return `
    <div class="ifimgen-panel" data-panel="${tab}">
        <div class="ifimgen-box">
            ${boxTitle(icon, label, '<span class="ifimgen-chip ent-count"></span>')}
            <div class="ifimgen-row"><select class="text_pole ent-select"></select>${btn({ cls: 'ent-new', icon: 'plus', label: t('btn_new') })}</div>
            <div class="ifimgen-note">${hint}</div>
        </div>
        <div class="ifimgen-box">
            ${boxTitle('palette', t('box_style_profile'))}
            <div class="ifimgen-row"><label>${t('lbl_name')}</label><input class="text_pole ent-name" type="text" placeholder="${escapeHtml(t('ph_style_name'))}"></div>
            <div class="ifimgen-row"><label>${t('lbl_tags')}</label><textarea class="text_pole ent-tags" placeholder="anime style, flat color, clean lineart"></textarea></div>
            <div class="ifimgen-row"><label>${t('lbl_natural')}</label><textarea class="text_pole ent-natural" placeholder="soft anime illustration, pastel palette, clean lineart, cinematic lighting"></textarea></div>
            <div class="ifimgen-row"><label>${t('lbl_negative')}</label><input class="text_pole ent-negative" type="text" placeholder="realistic, 3d, photo"></div>
            <div class="ifimgen-row"><label>${t('lbl_loras')}</label><textarea class="text_pole ent-loras" placeholder="${escapeHtml(t('ph_loras'))}"></textarea></div>
            <div class="ifimgen-row"><label>${t('lbl_lorapos')}</label><select class="text_pole ent-lorapos">${LORA_POSITIONS.map(p => `<option value="${p}">${p}</option>`).join('')}</select></div>
            <div class="ifimgen-note">${t('note_style')}</div>
        </div>
        <div class="ifimgen-row">
            ${btn({ cls: 'ent-save primary', icon: 'save', label: t('btn_save') })}
            ${btn({ cls: 'ent-default', icon: 'star', label: t('btn_set_default') })}
            ${btn({ cls: 'ent-delete danger', icon: 'trash', title: t('btn_delete') })}
            ${btn({ cls: 'ent-export', icon: 'download', title: t('btn_export_json') })}
            ${fileBtn({ inputCls: 'ent-import', title: t('btn_import_json') })}
            <select class="text_pole ent-import-mode" style="flex:0 0 auto;height:32px;margin:0"><option value="merge">${t('opt_merge')}</option><option value="replace">${t('opt_replace')}</option></select>
        </div>
        <div class="ifimgen-status ent-status"></div>
    </div>`;
}
