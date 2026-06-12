@echo off
set "PROJECT_DIR=C:\Users\99632\Documents\Codex\2026-05-15\gpt-a"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

cd /d "%PROJECT_DIR%"
echo [%date% %time%] Starting YaoH Dashboard >> startup.log
"%NODE_EXE%" server.js >> server.out.log 2>> server.err.log
