// IF Imgen - ComfyUI workflow helpers. Pure module (no DOM, no fetch).
//
// A workflow is the JSON exported by ComfyUI with "Save (API format)":
//   { "<nodeId>": { "class_type": "...", "inputs": { ... } }, ... }
// Placeholders follow the SillyTavern convention: a quoted "%name%" is replaced by the
// JSON value (so "%steps%" becomes a number), a bare %name% inside a longer string is
// replaced by the escaped text (e.g. "text": "masterpiece, %prompt%").

export const PLACEHOLDERS = ['prompt', 'negative_prompt', 'model', 'sampler', 'scheduler', 'steps', 'scale', 'cfg', 'width', 'height', 'seed', 'denoise'];

const SAMPLER_TYPES = ['KSampler', 'KSamplerAdvanced'];
const LATENT_RE = /^Empty.*Latent/;
const MODEL_LOADERS = { CheckpointLoaderSimple: 'ckpt_name', UNETLoader: 'unet_name', UnetLoaderGGUF: 'unet_name' };
const isLink = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';
const isPh = v => typeof v === 'string' && /^%[a-z_]+%$/.test(v);

/**
 * Parse workflow text. Detects the UI export (nodes/links arrays) which ComfyUI cannot execute.
 * @returns {{ nodes:object|null, error:string }}
 */
export function parseWorkflow(text) {
    const s = String(text ?? '').trim();
    if (!s) return { nodes: null, error: 'Workflow is empty.' };
    let j;
    try { j = JSON.parse(s); } catch (e) { return { nodes: null, error: `Workflow is not valid JSON: ${e.message}` }; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { nodes: null, error: 'Workflow must be a JSON object.' };
    if (Array.isArray(j.nodes) && Array.isArray(j.links)) return { nodes: null, error: 'This is the UI export. In ComfyUI use "Save (API format)" (enable Dev mode options).' };
    if (j.prompt && typeof j.prompt === 'object' && !j.prompt.class_type) j = j.prompt; // {"prompt": {...}} wrapper
    const ids = Object.keys(j);
    if (!ids.length || !ids.every(id => j[id] && typeof j[id] === 'object' && typeof j[id].class_type === 'string')) return { nodes: null, error: 'Not an API-format workflow (every entry needs a class_type).' };
    return { nodes: j, error: '' };
}

/** Which placeholders the text contains (quoted or bare). */
export function placeholdersIn(text) {
    const s = String(text ?? '');
    return PLACEHOLDERS.filter(k => s.includes(`%${k}%`));
}

/** Summary for the UI: validity, node count, placeholders present, whether the prompt is wired. */
export function workflowInfo(text) {
    const { nodes, error } = parseWorkflow(text);
    if (!nodes) return { ok: false, error, nodeCount: 0, placeholders: [] };
    const placeholders = placeholdersIn(text);
    return { ok: true, error: placeholders.includes('prompt') ? '' : 'No %prompt% placeholder - use Auto-map or add it by hand.', nodeCount: Object.keys(nodes).length, placeholders };
}

/**
 * Replace placeholders and return the executable workflow object.
 * @param {string} text  workflow JSON text with placeholders
 * @param {{ prompt:string, negative_prompt?:string, model?:string, sampler?:string, scheduler?:string, steps?:number, cfg?:number, width?:number, height?:number, seed?:number, denoise?:number }} v
 */
export function renderWorkflow(text, v) {
    const vals = {
        prompt: String(v.prompt ?? ''), negative_prompt: String(v.negative_prompt ?? ''),
        model: String(v.model ?? ''), sampler: String(v.sampler ?? 'euler'), scheduler: String(v.scheduler ?? 'simple'),
        steps: Number(v.steps) || 20, scale: Number(v.cfg) || 1, cfg: Number(v.cfg) || 1,
        width: Number(v.width) || 1024, height: Number(v.height) || 1024,
        seed: Number.isFinite(v.seed) && v.seed >= 0 ? Math.floor(v.seed) : Math.floor(Math.random() * 2 ** 48),
        denoise: Number.isFinite(v.denoise) ? v.denoise : 1,
    };
    let s = String(text ?? '');
    if (s.includes('%model%') && !vals.model) throw new Error('Workflow uses %model% but no default model is set (Settings -> 2 - Model).');
    for (const k of PLACEHOLDERS) {
        const val = vals[k];
        s = s.replaceAll(`"%${k}%"`, JSON.stringify(val));
        if (s.includes(`%${k}%`)) s = s.replaceAll(`%${k}%`, typeof val === 'string' ? JSON.stringify(val).slice(1, -1) : String(val));
    }
    const { nodes, error } = parseWorkflow(s);
    if (!nodes) throw new Error(`Rendered workflow is invalid: ${error}`);
    return nodes;
}

/** Follow `inputName` links upward until a node of `pred` is found (max `depth` hops). */
function trace(nodes, id, inputNames, pred, depth = 6) {
    let cur = id;
    for (let i = 0; i <= depth && cur && nodes[cur]; i++) {
        if (pred(nodes[cur])) return cur;
        const next = inputNames.map(n => nodes[cur].inputs?.[n]).find(isLink);
        cur = next ? next[0] : null;
    }
    return null;
}

/**
 * Insert placeholders into a raw API workflow so the extension can drive it:
 * prompt / negative (CLIPTextEncode feeding the sampler), seed/steps/cfg/sampler/scheduler (KSampler),
 * width/height (Empty*Latent feeding the sampler, links included), model (first checkpoint / unet loader).
 * Idempotent: values that already are placeholders are left alone.
 * @returns {{ text:string, nodes:object|null, error:string, mapped:Record<string,string>, originalModel:string }}
 */
export function autoMapWorkflow(text) {
    const { nodes, error } = parseWorkflow(text);
    if (!nodes) return { text: String(text ?? ''), nodes: null, error, mapped: {}, originalModel: '' };
    const mapped = {};
    const set = (id, key, ph, label) => { const inp = nodes[id].inputs ??= {}; if (!isPh(inp[key])) inp[key] = `%${ph}%`; mapped[label ?? ph] = id; };
    const isEnc = n => n.class_type === 'CLIPTextEncode' || /TextEncode/.test(n.class_type) && typeof n.inputs?.text === 'string';

    const samplerId = Object.keys(nodes).find(id => SAMPLER_TYPES.includes(nodes[id].class_type));
    let posId = null;
    if (samplerId) {
        const sm = nodes[samplerId];
        set(samplerId, sm.class_type === 'KSamplerAdvanced' ? 'noise_seed' : 'seed', 'seed');
        set(samplerId, 'steps', 'steps');
        set(samplerId, 'cfg', 'scale');
        set(samplerId, 'sampler_name', 'sampler');
        set(samplerId, 'scheduler', 'scheduler');
        const pos = sm.inputs?.positive, neg = sm.inputs?.negative, lat = sm.inputs?.latent_image;
        posId = isLink(pos) ? trace(nodes, pos[0], ['conditioning'], isEnc) : null;
        if (posId) set(posId, 'text', 'prompt');
        const negId = isLink(neg) ? trace(nodes, neg[0], ['conditioning'], isEnc) : null;
        if (negId && negId !== posId) set(negId, 'text', 'negative_prompt');
        const latId = isLink(lat) ? trace(nodes, lat[0], ['samples', 'latent_image', 'latent'], n => LATENT_RE.test(n.class_type)) : null;
        if (latId) { set(latId, 'width', 'width'); set(latId, 'height', 'height'); }
    }
    if (!posId) {
        const enc = Object.keys(nodes).find(id => nodes[id].class_type === 'CLIPTextEncode');
        if (enc) set(enc, 'text', 'prompt');
    }
    let originalModel = '';
    const loaderId = Object.keys(nodes).find(id => MODEL_LOADERS[nodes[id].class_type]);
    if (loaderId) {
        const key = MODEL_LOADERS[nodes[loaderId].class_type];
        const cur = nodes[loaderId].inputs?.[key];
        if (typeof cur === 'string' && !isPh(cur)) originalModel = cur;
        set(loaderId, key, 'model');
    }
    return { text: JSON.stringify(nodes, null, 2), nodes, error: mapped.prompt ? '' : 'Could not find a CLIPTextEncode for the prompt.', mapped, originalModel };
}

const LORA_RE = /<lora:([^:>]+)(?::([-\d.]+))?(?::[-\d.]+)?>/gi;

/** Pull `<lora:name:0.8>` out of a prompt. @returns {{ text:string, loras:{name:string, weight:number}[] }} */
export function extractLoras(prompt) {
    const loras = [];
    const text = String(prompt ?? '').replace(LORA_RE, (m, name, w) => {
        loras.push({ name: name.trim(), weight: w === undefined || w === '' ? 1 : Number(w) || 1 });
        return '';
    }).replace(/\s*,\s*,+/g, ',').replace(/^\s*,\s*|\s*,\s*$/g, '').replace(/\s{2,}/g, ' ').trim();
    return { text, loras };
}

/**
 * Chain LoraLoaderModelOnly nodes between the model source and the sampler's `model` input.
 * Mutates and returns `nodes`. LoRA names without an extension get ".safetensors".
 * @returns {{ nodes:object, injected:string[], skipped:string }}
 */
export function injectLoras(nodes, loras) {
    const list = (loras ?? []).filter(l => l?.name);
    if (!list.length) return { nodes, injected: [], skipped: '' };
    const samplerId = Object.keys(nodes).find(id => SAMPLER_TYPES.includes(nodes[id].class_type) && isLink(nodes[id].inputs?.model));
    if (!samplerId) return { nodes, injected: [], skipped: 'no KSampler with a linked model input' };
    let link = nodes[samplerId].inputs.model;
    const injected = [];
    list.forEach((l, i) => {
        const id = `ifimgen_lora_${i + 1}`;
        const lora_name = /\.[a-z0-9]{2,12}$/i.test(l.name) ? l.name : `${l.name}.safetensors`;
        nodes[id] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name, strength_model: l.weight, model: link }, _meta: { title: `IF Imgen LoRA ${i + 1}` } };
        link = [id, 0];
        injected.push(lora_name);
    });
    nodes[samplerId].inputs.model = link;
    return { nodes, injected, skipped: '' };
}
