// IF Imgen - single LLM target: ST connection profile OR custom OpenAI-compatible.
//
// ISOLATION GUARANTEE: the LLM receives ONLY the messages IF Imgen builds
// (planner/refine system text + chat paragraphs + entity roster). The request is
// sent RAW: includePreset=false / includeInstruct=false so SillyTavern does not
// merge the profile's prompt preset (which would carry the character card,
// persona description, world info, author's note...). Nothing is read from the
// character card at any point.

export function createLlm({ settings, getContext }) {
    const cfg = () => settings.connection.llm;

    function listProfiles() {
        try {
            const ctx = getContext();
            return ctx.ConnectionManagerRequestService.getSupportedProfiles().map(p => ({ id: p.id, name: p.name || p.id }));
        } catch { return []; }
    }

    async function viaProfile(messages, signal) {
        const ctx = getContext();
        const id = cfg().profileId;
        if (!id) throw new Error('No SillyTavern connection profile selected.');
        const res = await ctx.ConnectionManagerRequestService.sendRequest(
            id, messages, cfg().maxTokens,
            { signal, extractData: true, includePreset: false, includeInstruct: false },
            { temperature: cfg().temperature },
        );
        if (typeof res === 'string') return res;
        return res?.content ?? '';
    }

    async function viaCustom(messages, signal) {
        const c = cfg().custom;
        if (!c.baseUrl || !c.model) throw new Error('Custom LLM: base URL and model are required.');
        const url = c.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const headers = { 'Content-Type': 'application/json' };
        if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
        const r = await fetch(url, {
            method: 'POST', headers, signal,
            body: JSON.stringify({ model: c.model, messages, max_tokens: cfg().maxTokens, temperature: cfg().temperature, stream: false }),
        });
        if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const d = await r.json();
        return d?.choices?.[0]?.message?.content ?? '';
    }

    /** Last few requests, newest last: { at, mode, target, messages, response } */
    const history = [];

    /** Last few requests, newest last: { at, mode, target, messages, response } */
    const history = [];

    /** Last few requests, newest last: { at, mode, target, messages, response } */
    const history = [];

    return {
        listProfiles,
        lastRequests: () => history.slice(),
        lastRequests: () => history.slice(),
        lastRequests: () => history.slice(),
        /** @returns {Promise<string>} */
        async chat({ system, user, signal }) {
            const messages = [];
            if (system) messages.push({ role: 'system', content: system });
            messages.push({ role: 'user', content: user });
            const rec = { at: new Date().toISOString(), mode: cfg().mode, target: cfg().mode === 'custom' ? cfg().custom.model : `profile:${cfg().profileId}`, messages, response: '' };
            history.push(rec); if (history.length > 6) history.shift();
            const text = cfg().mode === 'custom' ? await viaCustom(messages, s