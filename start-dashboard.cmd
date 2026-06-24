@echo off
set "PROJECT_DIR=C:\Users\99632\Documents\Codex\2026-05-15\gpt-a"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

cd /d "%PROJECT_DIR%"
echo [%date% %time%] Starting YaoH Dashboard >> startup.log
"%NODE_EXE%" "%PROJECT_DIR%\server.js" >> "%PROJECT_DIR%\server.out.log" 2>> "%PROJECT_DIR%\server.err.log"
