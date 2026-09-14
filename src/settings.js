// IF Imgen - settings schema. Everything lives in extension_settings.IF_Imgen.
import { BUILTIN_PRESETS } from './presets.js';

export const MODULE = 'IF_Imgen';
export const SETTINGS_VERSION = 1;

export function defaultSettings() {
    return {
        version: SETTINGS_VERSION,
        enabled: true,
        connection: {
            backend: 'sd', // 'sd' | 'nai'
            sd: {
                url: 'http://127.0.0.1:7861', auth: '', model: '', models: [],
                sampler: 'Euler a', scheduler: 'Automatic',
                steps: 20, cfg: 6, width: 832, height: 1216,
            },
            nai: {
                apiKey: '', model: 'nai-diffusion-4-5-full',
                sampler: 'k_euler_ancestral', scheduler: 'karras',
                steps: 28, cfg: 5, width: 832, height: 1216, variety: false,
            },
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
            qualityPrefix: 'masterpiece, best quality, amazing quality',
            negative: 'lowres, bad anatomy, bad hands, text, error, worst quality, low quality, jpeg artifacts, signature, watermark',
            overrides: { steps: 0, cfg: 0, width: 0, height: 0 }, // 0 = inherit from connection
            minParagraphChars: 40,
            showButton: true,
        },
        data: { characters: [], personas: [], styles: [], presets: [] },
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

/** Ensure the namespace exists and is migrated. Returns live reference. */
export function ensureSettings(extensionSettings) {
    extensionSettings[MODULE] ??= {};
    const s = extensionSettings[MODULE];
    fill(s, defaultSettings());
    s.version = SETTINGS_VERSION;
    return s;
}
