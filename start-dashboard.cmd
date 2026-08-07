@echo off
set "PROJECT_DIR=C:\Users\99632\Documents\Codex\2026-05-15\gpt-a"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "PORT=48080"

cd /d "%PROJECT_DIR%"

:watch
powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:48080/api/dashboard' -TimeoutSec 3; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if %errorlevel%==0 exit /b 0

echo [%date% %time%] Starting YaoH Dashboard >> startup.log
"%NODE_EXE%" "%PROJECT_DIR%\server.js" >> "%PROJECT_DIR%\server.out.log" 2>> "%PROJECT_DIR%\server.err.log"
echo [%date% %time%] Dashboard stopped; restarting in 10 seconds >> startup.log
timeout /t 10 /nobreak >nul
goto watch
