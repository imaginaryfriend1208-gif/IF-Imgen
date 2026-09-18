#!/usr/bin/env node
import { readFileSync } from 'node:fs';
// IF Imgen - pure-module tests (no DOM, no ST). Run: node scripts/test-core.mjs
import assert from 'node:assert/strict';
import { splitParagraphs, insertAfterParagraphs, imageSnippet, stripImages, stripImagesLoose, stripForeignImages, countImages, listImages, safeImageUrl, IMG_MARK, migrateLegacyImages, replaceImageUrl, removeImageByUrl } from '../src/paragraphs.js';
import { parsePlan, renderPlannerPrompt, BUILTIN_PRESETS, allPresets, findPreset, overwritePreset, resetPreset, createPreset, extractJsonArray, presetDialect, effectiveDialect } from '../src/presets.js';
import { createEntity, matchByKeyword, resolveEntities, importEntities, exportEntities } from '../src/entities.js';
import { compilePrompt, effectiveParams, modelParams, hasProfile, softenTags, modelPromptPrefs } from '../src/prompt.js';
import { defaultSettings, ensureSettings, PARAM_DEFAULTS, SETTINGS_VERSION } from '../src/settings.js';
import { collectChatImages, collectProfileImages } from '../src/gallery.js';
import { compareVersions } from '../src/util.js';
import { abortable, createPipeline } from '../src/pipeline.js';
import { parseFacets, facetsText, expandScene, expandSceneDoc, buildRefinePrompt, buildScenePrompt, parseRefined, rosterLine, DEFAULT_SCENE_SYSTEM } from '../src/scene.js';
import { rosterText, isBound, isActive, activeProfileFor, bindReason } from '../src/entities.js';
import { parseWorkflow, workflowInfo, renderWorkflow, autoMapWorkflow, extractLoras, injectLoras, PLACEHOLDERS } from '../src/comfy.js';
import { buildProfilePrompt, parseProfilePrompt, profileDraft, profileFacets, PROFILE_SHOTS, DEFAULT_PROFILE_SYSTEM } from '../src/profile.js';
import { normalizeProfile, PROFILE_VERSIONS } from '../src/entities.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; } };

const testAsync = async (name, fn) => { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}
    ${e.message}`); process.exitCode = 1; } };

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

test('echoed image markdown: stripImagesLoose drops everything (prompt copy), stripForeignImages keeps only this message\'s own images', () => {
    const NL = String.fromCharCode(10);
    const own = imageSnippet('/user/images/A/own.png');
    const echoed = '![IF Imgen](/user/images/A/old.png)';               // copied by the chat LLM without the marker
    const echoed2 = IMG_MARK + NL + '![IF Imgen](/user/images/A/old2.png)'; // copied with the marker
    const mes = ['p1', '', own, '', 'p2', '', echoed, '', 'p3', '', echoed2, '', IMG_MARK, 'p4'].join(NL);
    assert.equal(stripImagesLoose(mes), ['p1', '', 'p2', '', 'p3', '', 'p4'].join(NL));
    const cleaned = stripForeignImages(mes, ['/user/images/A/own.png']);
    assert.ok(cleaned.includes('own.png') && !cleaned.includes('old.png') && !cleaned.includes('old2.png'), 'foreign images removed, own kept');
    assert.equal(countImages(cleaned), 1, 'stray marker removed, own marker kept');
    assert.equal(stripImages(cleaned), ['p1', '', 'p2', '', 'p3', '', 'p4'].join(NL));
    assert.equal(stripForeignImages('plain reply', []), 'plain reply');
    assert.equal(stripForeignImages(own, ['/user/images/A/own.png']), own, 'own-only message untouched');
    // a brand-new reply where the LLM echoed one old picture: nothing is "known" -> text becomes clean -> auto-run proceeds
    assert.equal(countImages(stripForeignImages('Hello.' + NL + NL + echoed2, [])), 0);
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
    const { system, user } = renderPlannerPrompt(BUILTIN_PRESETS[0], { paragraphs: [{ index: 1, text: 'x' }], count: 2, roster: '$a — character: A', context: 'earlier', dialect: 'natural' });
    assert.ok(system.includes('exactly 2 objects'));
    assert.ok(system.includes('natural-language'));
    assert.ok(!system.includes('{{'));
    assert.ok(user.includes('[1] x') && user.includes('ROSTER') && user.includes('EARLIER CONTEXT'));
    assert.ok(user.includes('Choose 2 paragraph(s)'));
});

test('step 2 (translate): scene document is authoritative and replaces the raw context; fixed = one prompt per listed paragraph', () => {
    const doc = 'SCENE: quiet evening\nLOCATION: indoors, bedroom, night';
    const { system, user } = renderPlannerPrompt(BUILTIN_PRESETS[0], { paragraphs: [{ index: 2, text: 'y' }, { index: 5, text: 'z' }], count: 2, roster: '', context: 'earlier', dialect: 'tags', sceneDoc: doc, fixed: true });
    assert.ok(system.includes('SCENE DOCUMENT') && system.includes('TRANSLATE'), 'rules explain the translation step');
    assert.ok(user.includes('SCENE DOCUMENT (authoritative') && user.includes(doc));
    assert.ok(!user.includes('EARLIER CONTEXT'), 'document supersedes the raw context');
    assert.ok(user.indexOf('SCENE DOCUMENT') < user.indexOf('LATEST REPLY'));
    assert.ok(user.includes('one prompt for EACH of the 2 paragraph(s)') && !user.includes('Choose 2'), 'fixed keeps every image slot');
    assert.ok(system.includes('colour'), 'tag dialect asks for garment colours + state');
    // The document contract is appended to ANY preset (user-made / overridden too) and only when a document exists.
    const mine = createPreset({ name: 'mine', system: 'custom {{count}} {{dialect_rule}}' });
    const withDoc = renderPlannerPrompt(mine, { paragraphs: [{ index: 1, text: 'x' }], count: 1, roster: '', dialect: 'natural', sceneDoc: doc });
    assert.ok(withDoc.system.startsWith('custom 1') && withDoc.system.includes('SCENE DOCUMENT RULES') && withDoc.system.includes('WEARING lines with colours and state'));
    assert.ok(withDoc.system.includes('110-170 words') && !withDoc.system.includes('{{'), 'doc length rule follows the dialect, no leftover placeholder');
    assert.ok(withDoc.system.includes('EXAMPLE with a document (prose;'), 'doc example follows the dialect');
    // Krea / NAI presets force their dialect regardless of the global setting; length macros follow doc / no doc.
    const krea = BUILTIN_PRESETS.find(p => p.id === 'krea_natural'), nai = BUILTIN_PRESETS.find(p => p.id === 'nai_tags');
    const k = renderPlannerPrompt(krea, { paragraphs: [{ index: 1, text: 'x' }], count: 1, roster: '', dialect: 'tags' });
    assert.ok(k.system.includes('PROSE PROMPT') && k.system.includes('80-130 words') && k.system.includes('Krea / Flux') && !k.system.includes('TAG PROMPT') && !k.system.includes('{{'));
    const n = renderPlannerPrompt(nai, { paragraphs: [{ index: 1, text: 'x' }], count: 1, roster: '', dialect: 'natural', sceneDoc: doc });
    assert.ok(n.system.includes('TAG PROMPT') && n.system.includes('40-65 tags') && n.system.includes('NovelAI') && n.system.includes('CONTACT CHAIN') && !n.system.includes('PROSE PROMPT') && !n.system.includes('{{'));
    assert.equal(presetDialect(krea, 'tags'), 'natural'); assert.equal(presetDialect(BUILTIN_PRESETS[0], 'natural'), 'natural'); assert.equal(presetDialect(BUILTIN_PRESETS[0], 'bogus'), 'tags');
    assert.equal(createPreset({ name: 'fork', system: 'x', dialect: 'natural' }).dialect, 'natural'); assert.equal(createPreset({ name: 'plain', system: 'x' }).dialect, undefined);
    assert.ok(withDoc.system.includes('WEARING lines with colours and state'), 'doc rules still ask for clothing in words');
    assert.ok(withDoc.user.includes('translate the SCENE DOCUMENT'));
    const noDoc = renderPlannerPrompt(mine, { paragraphs: [{ index: 1, text: 'x' }], count: 1, roster: '', dialect: 'tags' });
    assert.ok(!noDoc.system.includes('SCENE DOCUMENT RULES') && !noDoc.system.includes('{{'));
    assert.equal(defaultSettings().connection.llm.maxTokens, 8000);
    assert.equal(ensureSettings({ IF_Imgen: { version: 3, connection: { llm: { maxTokens: 1200 } } } }).connection.llm.maxTokens, 8000, 'old default raised');
    assert.equal(ensureSettings({ IF_Imgen: { version: 3, connection: { llm: { maxTokens: 900 } } } }).connection.llm.maxTokens, 8000, 'v4 lifts small caps');
    assert.equal(ensureSettings({ IF_Imgen: { version: 3, connection: { llm: { maxTokens: 12000 } } } }).connection.llm.maxTokens, 12000, 'larger user value kept');
});

const s = defaultSettings();
const lyna = createEntity('characters', { name: 'Lyna', keyword: 'lyna', aliases: 'Ly, dark elf', tags: '1girl, silver hair', loras: ['<lora:lyna:0.8>'], loraPosition: 'front', bind: { characters: ['lyna.png'] } });
const me = createEntity('personas', { name: 'Me', keyword: 'me', tags: 'pov, male hands', bind: { always: true, personas: ['x'] } });
const style = createEntity('styles', { name: 'Anime', keyword: 'anime', tags: 'anime style, flat color', loras: ['<lora:anime:0.5>'], loraPosition: 'after_style', negative: 'realistic' });
s.data.characters.push(lyna); s.data.personas.push(me); s.data.styles.push(style); s.defaultStyleId = style.id;

test('matchByKeyword: $keyword, alias, diacritics, underscore~space, no partial', () => {
    assert.equal(matchByKeyword([lyna], '$lyna smiles').length, 1);
    assert.equal(matchByKeyword([lyna], 'the Dark Elf waits').length, 1);
    assert.equal(matchByKeyword([lyna], 'Lýna').length, 1);
    assert.equal(matchByKeyword([lyna], 'lynazor').length, 0);
});

test('Vietnamese: "Dư Tô" -> $du_to, alias with space, diacritic text matches, facet keys with diacritics, $Dư_Tô token expands', () => {
    const duTo = createEntity('characters', { name: 'Dư Tô', keyword: 'Dư Tô', aliases: 'Anh Dư', natural: 'a tall man', facets: 'trang phục: áo dài trắng\nlưng: hình xăm rồng' });
    assert.equal(duTo.keyword, 'du_to');
    assert.deepEqual(duTo.aliases, ['anh_du']);
    assert.deepEqual(duTo.facets.map(f => f.key), ['trang_phuc', 'lung']);
    assert.equal(matchByKeyword([duTo], 'Dư Tô ngồi xuống ghế').length, 1);
    assert.equal(matchByKeyword([duTo], 'anh Dư bước vào').length, 1);
    assert.equal(matchByKeyword([duTo], 'du toi').length, 0, 'no partial match');
    assert.ok(rosterLine(duTo, 'character').includes('$du_to.trang_phuc'));
    const r = expandScene({ scene: '$du_to đứng quay lưng, $du_to.trang_phuc ướt, lộ $Dư_Tô.lưng', characters: [duTo], personas: [] });
    assert.equal(r.text, 'Dư Tô đứng quay lưng, áo dài trắng ướt, lộ hình xăm rồng');
    assert.deepEqual(r.unknown, []);
});

test('resolveEntities: no keyword -> official entities; keyword -> only the named ones; default style', () => {
    const r = resolveEntities(s, { text: 'a quiet room', charAvatar: 'lyna.png', personaAvatar: 'x' });
    assert.equal(r.characters[0].id, lyna.id, 'official char used when planner named nobody');
    assert.equal(r.personas[0].id, me.id, 'official persona too');
    assert.equal(resolveEntities(s, { text: 'a quiet room', charAvatar: 'lyna.png', personaAvatar: 'other' }).personas.length, 0, 'always alone never auto-loads');
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
    assert.ok(/Do NOT repeat a person's base look/i.test(system));
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
    assert.equal(fresh.connection.sd.useWorkflow, false);
    assert.equal(fresh.generate.floater, true, 'floating quick-action button on by default'); assert.equal(fresh.generate.floaterPos, null);
    assert.equal(ensureSettings({ IF_Imgen: { version: 2, generate: { floater: false, floaterPos: { x: 10, y: 20 } } } }).generate.floater, false, 'user choice kept');
    // v0.10.0 transitional "comfy" backend folds into sd (workflow, url, model, profiles, active backend).
    const old = ensureSettings({ IF_Imgen: { version: 2, connection: { backend: 'comfy', sd: { url: 'http://a', model: '' }, comfy: { url: 'http://c:8188', model: 'k.safetensors', workflow: '{"1":{"class_type":"KSampler","inputs":{}}}' }, profiles: { sd: {}, comfy: { 'k.safetensors': { steps: 8 } }, nai: {} } } } });
    assert.equal(old.connection.backend, 'sd'); assert.equal(old.connection.sd.useWorkflow, true); assert.equal(old.connection.sd.url, 'http://c:8188');
    assert.equal(old.connection.sd.model, 'k.safetensors'); assert.equal(old.connection.profiles.sd['k.safetensors'].steps, 8);
    assert.equal(old.connection.comfy, undefined); assert.equal(old.connection.profiles.comfy, undefined);
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
    assert.ok(line.includes('$yenka') && line.includes('$yenka.outfit:') && line.includes('$yenka.back:'));
    const s3 = defaultSettings(); s3.data.personas.push(createEntity('personas', { ...yenka, bind: { personas: ['yenka.png'] } }));
    assert.ok(rosterText(s3, { personaAvatar: 'yenka.png' }).includes('$yenka.outfit:'), 'bound persona listed with its detail texts');
    assert.ok(!rosterText(s3, { personaAvatar: 'other.png' }).includes('$yenka'), 'not in play -> not offered to the LLM');
});

test('refine prompt: cast carries base look + only referenced details; style + expanded scene included', () => {
    const scene = '$yenka walks away in the rain showing $yenka.back';
    const ex = expandScene({ scene, characters: [rosario], personas: [yenka] });
    const { system, user } = buildRefinePrompt({ system: '', dialect: 'natural', scene, expanded: ex.text, used: ex.used, characters: [rosario], personas: [yenka], style: style });
    assert.ok(system.includes('natural-language paragraph') && !system.includes('{{'));
    assert.ok(user.includes('Yenka (user persona): Yenka is a small girl'));
    assert.ok(user.includes('- back: a big tattoo') && !user.includes('- outfit:'), 'only referenced facets listed');
    assert.ok(user.includes('Rosario (character): a tall mature man') && !user.includes('- front:'));
    assert.ok(user.includes('STYLE: anime style') && user.includes('SHOT DRAFTS') && user.includes(ex.text));
    assert.ok(system.includes('exactly 1 objects'), '{{count}} filled');
});

test('batch refine: ONE call carries the scene document + all shots; facets of every shot listed once; parseRefined maps by index', () => {
    const s1 = expandScene({ scene: '$yenka walks away showing $yenka.back', characters: [rosario], personas: [yenka] });
    const s2 = expandScene({ scene: '$rosario shows $rosario.front to $yenka', characters: [rosario], personas: [yenka] });
    const { system, user } = buildRefinePrompt({ system: '', dialect: 'tags', setting: 'LOCATION: rainy street', shots: [{ expanded: s1.text, used: s1.used }, { expanded: s2.text, used: s2.used }], characters: [rosario], personas: [yenka], style: null });
    assert.ok(system.includes('exactly 2 objects') && system.includes('danbooru'));
    assert.ok(user.indexOf('SCENE DOCUMENT') < user.indexOf('CAST:') && user.includes('LOCATION: rainy street'));
    assert.ok(user.includes('[1] ' + s1.text) && user.includes('[2] ' + s2.text));
    assert.ok(user.includes('- back: a big tattoo') && user.includes('- front: scar') && (user.match(/- back:/g) || []).length === 1);
    assert.deepEqual(parseRefined('ok\n[{"i":2,"prompt":"\\"B\\""},{"i":1,"prompt":"A"}]', 2), ['A', 'B']);
    assert.deepEqual(parseRefined('["x","y","z"]', 2), ['x', 'y'], 'extra items dropped');
    assert.deepEqual(parseRefined('[{"prompt":"only"}]', 2), ['only', ''], 'missing slot stays empty');
    assert.deepEqual(parseRefined('plain text prompt', 1), ['plain text prompt'], 'single shot tolerates plain text');
    assert.deepEqual(parseRefined('garbage', 2), ['', '']);
    assert.ok(system.includes('DOCUMENT wins'), 'refine: document overrides drafts / cast details');
    assert.ok(system.includes('keep the content of the draft'), 'refine polishes, never rewrites the content');
    // stale (pre-batch) refine system stored in settings -> replaced by the batch default on load
    const stale = { IF_Imgen: { ...defaultSettings(), generate: { ...defaultSettings().generate, refineSystem: 'You write prompts... Merge them into ONE final image prompt.' } } };
    assert.equal(ensureSettings(stale).generate.refineSystem, defaultSettings().generate.refineSystem);
    const custom = { IF_Imgen: { ...defaultSettings(), generate: { ...defaultSettings().generate, refineSystem: 'mine {{count}} {{dialect_rule}}' } } };
    assert.equal(ensureSettings(custom).generate.refineSystem, 'mine {{count}} {{dialect_rule}}', 'a custom batch-aware system is kept');
});

test('step 1 (scene document): sections, cast details, previous documents (oldest first) and context; settings v2 -> v3 migration', () => {
    const st = buildScenePrompt({ paragraphs: [{ index: 1, text: 'She stood in the rain.' }], context: 'earlier', characters: [rosario], personas: [yenka], previous: [{ id: 3, text: 'DOC A' }, { id: 7, text: 'DOC B' }] });
    for (const k of ['SCENE:', 'LOCATION:', 'LAYOUT:', 'PEOPLE PRESENT:', 'WEARING:', 'EXPRESSION:', 'DOING:', 'POSE / POSITION:', 'CONTINUITY:']) assert.ok(st.system.includes(k), `section ${k}`);
    assert.ok(st.system.includes('colour') && st.system.includes('WHERE it is'), 'clothing colours + prop placement demanded');
    assert.ok(st.system.includes('TOKENS:') && st.system.includes('$keyword.entry') && st.system.includes('NEW TOKENS'), 'planner is told to write tokens and define new ones');
    assert.ok(st.user.includes('$yenka.outfit: white button-up shirt') && st.user.includes('token $rosario') && st.user.includes('[1] She stood') && st.user.includes('EARLIER CONTEXT'));
    // Stored document keeps tokens; the downstream LLMs get words. Unknown tokens are kept, not dropped.
    const doc = 'PEOPLE PRESENT: 2 - $yenka, $rosario\n- $yenka\n  WEARING: $yenka.outfit, unbuttoned\n  POSE: back to viewer showing $yenka.back\n- $rosario\n  WEARING: $rosario.armor, dented';
    const ex = expandSceneDoc({ doc, characters: [rosario], personas: [yenka] });
    assert.ok(ex.text.includes('PEOPLE PRESENT: 2 - Yenka, Rosario'));
    assert.ok(ex.text.includes('WEARING: white button-up shirt, unbuttoned') && ex.text.includes('showing a big tattoo on left shoulder back'));
    assert.ok(ex.text.includes('WEARING: $rosario.armor, dented'), 'unknown detail token stays in place');
    assert.deepEqual(ex.unknown, ['$rosario.armor']);
    assert.ok(ex.text.split('\n').length === doc.split('\n').length, 'line structure untouched');
    assert.equal(expandScene({ scene: 'x $ghost y', characters: [], personas: [] }).text, 'x y', 'prompt drafts still drop unknown tokens');
    assert.ok(st.user.indexOf('DOC A') < st.user.indexOf('DOC B') && st.user.includes('document 2 of 2 (most recent)'), 'previous documents oldest first, latest marked');
    assert.ok(st.user.indexOf('PREVIOUS SCENE DOCUMENTS') < st.user.indexOf('LATEST REPLY'));
    assert.ok(buildScenePrompt({ paragraphs: [], characters: [], personas: [] }).user.includes('(none - this is the first illustrated reply)'));
    assert.equal(defaultSettings().generate.sceneSystem, DEFAULT_SCENE_SYSTEM);
    assert.equal(defaultSettings().generate.sceneHistory, 3);
    // v2 install: old scene-setting prompt dropped, refine system written against "SCENE SETTING" replaced, custom one kept
    const v2 = { IF_Imgen: { version: 2, generate: { settingSystem: 'old setting prompt', refineSystem: 'x SCENE SETTING y {{count}}' } } };
    const m = ensureSettings(v2);
    assert.equal(m.version, SETTINGS_VERSION); assert.equal(m.generate.settingSystem, undefined);
    assert.equal(m.generate.refineSystem, defaultSettings().generate.refineSystem, 'v2 refine prompt (SCENE SETTING contract) replaced');
    assert.equal(m.generate.sceneSystem, DEFAULT_SCENE_SYSTEM, 'new step-1 prompt filled in');
    const keep = ensureSettings({ IF_Imgen: { version: 2, generate: { refineSystem: 'mine {{count}}' } } });
    assert.equal(keep.generate.refineSystem, 'mine {{count}}');
});

test('compilePrompt merged=true: cast fragments not prepended (refine already merged them), LoRA/negative/style still applied', () => {
    const ents = resolveEntities(s, { text: '$lyna x', charAvatar: 'lyna.png' });
    const a = compilePrompt({ scene: 'REFINED TEXT', ...ents, settings: s, backend: 'sd' });
    const b = compilePrompt({ scene: 'REFINED TEXT', ...ents, settings: s, backend: 'sd', merged: true });
    assert.ok(a.prompt.includes('1girl, silver hair') && !b.prompt.includes('1girl, silver hair'));
    assert.ok(b.prompt.includes('<lora:lyna') && b.prompt.includes('anime style') && b.prompt.includes('REFINED TEXT'));
    assert.equal(a.negative, b.negative);
});

test('compilePrompt natural (Krea): softened cast, sentences not comma lists, no quality prefix, LoRAs kept; preset dialect wins over global', () => {
    const ents = resolveEntities(s, { text: '$lyna x', charAvatar: 'lyna.png' });
    const nat = compilePrompt({ scene: 'She leans on the railing, looking at the viewer', ...ents, settings: s, backend: 'sd', dialect: 'natural' });
    assert.ok(!nat.prompt.includes('masterpiece'), 'no quality prefix in prose');
    assert.ok(nat.prompt.includes('a young woman, silver hair'), '1girl -> a young woman: ' + nat.prompt);
    assert.ok(nat.prompt.includes('<lora:lyna'), 'LoRA token kept');
    assert.ok(/silver hair[^.]*\. /.test(nat.prompt) && nat.prompt.endsWith('viewer.'), 'fragments joined as sentences: ' + nat.prompt);
    assert.equal(softenTags('masterpiece, 1girl, (long_hair:1.2), {blue eyes}, [smile], score_9'), 'a young woman, long hair, blue eyes, smile');
    assert.equal(softenTags('A tall man with a scar. He wears a black coat, unbuttoned.'), 'A tall man with a scar. He wears a black coat, unbuttoned.');
    // effectiveDialect: preset forced dialect beats generate.dialect; plain presets follow the global one
    const st = defaultSettings(); st.generate.dialect = 'tags';
    st.generate.presetId = 'krea_natural'; assert.equal(effectiveDialect(st), 'natural');
    st.generate.presetId = 'nai_tags'; st.generate.dialect = 'natural'; assert.equal(effectiveDialect(st), 'tags');
    st.generate.presetId = BUILTIN_PRESETS[0].id; assert.equal(effectiveDialect(st), 'natural');
    const tagsOnly = compilePrompt({ scene: 'x', ...ents, settings: s, backend: 'sd' });
    assert.ok(tagsOnly.prompt.includes('1girl, silver hair'), 'default path unchanged (global tags)');
});

test('model profile prompt prefs: dialect / negative per model beat the global switch, preset-forced dialect beats both; auto aspect swaps the size', () => {
    const st = defaultSettings();
    st.connection.backend = 'sd'; st.connection.sd.model = 'krea.safetensors';
    st.connection.profiles.sd['krea.safetensors'] = { ...PARAM_DEFAULTS.sd, dialect: 'natural', useNegative: false };
    st.generate.dialect = 'tags'; st.generate.useNegative = true; st.generate.negative = 'lowres';
    assert.deepEqual(modelPromptPrefs(st, 'sd'), { dialect: 'natural', useNegative: false });
    assert.equal(effectiveDialect(st), 'natural', 'model profile dialect wins over generate.dialect');
    const ents = { characters: [], personas: [], style: null };
    const out = compilePrompt({ scene: 'A woman by a window', ...ents, settings: st, backend: 'sd' });
    assert.equal(out.negative, '', 'model profile turns the negative off');
    assert.ok(!out.prompt.includes('masterpiece'), 'prose path: no quality prefix');
    st.generate.presetId = 'nai_tags';
    assert.equal(effectiveDialect(st), 'tags', 'preset-forced dialect beats the model profile');
    st.connection.sd.model = 'other.safetensors';
    assert.deepEqual(modelPromptPrefs(st, 'sd'), { dialect: '', useNegative: '' }, 'model without prefs follows the global settings');
    // auto aspect: portrait profile 832x1216 -> landscape swaps, square uses the same pixel budget, off = untouched
    st.generate.autoAspect = true;
    assert.deepEqual([effectiveParams(st, 'sd', { ar: 'landscape' }).width, effectiveParams(st, 'sd', { ar: 'landscape' }).height], [1216, 832]);
    assert.deepEqual([effectiveParams(st, 'sd', { ar: 'portrait' }).width, effectiveParams(st, 'sd', { ar: 'portrait' }).height], [832, 1216]);
    const sq = effectiveParams(st, 'sd', { ar: 'square' }); assert.equal(sq.width, sq.height); assert.equal(sq.width % 64, 0); assert.ok(Math.abs(sq.width * sq.height - 832 * 1216) < 832 * 1216 * 0.1);
    st.generate.autoAspect = false;
    assert.deepEqual([effectiveParams(st, 'sd', { ar: 'landscape' }).width, effectiveParams(st, 'sd', { ar: 'landscape' }).height], [832, 1216], 'disabled -> profile size kept');
    // parsePlan keeps a valid "ar", drops garbage; the aspect rule is only rendered when enabled
    assert.deepEqual(parsePlan('[{"p":1,"prompt":"a","ar":"Landscape"},{"p":2,"prompt":"b","ar":"huge"}]', [1, 2]), [{ p: 1, prompt: 'a', ar: 'landscape' }, { p: 2, prompt: 'b' }]);
    const base = { paragraphs: [{ index: 1, text: 'x' }], count: 1, roster: '', dialect: 'tags' };
    assert.ok(renderPlannerPrompt(BUILTIN_PRESETS[0], { ...base, autoAspect: true }).system.includes('Add "ar" to every object'));
    const off = renderPlannerPrompt(BUILTIN_PRESETS[0], base).system;
    assert.ok(!off.includes('"ar"') && !off.includes('{{'));
});

test('planner rules mention detail tokens', () => {
    const { system } = renderPlannerPrompt(BUILTIN_PRESETS[0], { paragraphs: [{ index: 1, text: 'x' }], count: 1, roster: '', context: '', dialect: 'tags' });
    assert.ok(system.includes('TOKENS:') && system.includes('$yenka.back'));
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


// ---- ComfyUI workflow (the user's Krea2 graph, trimmed): switches, LoRA loaders, size-preset math nodes.
const KREA = {
    '29': { inputs: { filename_prefix: 'Krea2_turbo', images: ['30:8', 0] }, class_type: 'SaveImage' },
    '30:6': { inputs: { text: 'A woman holds an ice cream cone.', clip: ['30:11', 0] }, class_type: 'CLIPTextEncode' },
    '30:5': { inputs: { width: ['30:55', 1], height: ['30:56', 1], batch_size: 1 }, class_type: 'EmptyLatentImage' },
    '30:3': { inputs: { seed: 749157341333067, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['30:26', 0], positive: ['30:6', 0], negative: ['30:13', 0], latent_image: ['30:5', 0] }, class_type: 'KSampler' },
    '30:8': { inputs: { samples: ['30:3', 0], vae: ['30:12', 0] }, class_type: 'VAEDecode' },
    '30:10': { inputs: { ckpt_name: 'DasiwaKrea2TurboRaw_mirroredskiesV1Turbo.safetensors' }, class_type: 'CheckpointLoaderSimple' },
    '30:11': { inputs: { clip_name: 'qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2', device: 'default' }, class_type: 'CLIPLoader' },
    '30:12': { inputs: { vae_name: 'qwen_image_vae.safetensors' }, class_type: 'VAELoader' },
    '30:13': { inputs: { conditioning: ['30:6', 0] }, class_type: 'ConditioningZeroOut' },
    '30:25': { inputs: { lora_name: 'krea2_softwatercolor.safetensors', strength_model: 0.8, model: ['30:10', 0] }, class_type: 'LoraLoaderModelOnly' },
    '30:26': { inputs: { switch: true, on_false: ['30:10', 0], on_true: ['30:25', 0] }, class_type: 'ComfySwitchNode' },
    '30:54': { inputs: { choice: 'Portrait', index: 0 }, class_type: 'CustomCombo' },
    '30:55': { inputs: { expression: '832 if a == 0 else 1024', 'values.a': ['30:54', 1] }, class_type: 'ComfyMathExpression' },
    '30:56': { inputs: { expression: '1216 if a == 0 else 1024', 'values.a': ['30:54', 1] }, class_type: 'ComfyMathExpression' },
};

test('comfy: parseWorkflow accepts API format (+ {prompt:{}} wrapper), rejects UI export / junk', () => {
    assert.ok(parseWorkflow(JSON.stringify(KREA)).nodes);
    assert.ok(parseWorkflow(JSON.stringify({ prompt: KREA })).nodes['30:3']);
    assert.match(parseWorkflow(JSON.stringify({ nodes: [], links: [] })).error, /API format/);
    assert.match(parseWorkflow('{"a":1}').error, /class_type/);
    assert.match(parseWorkflow('nope').error, /valid JSON/);
    assert.match(parseWorkflow('').error, /empty/);
    assert.equal(workflowInfo(JSON.stringify(KREA)).error.includes('%prompt%'), true, 'warns when prompt is not wired');
});

test('comfy: autoMapWorkflow wires prompt, sampler params, latent size (through links) and checkpoint; skips zero-out negative; idempotent', () => {
    const r = autoMapWorkflow(JSON.stringify(KREA));
    assert.equal(r.error, '');
    const n = r.nodes;
    assert.equal(n['30:6'].inputs.text, '%prompt%');
    assert.equal(n['30:3'].inputs.seed, '%seed%'); assert.equal(n['30:3'].inputs.steps, '%steps%'); assert.equal(n['30:3'].inputs.cfg, '%scale%');
    assert.equal(n['30:3'].inputs.sampler_name, '%sampler%'); assert.equal(n['30:3'].inputs.scheduler, '%scheduler%');
    assert.equal(n['30:5'].inputs.width, '%width%'); assert.equal(n['30:5'].inputs.height, '%height%');
    assert.equal(n['30:10'].inputs.ckpt_name, '%model%');
    assert.equal(r.originalModel, 'DasiwaKrea2TurboRaw_mirroredskiesV1Turbo.safetensors');
    assert.equal(n['30:13'].class_type, 'ConditioningZeroOut', 'negative stays zero-out (same encoder as positive -> not mapped)');
    assert.ok(!Object.values(n).some(x => x.inputs?.text === '%negative_prompt%'));
    assert.deepEqual(Object.keys(r.mapped).sort(), ['height', 'model', 'prompt', 'sampler', 'scale', 'scheduler', 'seed', 'steps', 'width']);
    assert.equal(n['30:11'].inputs.type, 'krea2', 'untouched nodes keep their values');
    assert.equal(autoMapWorkflow(r.text).text, r.text, 'idempotent');
    const info = workflowInfo(r.text);
    assert.ok(info.ok && info.error === '' && info.placeholders.includes('prompt') && info.nodeCount === Object.keys(KREA).length);
});

test('comfy: renderWorkflow fills quoted placeholders as typed JSON, bare ones spliced+escaped; random seed; %model% requires a model', () => {
    const text = autoMapWorkflow(JSON.stringify(KREA)).text.replace('"%prompt%"', '"masterpiece, %prompt%"');
    const out = renderWorkflow(text, { prompt: 'she says "hi"\nnew line', negative_prompt: '', model: 'm.safetensors', sampler: 'euler', scheduler: 'simple', steps: 8, cfg: 1, width: 832, height: 1216, seed: 42 });
    assert.equal(out['30:6'].inputs.text, 'masterpiece, she says "hi"\nnew line');
    assert.equal(out['30:3'].inputs.steps, 8); assert.equal(out['30:3'].inputs.cfg, 1); assert.equal(out['30:3'].inputs.seed, 42);
    assert.equal(out['30:5'].inputs.width, 832); assert.equal(out['30:5'].inputs.height, 1216);
    assert.equal(out['30:10'].inputs.ckpt_name, 'm.safetensors');
    const rnd = renderWorkflow(text, { prompt: 'x', model: 'm', seed: -1 });
    assert.ok(Number.isInteger(rnd['30:3'].inputs.seed) && rnd['30:3'].inputs.seed >= 0);
    assert.throws(() => renderWorkflow(text, { prompt: 'x', model: '' }), /no default model/);
    assert.ok(PLACEHOLDERS.includes('negative_prompt') && PLACEHOLDERS.includes('denoise'));
});

test('comfy: extractLoras pulls <lora:name:w> tags; injectLoras chains LoraLoaderModelOnly in front of the sampler model input', () => {
    const { text, loras } = extractLoras('masterpiece, <lora:krea2_darkbrush:0.7>, 1girl, <lora:dotmatrix.safetensors>, <lora:x:0.5:0.3> rain');
    assert.equal(text, 'masterpiece, 1girl, rain');
    assert.deepEqual(loras, [{ name: 'krea2_darkbrush', weight: 0.7 }, { name: 'dotmatrix.safetensors', weight: 1 }, { name: 'x', weight: 0.5 }]);
    const nodes = structuredClone(KREA);
    const r = injectLoras(nodes, loras);
    assert.deepEqual(r.injected, ['krea2_darkbrush.safetensors', 'dotmatrix.safetensors', 'x.safetensors']);
    assert.deepEqual(nodes['30:3'].inputs.model, ['ifimgen_lora_3', 0], 'sampler now fed by the last LoRA');
    assert.deepEqual(nodes['ifimgen_lora_1'].inputs.model, ['30:26', 0], 'first LoRA takes the original model source (after the switch)');
    assert.deepEqual(nodes['ifimgen_lora_2'].inputs.model, ['ifimgen_lora_1', 0]);
    assert.equal(nodes['ifimgen_lora_1'].inputs.strength_model, 0.7);
    assert.deepEqual(injectLoras(structuredClone(KREA), []).injected, []);
    assert.match(injectLoras({ a: { class_type: 'SaveImage', inputs: {} } }, loras).skipped, /KSampler/);
});

test('parsePlan / parseRefined survive unescaped inner quotes, fences and prose (real planner failure)', () => {
    const bad = 'Here you go:\n```json\n[{"p": 3, "prompt": "$user pushing at his chest, "no, no" plea, a 4-year-old boy with tear-streaked face crouched nearby"}, {"p": 5, "prompt": "he says \\"stay\\" and grabs her wrist, [wide shot]"}]\n```';
    const plan = parsePlan(bad, [1, 2, 3, 4, 5]);
    assert.deepEqual(plan.map(x => x.p), [3, 5]);
    assert.ok(plan[0].prompt.includes('"no, no" plea') && plan[1].prompt.includes('[wide shot]'));
    assert.deepEqual(parseRefined('[{"i":1,"prompt":"she whispers "come here" softly"},{"i":2,"prompt":"ok"}]', 2), ['she whispers "come here" softly', 'ok']);
    assert.equal(extractJsonArray('no json here'), null);
    assert.deepEqual(extractJsonArray('[{"a":"x [1] y"}]'), [{ a: 'x [1] y' }], 'brackets inside strings are fine');
    assert.deepEqual(parsePlan("I'm not able to fulfill this request.", [1, 2]), [], 'refusal -> empty plan (pipeline reports it)');
});


test('parsePlan: prompts closed with an ESCAPED quote (real planner reply) fall back to loose object parsing', () => {
    // 4 of 5 prompts ended with  !\"}  -> strict + repair both fail with "Unterminated string"
    const bs = String.fromCharCode(92);
    const real = '[{"p":6,"prompt":"arches off the sofa!' + bs + '"},{"p":8,"prompt":"gloves drip, late light!' + bs + '"},{"p":10,"prompt":"normal one"},{"p":12,"prompt":"says ' + bs + '"stay' + bs + '" and "raw" quotes!' + bs + '"}]';
    const r = parsePlan(real, [6, 8, 10, 12]);
    assert.deepEqual(r.map(x => x.p), [6, 8, 10, 12]);
    assert.equal(r[0].prompt, 'arches off the sofa!');
    assert.equal(r[2].prompt, 'normal one');
    assert.ok(r[3].prompt.includes('says "stay" and "raw" quotes!'), r[3].prompt);
});
test('profile image: prompt carries base look + details filtered by framing / SFW, style, framing + dialect rules; solo portrait contract', () => {
    const e = createEntity('characters', { name: 'Yenka', keyword: 'yenka', tags: '1girl, black hair, parted bangs, black eyes', natural: 'Yenka is a small girl with dark parted hair',
        facets: 'outfit: white button-up shirt, black skirt\nback: a big tattoo on the left shoulder blade\nnsfw: pierced navel\nface: a small mole under the left eye' });
    // portrait + sfw: face yes, outfit yes, back (body) no, nsfw no
    assert.deepEqual(profileFacets(e, { shot: 'portrait', sfw: true }).map(f => f.key), ['outfit', 'face']);
    assert.deepEqual(profileFacets(e, { shot: 'full', sfw: true }).map(f => f.key), ['outfit', 'back', 'face']);
    assert.deepEqual(profileFacets(e, { shot: 'full', sfw: false }).map(f => f.key), ['outfit', 'back', 'nsfw', 'face']);
    const { system, user } = buildProfilePrompt({ entity: e, style, dialect: 'tags', shot: 'bust', sfw: true, label: 'character' });
    assert.ok(!system.includes('{{framing_rule}}') && !system.includes('{{dialect_rule}}'), 'placeholders filled');
    assert.ok(system.includes('waist up'), 'bust framing rule'); assert.ok(system.includes('danbooru'), 'tags dialect');
    assert.ok(/solo/i.test(system) && /ALONE/.test(system) && /no other people/i.test(system), 'solo portrait contract');
    assert.ok(user.includes('BASE LOOK (tags): 1girl, black hair') && user.includes('BASE LOOK (description): Yenka is'), 'both base looks handed over');
    assert.ok(user.includes('outfit: white button-up shirt') && user.includes('face: a small mole') && !user.includes('pierced navel'), 'sfw drops nsfw detail');
    assert.ok(user.includes('STYLE: anime style') && user.includes('FRAMING: bust') && user.includes('SAFE FOR WORK'), 'style + framing + sfw lines');
    assert.ok(user.includes('PERSON (character): Yenka — token $yenka'));
    const nat = buildProfilePrompt({ entity: e, style: null, dialect: 'natural', shot: 'full', sfw: false, system: 'X {{framing_rule}} Y {{dialect_rule}}' });
    assert.ok(nat.system.startsWith('X FRAMING: full body') && nat.system.includes('natural-language paragraph'), 'custom system + natural dialect + full framing');
    assert.ok(!nat.user.includes('STYLE:') && !nat.user.includes('SAFE FOR WORK') && nat.user.includes('nsfw: pierced navel'), 'nsfw allowed when sfw=false');
    assert.ok(DEFAULT_PROFILE_SYSTEM.includes('{{framing_rule}}') && DEFAULT_PROFILE_SYSTEM.includes('{{dialect_rule}}'));
    assert.deepEqual(PROFILE_SHOTS, ['portrait', 'bust', 'full']);
});

test('profile image: parseProfilePrompt accepts object / array / fenced / plain; profileDraft is a usable no-LLM fallback', () => {
    assert.equal(parseProfilePrompt('{"prompt": "1girl, solo, portrait"}'), '1girl, solo, portrait');
    assert.equal(parseProfilePrompt('```json\n[{"i":1,"prompt":"a portrait"}]\n```'), 'a portrait');
    assert.equal(parseProfilePrompt('  plain text prompt  '), 'plain text prompt');
    assert.equal(parseProfilePrompt(''), '');
    const e = createEntity('personas', { name: 'Me', keyword: 'me', tags: '1boy, short brown hair', facets: 'outfit: grey hoodie\nnsfw: x' });
    const d = profileDraft({ entity: e, dialect: 'tags', shot: 'portrait', sfw: true });
    assert.ok(d.startsWith('solo, portrait') && d.includes('1boy, short brown hair') && d.includes('grey hoodie') && !d.includes(', x'), d);
    const n = profileDraft({ entity: e, dialect: 'natural', shot: 'full', sfw: true });
    assert.ok(n.startsWith('A full-body shot of Me, standing, seen from a distance') && n.includes('grey hoodie') && n.includes('looking at the viewer'), n);
    // no base look at all -> still a prompt, not an empty string
    assert.ok(profileDraft({ entity: createEntity('characters', { name: 'Nobody' }), dialect: 'tags' }).includes('solo'));
});

test('profile image: entity.profile normalized on create / import / export, styles have none; versions capped; compile merged=true keeps LoRA + style + negative but no duplicate base look', () => {
    const rec = k => ({ url: `/img/${k}.png`, prompt: `p${k}`, shot: 'bust', sfw: false, at: k });
    const many = Array.from({ length: PROFILE_VERSIONS + 4 }, (_, k) => rec(k + 1));
    const e = createEntity('characters', { name: 'A', profile: { shot: 'full', sfw: false, current: rec(0), history: many } });
    assert.equal(e.profile.shot, 'full'); assert.equal(e.profile.sfw, false);
    assert.equal(e.profile.current.url, '/img/0.png'); assert.equal(e.profile.current.shot, 'bust');
    assert.equal(e.profile.history.length, PROFILE_VERSIONS, 'history capped');
    assert.deepEqual(normalizeProfile(undefined), { shot: 'portrait', sfw: true, current: null, history: [] });
    assert.deepEqual(normalizeProfile({ shot: 'nope', current: { nourl: true }, history: [null, 'x', rec(9)] }).history.map(h => h.url), ['/img/9.png']);
    assert.equal(createEntity('styles', { name: 'S', profile: { current: rec(1) } }).profile, null, 'styles carry no profile');
    // Save-from-UI shape: createEntity(kind, { ...fields, profile: { ...base.profile, shot, sfw } }) keeps the image.
    const resaved = createEntity('characters', { id: e.id, name: 'A2', profile: { ...e.profile, shot: 'portrait', sfw: true } });
    assert.equal(resaved.profile.current.url, '/img/0.png'); assert.equal(resaved.profile.shot, 'portrait'); assert.equal(resaved.profile.history.length, PROFILE_VERSIONS);
    // export -> import roundtrip keeps the profile
    const lst = [];
    importEntities('characters', lst, exportEntities('characters', [e]));
    assert.equal(lst[0].profile.current.url, '/img/0.png');
    // compile: the draft already contains the base look -> merged=true, entity tags not prepended, LoRA/style/negative still there
    const ly = createEntity('characters', { name: 'Lyna', keyword: 'lyna', tags: '1girl, silver hair', negative: 'blue hair', loras: ['<lora:lyna:0.8>'] });
    const st = defaultSettings(); st.data.styles.push(style); st.defaultStyleId = style.id;
    const draft = profileDraft({ entity: ly, dialect: 'tags' });
    const { prompt, negative } = compilePrompt({ scene: draft, characters: [ly], personas: [], style, settings: st, backend: 'sd', merged: true });
    assert.equal(prompt.split('1girl, silver hair').length - 1, 1, 'base look appears once');
    assert.ok(prompt.includes('<lora:lyna:0.8>') && prompt.includes('anime style') && prompt.startsWith('<lora:lyna:0.8>, masterpiece'), prompt);
    assert.ok(negative.includes('blue hair') && negative.includes('realistic'));
    assert.equal(typeof defaultSettings().generate.profileSystem, 'string');
});

await testAsync('abortable: resolves normally and aborts a never-settling promise immediately', async () => {
    assert.equal(await abortable(Promise.resolve('ok')), 'ok');
    const controller = new AbortController();
    const waiting = abortable(new Promise(() => {}), controller.signal);
    controller.abort();
    await assert.rejects(waiting, err => err?.name === 'AbortError');
});

test('collectProfileImages maps profile records for the gallery viewer', () => {
    const items = collectProfileImages([{ url: '/p.png', kind: 'characters', id: 'c1', name: 'Card A', prompt: 'final', negative: 'bad', draft: 'draft', current: false }]);
    assert.deepEqual(items, [{ url: '/p.png', messageId: -1, name: 'Card A', scene: '', refined: '', prompt: 'final', negative: 'bad', draft: 'draft', test: true, profile: { kind: 'characters', id: 'c1', current: false } }]);
});

await testAsync('profile pipeline: ignored abort releases the job and bound profiles save in the card gallery folder', async () => {
    const makeSettings = () => {
        const st = defaultSettings();
        const entity = createEntity('characters', { name: 'IF Entry', keyword: 'entry', tags: '1girl, red hair', bind: { characters: ['a.png'] } });
        st.data.characters.push(entity);
        return { st, entity };
    };
    const ctx = { characters: [{ name: 'Card A', avatar: 'a.png' }], characterId: 0, chat: [] };
    const hanging = makeSettings();
    let calls = 0;
    const stalled = createPipeline({
        settings: hanging.st, getContext: () => ctx,
        backends: { active: () => ({ id: 'sd', generate: () => { calls++; return new Promise(() => {}); } }) },
        llm: { chat: async () => '' }, saveImage: async () => '/unused.png',
    });
    const first = stalled.profileImage({ kind: 'characters', id: hanging.entity.id, useLlm: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1); assert.equal(stalled.profileRunning(hanging.entity.id), true);
    stalled.cancelProfile(hanging.entity.id);
    assert.equal(stalled.profileRunning(hanging.entity.id), false);
    const second = stalled.profileImage({ kind: 'characters', id: hanging.entity.id, useLlm: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 2, 'a second call starts immediately instead of throwing already rendering');
    stalled.cancelProfile(hanging.entity.id);
    assert.equal(await first, null);
    assert.equal(await second, null);

    const rendered = makeSettings();
    const folders = [];
    const ready = createPipeline({
        settings: rendered.st, getContext: () => ctx,
        backends: { active: () => ({ id: 'sd', generate: async () => 'base64' }) },
        llm: { chat: async () => '' },
        saveImage: async (_b64, folder) => { folders.push(folder); return '/user/images/Card%20A/profile.png'; },
    });
    const rec = await ready.profileImage({ kind: 'characters', id: rendered.entity.id, useLlm: false });
    assert.equal(rec.url, '/user/images/Card%20A/profile.png');
    assert.deepEqual(folders, ['Card A']);
    assert.equal(ready.profileImages()[0].current, true);
});

await testAsync('profile pipeline: job slot is released the moment the render resolves (UI must flip Cancel -> Regenerate), and cancelProfile releases immediately', async () => {
    const makeSettings = () => {
        const st = defaultSettings();
        const entity = createEntity('characters', { name: 'Profile Entry', keyword: 'profile_entry', tags: '1girl, black hair' });
        st.data.characters.push(entity);
        return { st, entity };
    };
    const ctx = { characters: [{ name: 'Card A', avatar: 'a.png' }], characterId: 0, chat: [] };
    const rendered = makeSettings();
    const callbackRunning = [], running = [];
    let ready;
    ready = createPipeline({
        settings: rendered.st, getContext: () => ctx,
        backends: { active: () => ({ id: 'sd', generate: async () => 'base64' }) },
        llm: { chat: async () => '' }, saveImage: async () => '/profile.png',
        save: () => callbackRunning.push(ready.profileRunning(rendered.entity.id)),
        onChange: () => callbackRunning.push(ready.profileRunning(rendered.entity.id)),
    });
    ready.onJobs(st => running.push(st.running));
    const rec = await ready.profileImage({ kind: 'characters', id: rendered.entity.id, useLlm: false });
    assert.deepEqual(callbackRunning, [false, false], 'slot released before save/onChange');
    assert.equal(running.at(-1), 0); assert.equal(ready.profileRunning(rendered.entity.id), false);
    assert.ok(rec.url);

    const stalledData = makeSettings();
    const stalled = createPipeline({
        settings: stalledData.st, getContext: () => ctx,
        backends: { active: () => ({ id: 'sd', generate: () => new Promise(() => {}) }) },
        llm: { chat: async () => '' }, saveImage: async () => '/unused.png',
    });
    const pending = stalled.profileImage({ kind: 'characters', id: stalledData.entity.id, draft: 'solo portrait', useLlm: false });
    assert.equal(stalled.profileRunning(stalledData.entity.id), true);
    stalled.cancelProfile(stalledData.entity.id);
    assert.equal(stalled.profileRunning(stalledData.entity.id), false);
    assert.equal(await pending, null);
});

test('ui: every .ent-profile-* selector the entity editor queries exists in the entityPanel markup (v0.11.0 mounted nothing because these were missing)', () => {
    const src = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
    const used = [...new Set([...src.matchAll(/q\('\.(ent-profile-[a-z-]+)'\)/g)].map(m => m[1]))];
    assert.ok(used.length >= 10, `expected the profile selectors to be queried, found ${used.length}`);
    for (const cls of used) {
        const inMarkup = src.includes(` ${cls}"`) || src.includes(`"${cls} `) || src.includes(`"${cls}"`) || src.includes(`cls: '${cls}`);
        assert.ok(inMarkup, `entityPanel markup is missing .${cls}`);
    }
    for (const id of ['ifimgen_profile_system', 'ifimgen_profile_reset']) assert.ok(src.includes(`'${id}'`) && (src.includes(`id="${id}"`) || src.includes(`id: '${id}'`)), `${id} must be both in markup and bound`);
});

test('ui: profile box - onJobs hook is declared AFTER savedEntity (const TDZ would break the whole drawer), no versions strip, Use LLM off by default', () => {
    const src = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
    const decl = src.indexOf('const savedEntity = ');
    const hook = src.indexOf('pipeline.onJobs(() => { const e = savedEntity()');
    assert.ok(decl > 0 && hook > decl, 'onJobs hook must come after the savedEntity declaration');
    assert.ok(!src.includes('ent-profile-versions'), 'versions strip removed from the profile box');
    assert.ok(/class="ent-profile-llm">/.test(src), 'Use LLM checkbox must not be checked by default');
    assert.ok(/class="ent-profile-sfw" checked>/.test(src), 'SFW must be checked by default');
    assert.ok(src.includes('ifimgen-profile-actions'), 'action buttons row class present');
});

test('compilePrompt sceneFirst (profile images): the framing sentence opens the prompt, the long style paragraph follows it - both dialects', () => {
    const settings = defaultSettings();
    const style = createEntity('styles', { name: 'S', natural: 'Textured paint layering, impasto brushwork, glowing highlights, dreamlike atmosphere.', tags: 'oil painting, impasto', loras: '<lora:x:1>' });
    const e = createEntity('characters', { name: 'Ly', keyword: 'ly', natural: 'a tall woman with black hair' });
    const draft = profileDraft({ entity: e, dialect: 'natural', shot: 'full', sfw: true });
    const nat = compilePrompt({ scene: draft, characters: [e], personas: [], style, settings, backend: 'sd', merged: true, dialect: 'natural', sceneFirst: true }).prompt;
    const noLora = nat.replace(/<lora:[^>]+>\s*/g, '');
    assert.ok(noLora.startsWith('A full-body shot of Ly, standing'), noLora.slice(0, 80));
    assert.ok(noLora.indexOf('feet inside the frame') < noLora.indexOf('impasto'), 'framing before style');
    assert.ok(nat.startsWith('<lora:x:1>'), 'LoRA token still leads');
    const tg = compilePrompt({ scene: 'solo, full body, feet visible', characters: [e], personas: [], style, settings, backend: 'sd', merged: true, dialect: 'tags', sceneFirst: true }).prompt;
    assert.ok(tg.indexOf('full body') < tg.indexOf('oil painting'), tg);
    // default order (chat images) unchanged: style first, scene last
    const chat = compilePrompt({ scene: 'she sits by the window', characters: [e], personas: [], style, settings, backend: 'sd', merged: false, dialect: 'natural' }).prompt;
    assert.ok(chat.indexOf('impasto') < chat.indexOf('she sits'), chat);
});

test('profile image: framing words differ per shot and spell out bust / full (waist, feet, distance)', () => {
    const e = createEntity('characters', { name: 'Ly', keyword: 'ly', tags: '1girl, black hair' });
    const t = s => profileDraft({ entity: e, dialect: 'tags', shot: s, sfw: true });
    const n = s => profileDraft({ entity: e, dialect: 'natural', shot: s, sfw: true });
    assert.ok(t('portrait').includes('face focus') && !t('portrait').includes('full body'));
    assert.ok(t('bust').includes('from the waist up') && !t('bust').includes('face focus'));
    assert.ok(t('full').includes('full body') && t('full').includes('feet visible'));
    assert.ok(n('bust').includes('waist up') && n('full').includes('feet inside the frame') && n('portrait').includes('nothing below the chest'));
    assert.ok(!n('full').includes('portrait') && !n('bust').includes('portrait'), 'no "portrait" word on bust / full (read as a head shot)');
    // SFW drops explicit details by CONTENT, not only by key name (users name them breasts / pussy / cock ...)
    const x = createEntity('characters', { name: 'X', keyword: 'x', tags: '1girl', facets: ['body: hourglass figure, wide hips', 'breasts: round breasts with pale pink nipples', 'pussy: hairless pink pussy', 'tattoos: a rose on the left shoulder'].join(String.fromCharCode(10)) });
    const sfwFull = profileDraft({ entity: x, dialect: 'tags', shot: 'full', sfw: true });
    assert.ok(sfwFull.includes('hourglass') && sfwFull.includes('rose on the left shoulder') && !sfwFull.includes('nipples') && !sfwFull.includes('pussy'), sfwFull);
    assert.ok(profileDraft({ entity: x, dialect: 'tags', shot: 'full', sfw: false }).includes('nipples'));
    assert.equal(new Set([t('portrait'), t('bust'), t('full')]).size, 3);
});

if (process.exitCode) { console.log(`\nFAIL (${passed} passed)`); process.exit(1); }
console.log(`PASS (${passed} cases)`);

test('binding model: official (active version of the open card) / guest (root chat) / always (advertised only)', () => {
    const v1 = createEntity('characters', { name: 'Seb v1', keyword: 'seb', bind: { characters: ['seb.png'] } });
    const v2 = createEntity('characters', { name: 'Seb v2', keyword: 'seb', bind: { characters: ['seb.png'], always: true } });
    const ros = createEntity('characters', { name: 'Rosario', keyword: 'rosario', bind: { characters: ['ros.png'], always: true, chats: ['guest-chat'] } });
    const orphanAlways = createEntity('characters', { name: 'Ghost', keyword: 'ghost', bind: { always: true } });
    const orphan = createEntity('characters', { name: 'Nobody', keyword: 'nobody' });
    const list = [v1, v2, ros, orphanAlways, orphan];
    // one card per profile: extra avatars are dropped
    assert.deepEqual(createEntity('characters', { name: 'X', bind: { characters: ['a.png', 'b.png'], personas: ['p1', 'p2'] } }).bind.characters, ['a.png']);
    // the active version: picked in activeProfiles, else the first bound one
    assert.equal(activeProfileFor(list, 'seb.png', {}).id, v1.id);
    assert.equal(activeProfileFor(list, 'seb.png', { 'seb.png': v2.id }).id, v2.id);
    assert.equal(activeProfileFor(list, 'nope.png', {}), null);
    const sebChat = { chatId: 'seb-main', charAvatar: 'seb.png', activeProfiles: { 'seb.png': v2.id } };
    assert.equal(isActive(v2, list, sebChat), true, 'active version is official');
    assert.equal(isActive(v1, list, sebChat), false, 'inactive version is not');
    assert.equal(isBound(v1, sebChat, list), false, 'inactive version is not even listed');
    assert.equal(isBound(v2, sebChat, list), true);
    assert.equal(isActive(ros, list, sebChat), false, 'Rosario (always, bound to another card) is NOT active in Sebastian chat');
    assert.equal(isBound(ros, sebChat, list), true, '... but always advertises its token');
    assert.equal(bindReason(ros, list, sebChat), 'always');
    assert.equal(bindReason(v2, list, sebChat), 'official');
    assert.equal(isBound(orphan, sebChat, list), false, 'orphan without always is invisible');
    assert.equal(isBound(orphanAlways, sebChat, list), true);
    // guest: bound to the (root) chat -> official for that chat whoever the card is
    const guestChat = { chatId: 'guest-chat', charAvatar: 'seb.png', activeProfiles: {} };
    assert.equal(isActive(ros, list, guestChat), true); assert.equal(bindReason(ros, list, guestChat), 'guest');
    // persona side works the same
    const me = createEntity('personas', { name: 'Me', keyword: 'me', bind: { personas: ['me.png'] } });
    assert.equal(isActive(me, [me], { personaAvatar: 'me.png' }), true);
    assert.equal(isActive(me, [me], { personaAvatar: 'other.png' }), false);
});

test('resolveEntities: no keyword -> official / guest only (never always); keyword -> only entities in play; inactive version never matched', () => {
    const s = defaultSettings();
    const v1 = createEntity('characters', { name: 'Seb v1', keyword: 'seb', tags: 'v1', bind: { characters: ['seb.png'] } });
    const v2 = createEntity('characters', { name: 'Seb v2', keyword: 'seb', tags: 'v2', bind: { characters: ['seb.png'] } });
    const ros = createEntity('characters', { name: 'Rosario', keyword: 'rosario', bind: { characters: ['ros.png'], always: true } });
    const orphan = createEntity('characters', { name: 'Nobody', keyword: 'nobody' });
    s.data.characters.push(v1, v2, ros, orphan);
    s.activeProfiles = { 'seb.png': v2.id };
    const here = { chatId: 'seb-main', charAvatar: 'seb.png', personaAvatar: '' };
    // no keyword -> the active Sebastian only; Rosario (always) stays out
    assert.deepEqual(resolveEntities(s, { text: 'a man sits by the window', ...here }).characters.map(e => e.name), ['Seb v2']);
    // keyword -> the active version, once
    assert.deepEqual(resolveEntities(s, { text: '$seb smiles', ...here }).characters.map(e => e.name), ['Seb v2']);
    // always-on Rosario can be CALLED by keyword
    assert.deepEqual(resolveEntities(s, { text: '$rosario and $seb', ...here }).characters.map(e => e.name).sort(), ['Rosario', 'Seb v2']);
    // orphan without always: not even by keyword -> counts as 'no keyword', the official character is used
    assert.deepEqual(resolveEntities(s, { text: '$nobody here', ...here }).characters.map(e => e.name), ['Seb v2']);
    assert.deepEqual(resolveEntities(s, { text: '$nobody here', chatId: 'x', charAvatar: 'other.png' }).characters, [], 'and nothing at all where no card is bound');
    // roster: official first, then always; inactive version and plain orphan absent
    const roster = rosterText(s, here);
    assert.ok(roster.indexOf('Seb v2') >= 0 && roster.indexOf('Seb v2') < roster.indexOf('Rosario'));
    assert.ok(!roster.includes('Seb v1') && !roster.includes('Nobody'));
    // guest chat: Rosario official there, still no auto-load of Sebastian's inactive version
    s.data.characters.find(e => e.id === ros.id).bind.chats = ['seb-main'];
    assert.deepEqual(resolveEntities(s, { text: 'two men talk', ...here }).characters.map(e => e.name).sort(), ['Rosario', 'Seb v2']);
});

test('ui: bind / world / tokens UI - every new selector is in the markup, world roundtrips through the entity model, doc tokens are exposed by the pipeline api', () => {
    const src = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
    for (const cls of ['ent-world', 'ent-tokens-save', 'ent-inuse', 'ent-bind-versions', 'ent-bind-activate']) {
        assert.ok(src.includes(`q('.${cls}')`), `.${cls} must be queried`);
        assert.ok(src.includes(`class="text_pole ${cls}"`) || src.includes(`${cls} `) || src.includes(`cls: '${cls}`) || src.includes(`class="ifimgen-list ${cls}"`), `.${cls} must be in the markup`);
    }
    // the "make active" and "save tokens" buttons are only wired when the entry is saved (currentId)
    assert.ok(src.includes('settings.activeProfiles[owner] = saved.id'));
    // world: parsed like facets, exported / imported, expanded as $kw.key after Details
    const e = createEntity('characters', { name: 'Seb', keyword: 'seb', facets: 'outfit: blue shirt', world: 'apartment: small studio, brick wall\nnpc_william: a lanky man, wire glasses' });
    assert.deepEqual(e.world.map(f => f.key), ['apartment', 'npc_william']);
    const ex = expandScene({ scene: '$seb in $seb.apartment with $seb.npc_william wearing $seb.outfit', characters: [e], personas: [] });
    assert.ok(ex.text.includes('small studio, brick wall') && ex.text.includes('wire glasses') && ex.text.includes('blue shirt'), ex.text);
    const back = importEntities('characters', [], exportEntities('characters', [e]));
    assert.equal(back.added, 1);
    const pipeSrc = readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
    assert.ok(pipeSrc.includes('sceneDocTokens:'), 'pipeline exposes the doc tokens for the save-tokens popup');
});

test('compareVersions: numeric per segment, leading v ignored, missing segments are 0', () => {
    assert.equal(compareVersions('0.10.0', '0.9.1'), 1);
    assert.equal(compareVersions('v0.9.0', '0.9.0'), 0);
    assert.equal(compareVersions('0.9', '0.9.1'), -1);
    assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
    assert.equal(compareVersions('', '0.1.0'), -1);
});

test('presets: Save overwrites in place (built-in -> override, user -> own record); reset restores; findPreset sees the override', () => {
    const st = defaultSettings();
    const id = BUILTIN_PRESETS[0].id;
    assert.ok(overwritePreset(st, id, 'custom text'));
    const b = allPresets(st).find(p => p.id === id);
    assert.equal(b.system, 'custom text'); assert.equal(b.overridden, true); assert.equal(b.builtin, true);
    assert.equal(findPreset(st, id).system, 'custom text', 'pipeline uses the override');
    assert.equal(BUILTIN_PRESETS[0].system, BUILTIN_PRESETS[0].system.replace('custom text', ''), 'shipped preset object untouched');
    overwritePreset(st, id, BUILTIN_PRESETS[0].system);
    assert.equal(st.data.presetOverrides[id], undefined, 'saving the default text clears the override');
    overwritePreset(st, id, 'again'); resetPreset(st, id);
    assert.equal(allPresets(st).find(p => p.id === id).overridden, undefined);
    const mine = createPreset({ name: 'Mine', system: 'a' }); st.data.presets.push(mine);
    assert.ok(overwritePreset(st, mine.id, 'b')); assert.equal(mine.system, 'b');
    assert.equal(overwritePreset(st, 'nope', 'x'), false);
});
