// IF Imgen - settings schema. Everything lives in extension_settings.IF_Imgen.
import { BUILTIN_PRESETS } from './presets.js';
import { DEFAULT_REFINE_SYSTEM, DEFAULT_SETTING_SYSTEM } from './scene.js';

export const MODULE = 'IF_Imgen';
export const SETTINGS_VERSION = 2;

/** Per-model generation parameters (one profile per model, per backend). */
export const PARAM_KEYS = ['sampler', 'scheduler', 'steps', 'cfg', 'width', 'height'];
export const PARAM_DEFAULTS = {
    sd: { sampler: 'Euler a', scheduler: 'Automatic', steps: 20, cfg: 6, width: 832, height: 1216 },
    comfy: { sampler: 'euler', scheduler: 'simple', steps: 20, cfg: 5, width: 832, height: 1216 },
    nai: { sampler: 'k_euler_ancestral', scheduler: 'karras', steps: 28, cfg: 5, width: 832, height: 1216 },
};

export function defaultSettings() {
    return {
        version: SETTINGS_VERSION,
        enabled: true,
        language: 'en',        // UI language: 'en' | 'vi'
        connection: {
            backend: 'sd', // 'sd' | 'comfy' | 'nai'  (the ACTIVE image API)
            sd: { url: 'http://127.0.0.1:7861', auth: '', model: '', models: [] },
            // ComfyUI direct: `workflow` is the API-format JSON text with %placeholders% (see src/comfy.js).
            // injectLoras: <lora:name:w> tags from entities/styles become LoraLoaderModelOnly nodes in front of the sampler.
            comfy: { url: 'http://127.0.0.1:8188', model: '', models: [], workflow: '', injectLoras: true },
            // Optional HTTP header sent with every SD/Comfy request. Fill it in
            // Settings (Image API box) when your proxy supports it, e.g. name
            // X-IF-Imgen / value raw-prompt -> the proxy skips character
            // supplements and forwards the prompt untouched. A1111 ignores it.
            sdRaw: true, // add ifimgen_raw:true to the generate body; your proxy can read it to skip character supplements
            nai: { apiKey: '', model: 'nai-diffusion-4-5-full', variety: false },
            // profiles[backend][modelName] = { sampler, scheduler, steps, cfg, width, height }
            // profiles[backend]['*'] = fallback for models without a saved profile
            profiles: { sd: {}, comfy: {}, nai: {} },
            llm: {
                mode: 'st_profile', // 'st_profile' | 'custom'
                profileId: '',
                custom: { baseUrl: '', apiKey: '', model: '' },
                maxTokens: 1200,
                temperature: 0.7,
            },
        },
        generate: {
            auto: true,                 // run on every character reply
            imagesPerResponse: 1,       // N
            contextMessages: 4,         // K previous messages given to planner
            presetId: BUILTIN_PRESETS[0].id,
            dialect: 'tags',            // 'tags' | 'natural'
            mode: 'plan',               // 'plan' = 1 LLM call (tokens expanded verbatim) | 'refine' = 3 calls per reply (planner + scene setting + ONE batch refine for all images)
            settingSystem: DEFAULT_SETTING_SYSTEM,
            refineSystem: DEFAULT_REFINE_SYSTEM,
            useQualityPrefix: true,
            qualityPrefix: 'masterpiece, best quality, amazing quality',
            useNegative: true,          // some models (e.g. Krea) take no negative prompt
            negative: 'lowres, bad anatomy, bad hands, text, error, worst quality, low quality, jpeg artifacts, signature, watermark',
            overrides: { steps: 0, cfg: 0, width: 0, height: 0 }, // 0 = inherit from model profile
            minParagraphChars: 40,
            showButton: true,
            collapseImages: true,       // chat images sit behind a small toggle button
            imageAlign: 'left',         // 'left' | 'center' | 'right' - where generated images sit in the chat bubble
        },
        // presetOverrides[builtinId] = system prompt saved over a built-in preset (Save = overwrite, no fork needed)
        data: { characters: [], personas: [], styles: [], presets: [], presetOverrides: {}, testImages: [] },
        defaultStyleId: '',
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
