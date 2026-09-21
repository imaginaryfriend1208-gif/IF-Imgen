// IF Imgen - settings schema. Everything lives in extension_settings.IF_Imgen.
import { BUILTIN_PRESETS } from './presets.js';
import { DEFAULT_REFINE_SYSTEM, DEFAULT_SCENE_SYSTEM } from './scene.js';
import { DEFAULT_PROFILE_SYSTEM } from './profile.js';

export const MODULE = 'IF_Imgen';
export const SETTINGS_VERSION = 5;

/** Per-model generation parameters (one profile per model, per backend). */
export const PARAM_KEYS = ['sampler', 'scheduler', 'steps', 'cfg', 'width', 'height'];
export const PARAM_DEFAULTS = {
    sd: { sampler: 'Euler a', scheduler: 'Automatic', steps: 20, cfg: 6, width: 832, height: 1216 },
    nai: { sampler: 'k_euler_ancestral', scheduler: 'karras', steps: 28, cfg: 5, width: 832, height: 1216 },
};

export function defaultSettings() {
    return {
        version: SETTINGS_VERSION,
        enabled: true,
        language: 'en',        // UI language: 'en' | 'vi'
        connection: {
            backend: 'sd', // 'sd' | 'nai'  (the ACTIVE image API)
            // sd = one URL, two request styles. useWorkflow=false -> A1111 txt2img. useWorkflow=true + workflow ->
            // the API-format ComfyUI workflow (with %placeholders%, see src/comfy.js) is sent to ComfyUI at that URL.
            // injectLoras: <lora:name:w> tags from entities/styles become LoraLoaderModelOnly nodes in front of the sampler.
            // samplers / schedulers: names fetched from ComfyUI (suggestions for the profile fields).
            // workflowTarget: 'proxy' = A1111-compatible proxy that accepts `ifimgen_workflow` on txt2img (comfy-cloud-proxy) | 'comfy' = real ComfyUI (/prompt).
            sd: { url: 'http://127.0.0.1:7861', auth: '', model: '', models: [], useWorkflow: false, workflowTarget: 'proxy', workflow: '', injectLoras: true, samplers: [], schedulers: [] },
            // Optional HTTP header sent with every SD/Comfy request. Fill it in
            // Settings (Image API box) when your proxy supports it, e.g. name
            // X-IF-Imgen / value raw-prompt -> the proxy skips character
            // supplements and forwards the prompt untouched. A1111 ignores it.
            sdRaw: true, // add ifimgen_raw:true to the generate body; your proxy can read it to skip character supplements
            nai: { apiKey: '', model: 'nai-diffusion-4-5-full', variety: false },
            // profiles[backend][modelName] = { sampler, scheduler, steps, cfg, width, height }
            // profiles[backend]['*'] = fallback for models without a saved profile
            profiles: { sd: {}, nai: {} },
            llm: {
                mode: 'st_profile', // 'st_profile' | 'custom'
                profileId: '',
                custom: { baseUrl: '', apiKey: '', model: '' },
                maxTokens: 12000,    // shared by the 3 steps; scene document + two prompt versions per image need the room (rarely used up, but a cap here truncates JSON)
                temperature: 0.7,
            },
        },
        generate: {
            auto: true,                 // run on every character reply
            imagesPerResponse: 1,       // N
            contextMessages: 4,         // K previous messages given to the scene planner
            sceneHistory: 3,            // scene documents of earlier replies handed to the scene planner (continuity)
            ledgerLimit: 40,            // chat tokens (ad-hoc tokens defined by earlier scene documents) handed to the LLM steps: newest N, 0 = all
            presetId: BUILTIN_PRESETS[0].id,
            autoAspect: false,
            dialect: 'tags',            // 'tags' | 'natural'
            // Calls per reply: 'plan' = 2 (scene document + translate to prompts) | 'refine' = 3 (+ ONE batch refine for all images)
            mode: 'plan',
            sceneSystem: DEFAULT_SCENE_SYSTEM,
            sceneRules: '',             // the user's own short rules for the scene document, appended to sceneSystem (survive a default-prompt update)
            refineSystem: DEFAULT_REFINE_SYSTEM,
            profileSystem: DEFAULT_PROFILE_SYSTEM, // ONE call: entity data -> portrait prompt (Characters / Personas -> Profile image)
            useQualityPrefix: true,
            qualityPrefix: 'masterpiece, best quality, amazing quality',
            useNegative: true,          // some models (e.g. Krea) take no negative prompt
            negative: 'lowres, bad anatomy, bad hands, text, error, worst quality, low quality, jpeg artifacts, signature, watermark',
            overrides: { steps: 0, cfg: 0, width: 0, height: 0 }, // 0 = inherit from model profile
            minParagraphChars: 40,
            showButton: true,
            collapseImages: true,       // chat images sit behind a small toggle button
            floater: true,              // floating quick-action button + in-chat progress strip
            floaterPos: null,           // {x,y} once the user drags the button
            imageAlign: 'left',         // 'left' | 'center' | 'right' - where generated images sit in the chat bubble
        },
        // presetOverrides[builtinId] = system prompt saved over a built-in preset (Save = overwrite, no fork needed)
        data: { characters: [], personas: [], styles: [], presets: [], presetOverrides: {}, testImages: [] },
        defaultStyleId: '',
        // card / persona avatar -> id of the profile that is the ACTIVE version of that card (a card may own several).
        activeProfiles: {},
    };
}

/** Deep-fill missing keys from defaults without clobbering user values. */
function fill(target, defaults) {
    for (const [k, v] of Object.entries(defaults)) {
        if (target[k] === undefined || target[k] === null) {
            target[k] = structuredClone(v);
        } else if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && !Array.isArray(target[k])) {
            fill(target[k], v);
        }
    }
    return target;
}

/** v1 -> v2: sampler/steps/... used to live on connection.sd / connection.nai; move them into model profiles. */
export function migrate(s) {
    const from = Number(s.version) || 1;
    if (from < 2) {
        for (const be of ['sd', 'nai']) {
            const b = s.connection?.[be];
            if (!b || !PARAM_KEYS.some(k => b[k] !== undefined)) continue;
            const p = Object.fromEntries(PARAM_KEYS.map(k => [k, b[k] ?? PARAM_DEFAULTS[be][k]]));
            for (const k of PARAM_KEYS) delete b[k];
            s.connection.profiles[be] ??= {};
            s.connection.profiles[be]['*'] = p;
            if (b.model) s.connection.profiles[be][b.model] ??= { ...p };
        }
    }
    // v0.10.0 shipped a separate "comfy" backend for one release; fold its workflow into sd (same version, no bump).
    const legacy = s.connection?.comfy;
    if (legacy && typeof legacy === 'object') {
        const sd = s.connection.sd;
        if (legacy.workflow && !sd.workflow) { sd.workflow = legacy.workflow; sd.useWorkflow = true; if (legacy.url) sd.url = legacy.url; if (legacy.model && !sd.model) sd.model = legacy.model; }
        if (s.connection.backend === 'comfy') s.connection.backend = 'sd';
        if (s.connection.profiles?.comfy) { s.connection.profiles.sd = { ...s.connection.profiles.comfy, ...s.connection.profiles.sd }; delete s.connection.profiles.comfy; }
        delete s.connection.comfy;
    }
    // Batch refine (v0.10) needs {{count}} and the SCENE DOCUMENT contract. A stored refine system without
    // {{count}} is the pre-batch default (or an edit of it) and makes the LLM merge N drafts into ONE prompt.
    if (s.generate && typeof s.generate.refineSystem === 'string' && !s.generate.refineSystem.includes('{{count}}')) {
        s.generate.refineSystem = DEFAULT_REFINE_SYSTEM;
    }
    // v2 -> v3: the "scene setting" (refine-only, per reply) became the SCENE DOCUMENT (step 1 of every reply,
    // carried over to the next reply). The old setting system prompt is dropped; a refine system still written
    // against "SCENE SETTING" is the v2 default (or an edit of it) and is replaced by the new default.
    if (from < 3 && s.generate) {
        delete s.generate.settingSystem;
        if (typeof s.generate.refineSystem === 'string' && s.generate.refineSystem.includes('SCENE SETTING')) s.generate.refineSystem = DEFAULT_REFINE_SYSTEM;
    }
    // The scene document is long; the old 1200-token default truncated it. Only the untouched old default is raised.
    if (s.connection?.llm && s.connection.llm.maxTokens === 1200) s.connection.llm.maxTokens = 2000;
    // v4: step 2 answers with two versions per prompt and the scene document may carry a TOKENS section; small caps
    // cut the JSON mid-string. Any cap below 6000 is lifted to the new default (a larger user value is kept).
    if (from < 4 && s.connection?.llm && Number(s.connection.llm.maxTokens) < 6000) s.connection.llm.maxTokens = 8000;
    // v5 (0.12.13): the "final" carries every base look in full -> 4 shots x 2 versions no longer fit in 8000.
    if (from < 5 && s.connection?.llm && Number(s.connection.llm.maxTokens) < 12000) s.connection.llm.maxTokens = 12000;
    s.version = SETTINGS_VERSION;
    return s;
}

/** Ensure the namespace exists and is migrated. Returns live reference. */
export function ensureSettings(extensionSettings) {
    extensionSettings[MODULE] ??= {};
    const s = extensionSettings[MODULE];
    const hadVersion = s.version;
    fill(s, defaultSettings());
    if (hadVersion !== undefined) s.version = hadVersion; // fill() must not fake a migration
    migrate(s);
    // Styles are applied by "default" only. If the default points nowhere but styles exist, pick one
    // (prefer a legacy "always active" style) so existing setups keep their style.
    const styles = s.data?.styles ?? [];
    if (styles.length && !styles.some(x => x.id === s.defaultStyleId)) {
        s.defaultStyleId = (styles.find(x => x.bind?.always) ?? styles[0]).id;
    }
    return s;
}
