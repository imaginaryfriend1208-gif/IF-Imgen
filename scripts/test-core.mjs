#!/usr/bin/env node
import { readFileSync } from 'node:fs';
// IF Imgen - pure-module tests (no DOM, no ST). Run: node scripts/test-core.mjs
import assert from 'node:assert/strict';
import { splitParagraphs, insertAfterParagraphs, imageSnippet, stripImages, countImages, listImages, safeImageUrl, IMG_MARK, migrateLegacyImages, replaceImageUrl, removeImageByUrl } from '../src/paragraphs.js';
import { parsePlan, renderPlannerPrompt, BUILTIN_PRESETS } from '../src/presets.js';
import { createEntity, matchByKeyword, resolveEntities, importEntities, exportEntities } from '../src/entities.js';
import { compilePrompt, effectiveParams, modelParams, hasProfile } from '../src/prompt.js';
import { defaultSettings, ensureSettings, PARAM_DEFAULTS, SETTINGS_VERSION } from '../src/settings.js';
import { collectChatImages } from '../src/gallery.js';
import { parseFacets, facetsText, expandScene, buildRefinePrompt, rosterLine } from '../src/scene.js';
import { rosterText, isBound } from '../src/entities.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; } };

const mes = 'She opened the door slowly.\n\nThe hall was dark, lit only by a single candle on the far table.\n\n```\ncode\n```\n\nHe smiled.';

test('splitParagraphs numbers all, skips code + short', () => {
    const ps = splitParagraphs(mes, 11); // "He smiled." = 10 chars < 11 -> skipped
    assert.deepEqual(ps.map(p => p.index), [1, 2]);
    assert.equal(mes.slice(ps[1].start, ps[1].end), 'The hall was dark, lit only by a single candle on the far table.');
});

test('insertAfterParagraphs places images after the right paragraph, multi-insert keeps offsets', () => {
    const ps = splitParagraphs(mes, 1);
    const out = insertAfterParagraphs(mes, ps, [{ p: 1, snippet: imageSnippet('/a.png', 'A') }, { p: 2, snippet: imageSnippet('/b.png', 'B') }]);
    const i1 = out.indexOf('/a.png'), i2 = out.indexOf('/b.png'), hall = out.indexOf('The hall');
    assert.ok(i1 > 0 && i1 < hall, 'image A before paragraph 2');
    assert.ok(i2 > hall && i2 < out.indexOf('```'), 'image B after paragraph 2, before code');
    assert.equal(countImages(out), 2);
    assert.equal(stripImages(out), mes);
});

test('re-split after insertion ignores image blocks', () => {
    const ps = splitParagraphs(mes, 1);
    const out = insertAfterParagraphs(mes, ps, [{ p: 1, snippet: imageSnippet('/a.png') }]);
    const again = splitParagraphs(out, 1);
    assert.ok(again.every(p => !p.text.includes('ifimgen')));
});

test('parsePlan: tolerant JSON, drops invalid/duplicate paragraphs, sorted', () => {
    const plan = parsePlan('Sure!\n[{"p":2,"prompt":"b"},{"p":9,"prompt":"x"},{"p":1,"prompt":"a"},{"p":2,"prompt":"dup"},{"p":1,"prompt":""}]', [1, 2, 3]);
    assert.deepEqual(plan, [{ p: 1, prompt: 'a' }, { p: 2, prompt: 'b' }]);
    assert.deepEqual(parsePlan('garbage', [1]), []);
});

test('renderPlannerPrompt fills placeholders', () => {
    const { system, user } = renderPlannerPrompt(BUILTIN_PRESETS[0], { paragraphs: [{ index: 1, text: 'x' }], count: 2, roster: '$a — character: A', context: '', dialect: 'natural' });
    assert.ok(system.includes('exactly 2 objects'));
    assert.ok(system.includes('natural-language'));
    assert.ok(!system.includes('{{'));
    assert.ok(user.includes('[1] x') && user.includes('ROSTER'));
});

const s = defaultSettings();
const lyna = createEntity('characters', { name: 'Lyna', keyword: 'lyna', aliases: 'Ly, dark elf', tags: '1girl, silver hair', loras: ['<lora:lyna:0.8>'], loraPosition: 'front', bind: { characters: ['lyna.png'] } });
const me = createEntity('personas', { name: 'Me', keyword: 'me', tags: 'pov, male hands', bind: { always: true } });
const style = createEntity('styles', { name: 'Anime', keyword: 'anime', tags: 'anime style, flat color', loras: ['<lora:anime:0.5>'], loraPosition: 'after_style', negative: 'realistic' });
s.data.characters.push(lyna); s.data.personas.push(me); s.data.styles.push(style); s.defaultStyleId = style.id;

test('matchByKeyword: $keyword, alias, diacritics, underscore~space, no partial', () => {
    assert.equal(matchByKeyword([lyna], '$lyna smiles').length, 1);
    assert.equal(matchByKeyword([lyna], 'the Dark Elf waits').length, 1);
    assert.equal(matchByKeyword([lyna], 'Lýna').length, 1);
    assert.equal(matchByKeyword([lyna], 'lynazor').length, 0);
});

test('resolveEntities: no keyword -> bound entities; keyword -> only the named ones; default style', () => {
    const r = resolveEntities(s, { text: 'a quiet room', charAvatar: 'lyna.png', personaAvatar: 'x' });
    assert.equal(r.characters[0].id, lyna.id, 'bound char used when planner named nobody');
    assert.equal(r.personas[0].id, me.id);
    assert.equal(r.style.id, style.id);
    const r2 = resolveEntities(s, { text: 'a quiet room', charAvatar: 'other.png' });
    assert.equal(r2.characters.length, 0);
    // two-person roster, planner mentions only $lyna -> the always-bound persona must NOT be stamped on
    const solo = resolveEntities(s, { text: '$lyna sleeps alone', charAvatar: 'lyna.png' });
    assert.equal(solo.characters.length, 1); assert.equal(solo.personas.length, 0);
    const both = resolveEntities(s, { text: '$lyna leans on $me', charAvatar: 'lyna.png' });
    assert.equal(both.characters.length, 1); assert.equal(both.personas.length, 1);
});

test('planner prompt tells the LLM to describe the scene, not the character sheet', () => {
    const { system } = renderPlannerPrompt(BUILTIN_PRESETS[0], { paragraphs: [{ index: 1, text: 'x' }], count: 1, roster: '$a — character: A', context: '', dialect: 'natural' });
    assert.ok(/NOT a character sheet/i.test(system));
    assert.ok(/NEVER re-describe/i.test(system));
    assert.ok(system.includes('EXAMPLE'));
});

test('compilePrompt order: front lora, quality, style, after_style lora, char, persona, scene; NAI strips lora', () => {
    const ents = resolveEntities(s, { text: '$lyna sits by the window next to $me', charAvatar: 'lyna.png' });
    const { prompt, negative } = compilePrompt({ scene: '$lyna sits by the window next to $me', ...ents, settings: s, backend: 'sd' });
    const idx = k => prompt.indexOf(k);
    assert.ok(idx('<lora:lyna') < idx('masterpiece') && idx('masterpiece') < idx('anime style') && idx('anime style') < idx('<lora:anime') && idx('<lora:anime') < idx('1girl') && idx('1girl') < idx('pov') && idx('pov') < idx('sits by'));
    assert.ok(prompt.includes('Lyna sits by the window') && !prompt.includes('$lyna'));
    assert.ok(negative.includes('realistic') && negative.startsWith('lowres'));
    const nai = compilePrompt({ scene: 'x', ...ents, settings: s, backend: 'nai' });
    assert.ok(!nai.prompt.includes('<lora:'));
});

test('compilePrompt: quality/negative toggles', () => {
    const ents = resolveEntities(s, { text: 'x', charAvatar: 'lyna.png' });
    const s2 = structuredClone(s); s2.generate.useQualityPrefix = false; s2.generate.useNegative = false;
    const r = compilePrompt({ scene: 'x', ...ents, settings: s2, backend: 'sd' });
    assert.ok(!r.prompt.includes('masterpiece'));
    assert.equal(r.negative, '', 'negative fully suppressed incl. entity negatives');
});

test('modelParams: profile > fallback > defaults; effectiveParams: overrides win', () => {
    assert.deepEqual(modelParams(s, 'sd', 'foo'), PARAM_DEFAULTS.sd);
    s.connection.profiles.sd['*'] = { steps: 30 };
    s.connection.profiles.sd['modelA'] = { cfg: 4, width: 1024 };
    s.connection.sd.model = 'modelA';
    assert.ok(hasProfile(s, 'sd', 'modelA') && !hasProfile(s, 'sd', 'modelB'));
    const p0 = effectiveParams(s, 'sd');
    assert.equal(p0.steps, 30); assert.equal(p0.cfg, 4); assert.equal(p0.width, 1024); assert.equal(p0.model, 'modelA'); assert.equal(p0.sampler, 'Euler a');
    s.generate.overrides.steps = 12;
    assert.equal(effectiveParams(s, 'sd').steps, 12);
});

test('settings migration v1 -> v2 moves sampler/steps into model profiles', () => {
    const store = { IF_Imgen: { version: 1, connection: { backend: 'sd', sd: { url: 'u', model: 'ckpt', steps: 33, cfg: 7, width: 640, height: 960, sampler: 'DPM++ 2M', scheduler: 'Karras' }, nai: { apiKey: '', model: 'nai-diffusion-3' } } } };
    const m = ensureSettings(store);
    assert.equal(m.version, SETTINGS_VERSION);
    assert.equal(m.connection.sd.steps, undefined);
    assert.deepEqual(m.connection.profiles.sd['ckpt'], { sampler: 'DPM++ 2M', scheduler: 'Karras', steps: 33, cfg: 7, width: 640, height: 960 });
    assert.equal(m.connection.profiles.sd['*'].steps, 33);
    assert.equal(m.connection.profiles.nai['*'], undefined, 'nai had no legacy params');
    assert.equal(m.generate.useNegative, true, 'new keys filled');
    const fresh = ensureSettings({});
    assert.equal(fresh.version, SETTINGS_VERSION); assert.deepEqual(fresh.connection.profiles, { sd: {}, nai: {} });
});

test('image snippet: bare form (no title), URL-encoded; legacy title form still parsed + migrated', () => {
    assert.equal(safeImageUrl('/user/images/Don Rosario (x)/a.png'), '/user/images/Don%20Rosario%20%28x%29/a.png');
    const snip = imageSnippet('/user/images/Don Rosario/a.png');
    assert.equal(snip, IMG_MARK + String.fromCharCode(10) + '![IF Imgen](/user/images/Don%20Rosario/a.png)');
    assert.ok(!snip.includes('"'), 'no quotes -> ST <q> wrapper cannot break it');
    const legacy = ['p1', '', IMG_MARK, '![IF Imgen](/user/images/Don Rosario/old.png "old title")', '', snip].join(String.fromCharCode(10));
    const imgs = listImages(legacy);
    assert.equal(imgs.length, 2); assert.equal(imgs[0].url, '/user/images/Don Rosario/old.png'); assert.equal(imgs[0].title, 'old title');
    assert.equal(countImages(legacy), 2); assert.equal(stripImages(legacy), 'p1');
    const mg = migrateLegacyImages(legacy);
    assert.ok(mg.changed); assert.equal(mg.recovered.length, 1); assert.equal(mg.recovered[0].url, '/user/images/Don%20Rosario/old.png');
    assert.ok(!mg.mes.includes('"old title"') && mg.mes.includes('(/user/images/Don%20Rosario/old.png)'));
    assert.equal(migrateLegacyImages(mg.mes).changed, false, 'idempotent');
    const g = collectChatImages([{ name: 'A', mes: 'no image' }, { name: 'B', mes: mg.mes, extra: { ifimgen: [{ url: '/user/images/Don%20Rosario/old.png', scene: 'S', prompt: 'P' }] } }]);
    assert.equal(g.length, 2); assert.equal(g[0].messageId, 1); assert.equal(g[0].scene, 'S'); assert.equal(g[1].prompt, '');
    const rep = replaceImageUrl(mg.mes, '/user/images/Don%20Rosario/a.png', '/user/images/Don Rosario/b.png');
    assert.ok(rep.includes('(/user/images/Don%20Rosario/b.png)') && !rep.includes('/a.png'));
    assert.equal(removeImageByUrl(rep, '/user/images/Don%20Rosario/b.png'), ['p1', '', IMG_MARK, '![IF Imgen](/user/images/Don%20Rosario/old.png)'].join(String.fromCharCode(10)));
});

test('facets: parse "key: text" lines, merge duplicate keys, roundtrip', () => {
    const f = parseFacets('outfit: white shirt\n$Back: big tattoo on left shoulder\nback: small scar\ngarbage line\nNSFW : pierced navel');
    assert.deepEqual(f, [{ key: 'outfit', text: 'white shirt' }, { key: 'back', text: 'big tattoo on left shoulder, small scar' }, { key: 'nsfw', text: 'pierced navel' }]);
    assert.equal(facetsText(f).split(String.fromCharCode(10)).length, 3);
    assert.deepEqual(createEntity('styles', { facets: 'x: y' }).facets, [], 'styles have no facets');
});

const yenka = createEntity('personas', { name: 'Yenka', keyword: 'yenka', natural: 'Yenka is a small girl with dark parted hair and black eyes', facets: 'outfit: white button-up shirt\nback: a big tattoo on left shoulder back' });
const rosario = createEntity('characters', { name: 'Rosario', keyword: 'rosario', natural: 'a tall mature man', facets: 'front: scar across the chest' });

test('expandScene: $kw.facet, $char.facet, $userOutfit forms; unknown tokens dropped; used-map tracks facets', () => {
    const r = expandScene({ scene: '$yenka turns her back walking in the rain, wet $yenka.outfit clinging to her skin showing $yenka.back; $rosario watches, $char.front visible, $userOutfit, $yenka.nope $ghost', characters: [rosario], personas: [yenka] });
    assert.equal(r.text, 'Yenka turns her back walking in the rain, wet white button-up shirt clinging to her skin showing a big tattoo on left shoulder back; Rosario watches, scar across the chest visible, white button-up shirt, Yenka');
    assert.deepEqual([...r.used.get(yenka.id)].sort(), ['back', 'outfit']);
    assert.deepEqual([...r.used.get(rosario.id)], ['front']);
    assert.deepEqual(r.unknown, ['$yenka.nope', '$ghost']);
});

test('roster lists detail tokens so the planner knows what exists', () => {
    const line = rosterLine(yenka, 'user persona');
    assert.ok(line.includes('$yenka') && line.includes('$yenka.outfit, $yenka.back'));
    const s3 = defaultSettings(); s3.data.personas.push(yenka);
    assert.ok(rosterText(s3, {}).includes('details: $yenka.outfit'));
});

test('refine prompt: cast carries base look + only referenced details; style + expanded scene included', () => {
    const scene = '$yenka walks away in the rain showing $yenka.back';
    const ex = expandScene({ scene, characters: [rosario], personas: [yenka] });
    const { system, user } = buildRefinePrompt({ system: '', dialect: 'natural', scene, expanded: ex.text, used: ex.used, characters: [rosario], personas: [yenka], style: style });
    assert.ok(system.includes('60-110 words') && !system.includes('{{'));
    assert.ok(user.includes('Yenka (user persona): Yenka is a small girl'));
    assert.ok(user.includes('- back: a big tattoo') && !user.includes('- outfit:'), 'only referenced facets listed');
    assert.ok(user.includes('Rosario (character): a tall mature man') && !user.includes('- front:'));
    assert.ok(user.includes('STYLE: anime style') && user.includes('SCENE') && user.includes(ex.text));
});

test('compilePrompt merged=true: cast fragments not prepended (refine already merged them), LoRA/negative/style still applied', () => {
    const ents = resolveEntities(s, { text: '$lyna x', charAvatar: 'lyna.png' });
    const a = compilePrompt({ scene: 'REFINED TEXT', ...ents, settings: s, backend: 'sd' });
    const b = compilePrompt({ scene: 'REFINED TEXT', ...ents, settings: s, backend: 'sd', merged: true });
    assert.ok(a.prompt.includes('1girl, silver hair') && !b.prompt.includes('1girl, silver hair'));
    assert.ok(b.prompt.includes('<lora:lyna') && b.prompt.includes('anime style') && b.prompt.includes('REFINED TEXT'));
    assert.equal(a.negative, b.negative);
});

test('planner rules mention detail tokens', () => {
    const { system } = renderPlannerPrompt(BUILTIN_PRESETS[0], { paragraphs: [{ index: 1, text: 'x' }], count: 1, roster: '', context: '', dialect: 'tags' });
    assert.ok(system.includes('DETAILS:') && system.includes('$yenka.back'));
});

test('binding: chat id / card avatar / persona avatar / always -- identifiers only', () => {
    const e = createEntity('characters', { name: 'B', bind: { chats: ['Lyna - 2026-09-01@10h.jsonl'], characters: ['lyna.png'] } });
    assert.ok(isBound(e, { chatId: 'Lyna - 2026-09-01@10h.jsonl' }));
    assert.ok(isBound(e, { charAvatar: 'lyna.png' }));
    assert.ok(!isBound(e, { chatId: 'other.jsonl', charAvatar: 'other.png' }));
    assert.ok(isBound(createEntity('styles', { name: 'S', bind: { always: true } }), {}));
    const r = resolveEntities(s, { text: 'no keywords here', chatId: 'x.jsonl', charAvatar: 'nobody.png' });
    assert.equal(r.characters.length, 0, 'unbound chat + unbound card -> nothing auto-attached');
    assert.deepEqual(createEntity('characters', { name: 'L', bind: { characters: ['a.png'] } }).bind.chats, [], 'legacy entity without bind.chats still loads');
});

test('LLM isolation: raw request (no preset/instruct merge), no card fields read anywhere', () => {
    const llm = readFileSync(new URL('../src/llm.js', import.meta.url), 'utf8');
    assert.ok(/includePreset:\s*false/.test(llm) && /includeInstruct:\s*false/.test(llm), 'profile request must not merge ST prompt preset');
    const src = ['pipeline', 'entities', 'scene', 'prompt', 'presets', 'llm', 'gallery', 'ui'].map(f => readFileSync(new URL('../src/' + f + '.js', import.meta.url), 'utf8')).join(String.fromCharCode(10));
    for (const field of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'depth_prompt', 'character_book', 'world_info']) {
        assert.ok(!new RegExp('\\.' + field + '\\b').test(src), 'card field "' + field + '" must never be read');
    }
});

test('style: only the default style applies; keyword/binding on styles are ignored; missing default is auto-picked', () => {
    const s3 = structuredClone(s);
    const other = createEntity('styles', { name: 'Other', keyword: 'other', tags: 'oil painting', bind: { always: true } });
    s3.data.styles.push(other);
    const r = resolveEntities(s3, { text: '$other painting of $lyna', charAvatar: 'lyna.png' });
    assert.equal(r.style.id, style.id, 'default wins over keyword and always-bound style');
    s3.defaultStyleId = 'missing';
    const fixed = ensureSettings({ IF_Imgen: s3 });
    assert.equal(fixed.defaultStyleId, other.id, 'auto-pick prefers a legacy always-bound style');
    fixed.data.styles.length = 0; fixed.defaultStyleId = '';
    assert.equal(resolveEntities(fixed, { text: 'x' }).style, null);
});

test('import/export roundtrip + keyword dedupe', () => {
    const list = [];
    const r = importEntities('characters', list, exportEntities('characters', [lyna]));
    assert.equal(r.added, 1);
    const r2 = importEntities('characters', list, { items: [{ name: 'Lyna 2', keyword: 'lyna' }] });
    assert.equal(r2.updated, 1); assert.equal(list.length, 1);
    assert.ok(importEntities('characters', list, {}).errors.length === 1);
});

if (process.exitCode) { console.log(`\nFAIL (${passed} passed)`); process.exit(1); }
console.log(`PASS (${passed} cases)`);
