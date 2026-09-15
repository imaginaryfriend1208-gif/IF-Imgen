@echo off
REM IF Imgen - usage: scripts\push.cmd "commit message". Logic lives in push.mjs (any characters allowed).
node "%~dp0push.mjs" %*
