// IF Imgen - image backends.
//  sd : ONE endpoint, two request styles, both routed through SillyTavern's own /api/sd/* proxy (no CORS work):
//       - A1111 style (default): txt2img JSON -> proxy / Forge / WebUI.
//       - Workflow style (sd.useWorkflow + sd.workflow): the user's own ComfyUI API-format workflow with
//         %placeholders% is rendered here and sent on the SAME A1111 txt2img request as `ifimgen_workflow`
//         (so URL + auth + the proxy's queue keep working). The comfy-cloud proxy runs it as-is on Comfy Cloud;
//         a plain ComfyUI URL is handled by /api/sd/comfy/* instead (sd.workflowTarget = 'comfy').
//  nai: NovelAI, browser-direct (image.novelai.net answers CORS *; account + image endpoints both live there since 2026-09).
import { renderWorkflow, extractLoras, injectLoras } from './comfy.js';

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
    /** Workflow mode = the user pasted an API-format workflow and switched it on. */
    const workflowMode = () => cfg().useWorkflow === true && String(cfg().workflow ?? '').trim().length > 0;
    /** 'proxy' (default): A1111-compatible proxy that accepts ifimgen_workflow. 'comfy': a real ComfyUI (/prompt, /history). */
    const directComfy = () => workflowMode() && cfg().workflowTarget === 'comfy';

    async function post(path, extra = {}, signal) {
        const r = await fetch(path, { method: 'POST', headers: { ...getRequestHeaders() }, body: body(extra), signal });
        if (!r.ok) {
            const text = (await r.text().catch(() => '')).trim();
            throw new Error(text && text.length < 600 && !/^<!doctype/i.test(text) ? text : `${path} -> HTTP ${r.status}${r.status === 500 ? ' (endpoint unreachable or rejected the request)' : ''}`);
        }
        return r;
    }

    /** Render the stored workflow with this prompt/params, inject <lora:...> tags as LoraLoaderModelOnly nodes. */
    function buildWorkflow({ prompt, negative, params, seed }) {
        const { text, loras } = extractLoras(prompt);
        const nodes = renderWorkflow(cfg().workflow, {
            prompt: text, negative_prompt: negative, model: params.model,
            sampler: params.sampler, scheduler: params.scheduler,
            steps: params.steps, cfg: params.cfg, width: params.width, height: params.height, seed,
        });
        if (cfg().injectLoras !== false) injectLoras(nodes, loras);
        return nodes;
    }

    /** Real ComfyUI: queue the workflow through ST's /api/sd/comfy proxy (/prompt -> /history -> /view). */
    async function generateDirectComfy(nodes, signal) {
        const r = await post('/api/sd/comfy/generate', { prompt: JSON.stringify({ prompt: nodes }) }, signal);
        const data = await r.json();
        if (!data?.data) throw new Error('ComfyUI returned no image.');
        return data.data;
    }

    return {
        id: 'sd',
        workflowMode,
        async test() { await post(directComfy() ? '/api/sd/comfy/ping' : '/api/sd/ping'); return workflowMode() ? `Connected (workflow mode, ${directComfy() ? 'ComfyUI' : 'A1111 proxy'}).` : 'Connected.'; },
        async fetchModels() {
            const r = await post(directComfy() ? '/api/sd/comfy/models' : '/api/sd/models');
            const list = await r.json();
            return list.map(m => m.value ?? m.title ?? String(m));
        },
        /** Sampler / scheduler names known to the endpoint (A1111 /samplers + /schedulers, or ComfyUI object_info). */
        async fetchSamplers() { try { return await (await post(directComfy() ? '/api/sd/comfy/samplers' : '/api/sd/samplers')).json(); } catch { return []; } },
        async fetchSchedulers() { try { return await (await post(directComfy() ? '/api/sd/comfy/schedulers' : '/api/sd/schedulers')).json(); } catch { return []; } },
        /** @returns {Promise<string>} base64 png */
        async generate({ prompt, negative, params, seed = -1 }, signal) {
            const workflow = workflowMode() ? buildWorkflow({ prompt, negative, params, seed }) : null;
            if (workflow && directComfy()) return generateDirectComfy(workflow, signal);
            const r = await post('/api/sd/generate', {
                // Workflow mode via an A1111-compatible proxy: the rendered graph rides along; the proxy runs it as-is.
                ifimgen_workflow: workflow ?? undefined,
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
            // api.novelai.net/user/subscription now answers 400 "Please refresh NovelAI.net. If using a third-party tool, update to
            // the image URL" - the account endpoints moved to image.novelai.net (which also answers CORS *). Same JSON shape.
            const r = await fetch('https://image.novelai.net/user/subscription', { headers: headers() });
            if (r.status === 401) throw new Error('NovelAI key rejected.');
            if (r.status === 400) throw new Error(`NovelAI: ${((await r.json().catch(() => null))?.message) || 'HTTP 400'}`);
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
