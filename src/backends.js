// IF Imgen - image backends.
//  sd : any A1111-compatible endpoint (incl. the user's Comfy-cloud proxy on :7861),
//       routed through SillyTavern's own /api/sd/* server proxy -> no CORS work.
//  nai: NovelAI, browser-direct (image.novelai.net answers CORS *).

export const NAI_MODELS = [
    'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full',
    'nai-diffusion-4-curated-preview', 'nai-diffusion-3', 'nai-diffusion-furry-3',
];
export const NAI_SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_sde', 'k_dpmpp_2s_ancestral', 'ddim'];
export const NAI_SCHEDULERS = ['karras', 'native', 'exponential', 'polyexponential'];

// ---------------------------------------------------------------- SD / A1111
export function createSdBackend({ getRequestHeaders, settings }) {
    const cfg = () => settings.connection.sd;
    const body = extra => JSON.stringify({ url: cfg().url, auth: cfg().auth, ...extra });

    async function post(path, extra = {}, signal) {
        const r = await fetch(path, { method: 'POST', headers: { ...getRequestHeaders() }, body: body(extra), signal });
        if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}${r.status === 500 ? ' (endpoint unreachable or rejected the request)' : ''}`);
        return r;
    }

    return {
        id: 'sd',
        async test() { await post('/api/sd/ping'); return 'Connected.'; },
        async fetchModels() {
            const r = await post('/api/sd/models');
            const list = await r.json();
            return list.map(m => m.value ?? m.title ?? String(m));
        },
        /** @returns {Promise<string>} base64 png */
        async generate({ prompt, negative, params, seed = -1 }, signal) {
            const r = await post('/api/sd/generate', {
                ifimgen_raw: cfg().sdRaw !== false, // proxy: skip character supplements for this request
                prompt, negative_prompt: negative,
                sampler_name: params.sampler, scheduler: params.scheduler,
                steps: params.steps, cfg_scale: params.cfg, width: params.width, height: params.height,
                seed: seed >= 0 ? seed : undefined,
                override_settings: params.model ? { sd_model_checkpoint: params.model } : {},
                override_settings_restore_afterwards: false,
                send_images: true, save_images: false,
            }, signal);
            const data = await r.json();
            const b64 = data?.images?.[0];
            if (!b64) throw new Error('Backend returned no image.');
            return b64;
        },
    };
}

// ------------------------------------------------------------------ NovelAI
export function createNaiBackend({ settings }) {
    const cfg = () => settings.connection.nai;
    const headers = () => ({ Authorization: `Bearer ${cfg().apiKey}`, 'Content-Type': 'application/json' });

    return {
        id: 'nai',
        async test() {
            const r = await fetch('https://api.novelai.net/user/subscription', { headers: headers() });
            if (r.status === 401) throw new Error('NovelAI key rejected.');
            if (!r.ok) throw new Error(`NovelAI HTTP ${r.status}`);
            const d = await r.json();
            const anlas = Math.floor((d?.trainingStepsLeft?.fixedTrainingStepsLeft ?? 0) + (d?.trainingStepsLeft?.purchasedTrainingSteps ?? 0));
            return `Tier ${d?.tier ?? '?'} · Anlas ${anlas}`;
        },
        async fetchModels() { return NAI_MODELS; },
        async generate({ prompt, negative, params, seed = -1 }, signal) {
            const model = params.model || 'nai-diffusion-4-5-full';
            const s = seed >= 0 ? seed : Math.floor(Math.random() * 9999999999);
            const variety = cfg().variety
                ? Math.sqrt((params.width * params.height) / 1011712) * (model.includes('4-5') ? 58 : 19)
                : null;
            const payload = {
                action: 'generate', input: prompt, model,
                parameters: {
                    params_version: 3, prefer_brownian: true,
                    negative_prompt: negative, width: params.width, height: params.height,
                    scale: params.cfg, seed: s, sampler: params.sampler, noise_schedule: params.scheduler,
                    steps: params.steps, n_samples: 1, ucPreset: 0, qualityToggle: false,
                    add_original_image: false, controlnet_strength: 1, deliberate_euler_ancestral_bug: false,
                    dynamic_thresholding: false, legacy: false, legacy_v3_extend: false,
                    sm: false, sm_dyn: false, uncond_scale: 1, skip_cfg_above_sigma: variety,
                    use_coords: false, characterPrompts: [],
                    reference_image_multiple: [], reference_information_extracted_multiple: [], reference_strength_multiple: [],
                    v4_prompt: { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true },
                    v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] } },
                },
            };
            const r = await fetch('https://image.novelai.net/ai/generate-image', { method: 'POST', headers: headers(), body: JSON.stringify(payload), signal });
            if (r.status === 401) throw new Error('NovelAI key rejected.');
            if (r.status === 402) throw new Error('NovelAI: out of Anlas.');
            if (r.status === 429) throw new Error('NovelAI: rate limited.');
            if (!r.ok) throw new Error(`NovelAI HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
            const png = await pngFromZip(await r.arrayBuffer());
            return bytesToBase64(png);
        },
    };
}

/** NAI returns a zip with one PNG; unzip natively (stored or deflate-raw). */
export async function pngFromZip(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('NovelAI response is not a zip.');
    const cd = view.getUint32(eocd + 16, true);
    if (view.getUint32(cd, true) !== 0x02014b50) throw new Error('Bad zip central directory.');
    const method = view.getUint16(cd + 10, true);
    const compSize = view.getUint32(cd + 20, true);
    const localOff = view.getUint32(cd + 42, true);
    const nameLen = view.getUint16(localOff + 26, true);
    const extraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + nameLen + extraLen;
    const comp = u8.subarray(dataStart, dataStart + compSize);
    if (method === 0) return comp;
    if (method !== 8) throw new Error(`Unsupported zip method ${method}`);
    const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesToBase64(u8) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    return btoa(bin);
}

export function createBackends(deps) {
    const map = { sd: createSdBackend(deps), nai: createNaiBackend(deps) };
    return { get: id => map[id] ?? map.sd, active: () => map[deps.settings.connection.backend] ?? map.sd };
}
