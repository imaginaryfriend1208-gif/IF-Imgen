#!/usr/bin/env bash
# IF Imgen - run tests, then commit and push ONLY code to GitHub (Git Bash / Linux).
# Usage:  bash scripts/push.sh "commit message"
set -e
cd "$(dirname "$0")/.."

node scripts/test-core.mjs || { echo "Tests failed - not pushing."; exit 1; }

if [ ! -d .git ]; then
    git init -b main
    git remote add origin https://github.com/imaginaryfriend1208-gif/IF-Imgen.git
fi

# Explicit allow-list: code only. .gitignore blocks *.html *.md and secret-like names.
git add .gitignore manifest.json index.js style.css src scripts/test-core.mjs scripts/push.cmd scripts/push.sh

# Safety gate: refuse to commit if a staged file looks like a doc or a key.
if git diff --cached --name-only | grep -iE '\.html$|\.md$|\.env|key|secret|token|credential' >/dev/null; then
    echo "Refusing: doc or secret-like file is staged."; git reset -q; exit 1
fi

MSG="${*:-update}"
git commit -m "$MSG" || echo "Nothing to commit."
git push -u origin main
