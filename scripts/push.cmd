@echo off
REM IF Imgen - run tests, then commit and push ONLY code to GitHub.
REM Usage:  scripts\push.cmd "commit message"
setlocal
cd /d "%~dp0\.."

node scripts\test-core.mjs || (echo Tests failed - not pushing. & exit /b 1)

if not exist .git (
    git init -b main
    git remote add origin https://github.com/imaginaryfriend1208-gif/IF-Imgen.git
)

REM Explicit allow-list: code only. .gitignore blocks *.html *.md and secret-like names.
git add .gitignore manifest.json index.js style.css src scripts\test-core.mjs scripts\push.cmd

REM Safety gate: refuse to commit if a staged file looks like a doc or a key.
git diff --cached --name-only | findstr /I /R "\.html$ \.md$ \.env key secret token credential" >nul && (
    echo Refusing: doc or secret-like file is staged. & git reset -q & exit /b 1
)

set MSG=%~1
if "%MSG%"=="" set MSG=update
git commit -m "%MSG%" || echo Nothing to commit.
git push -u origin main
endlocal
