#!/usr/bin/env node
// IF Imgen - pure-module tests (no DOM, no ST). Run: node scripts/test-core.mjs
import assert from 'node:assert/strict';
import { splitParagraphs, insertAfterParagraphs, imageSnippet, stripImages, countImages, listImages, safeImageUrl, IMG_MARK } from '../src/paragraphs.js';
import { parsePlan, renderPlannerPrompt, BUILTIN_PRESETS } from '../src/presets.js';
import { createEntity, matchByKeyword, resolveEntities, importEntities, exportEntities } from '../src/entities.js';
import { compilePrompt, effectiveParams, modelParams, hasProfile } from '../src/prompt.js';
import { defaultSettings, ensureSettings, PARAM_DEFAULTS, SETTINGS_VERSION } from '../src/settings.js';
import { collectChatImages } from '../src/gallery.js';

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

test('resolveEntities: keyword + binding + default style', () => {
    const r = resolveEntities(s, { text: 'a quiet room', charAvatar: 'lyna.png', personaAvatar: 'x' });
    assert.equal(r.characters[0].id, lyna.id);
    assert.equal(r.personas[0].id, me.id);
    assert.equal(r.style.id, style.id);
    const r2 = resolveEntities(s, { text: 'a quiet room', charAvatar: 'other.png' });
    assert.equal(r2.characters.length, 0);
});

test('compilePrompt order: front lora, quality, style, after_style lora, char, persona, scene; NAI strips lora', () => {
    const ents = resolveEntities(s, { text: '$lyna sits by the window', charAvatar: 'lyna.png' });
    const { prompt, negative } = compilePrompt({ scene: '$lyna sits by the window', ...ents, settings: s, backend: 'sd' });
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

test('image URLs: spaces/parens encoded so markdown renders; listImages + gallery tolerate legacy URLs', () => {
    assert.equal(safeImageUrl('/user/images/Don Rosario (x)/a.png'), '/user/images/Don%20Rosario%20%28x%29/a.png');
    const snip = imageSnippet('/user/images/Don Rosario/a.png', 'a "quoted" title');
    assert.ok(snip.includes('(/user/images/Don%20Rosario/a.png "a  quoted  title")'));
    const legacy = ['p1', '', IMG_MARK, '![IF Imgen](/user/images/Don Rosario/old.png "old title")', '', snip].join(String.fromCharCode(10));
    const imgs = listImages(legacy);
    assert.equal(imgs.length, 2); assert.equal(imgs[0].url, '/user/images/Don Rosario/old.png'); assert.equal(imgs[0].title, 'old title');
    assert.equal(countImages(legacy), 2); assert.equal(stripImages(legacy), 'p1');
    const g = collectChatImages([{ name: 'A', mes: 'no image' }, { name: 'B', mes: legacy }]);
    assert.equal(g.length, 2); assert.equal(g[0].messageId, 1); assert.equal(g[0].url, '/user/images/Don%20Rosario/old.png');
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
