@echo off
cd /d I:\AI\MyProject\grok2api

echo [1/2] Stopping server on port 8000...
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
  taskkill /PID %%a /F >nul 2>&1
  if not errorlevel 1 (
    echo Stopped PID %%a
    set "FOUND=1"
  )
)
if not defined FOUND echo No process on port 8000

echo [2/2] Starting server...
uv run granian --interface asgi --host 0.0.0.0 --port 8000 --workers 1 main:app
pause
