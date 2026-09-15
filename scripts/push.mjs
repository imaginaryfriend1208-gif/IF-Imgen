#!/usr/bin/env node
// IF Imgen - run tests, then commit and push ONLY code to GitHub.
// Single source of truth for push.cmd (Windows) and push.sh (Git Bash / Linux).
// Usage:  node scripts/push.mjs "commit message"   -- any characters allowed (: ; & ( ) $ % Vietnamese).
// Args are passed to git as an argv array, so no shell quoting problems.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' });
const fail = msg => { console.error(msg); process.exit(1); };

try { run(process.execPath, [resolve(root, 'scripts/test-core.mjs')]); } catch { fail('Tests failed - not pushing.'); }

if (!existsSync(resolve(root, '.git'))) {
    run('git', ['init', '-b', 'main']);
    run('git', ['remote', 'add', 'origin', 'https://github.com/imaginaryfriend1208-gif/IF-Imgen.git']);
}

// Explicit allow-list: code only. .gitignore blocks *.html *.md and secret-like names.
run('git', ['add', '.gitignore', 'manifest.json', 'index.js', 'style.css', 'src', 'scripts/test-core.mjs', 'scripts/push.mjs', 'scripts/push.cmd', 'scripts/push.sh']);

// Safety gate: refuse to commit if a staged file looks like a doc or a key.
const staged = out('git', ['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean);
const bad = staged.filter(f => /\.html?$|\.md$|\.env|key|secret|token|credential/i.test(f));
if (bad.length) { run('git', ['reset', '-q']); fail(`Refusing: doc or secret-like file is staged: ${bad.join(', ')}`); }

// cmd.exe may hand the quotes through verbatim -> strip one surrounding pair.
const msg = process.argv.slice(2).join(' ').trim().replace(/^"(.*)"$/s, '$1').trim() || 'update';
if (!staged.length) console.log('Nothing to commit.');
else run('git', ['commit', '-m', msg]);
run('git', ['push', '-u', 'origin', 'main']);
