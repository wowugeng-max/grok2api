@echo off
setlocal
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
  taskkill /PID %%a /F >nul 2>&1
  if not errorlevel 1 (
    echo Stopped PID %%a
    set "FOUND=1"
  )
)
if not defined FOUND echo No process on port 8000
endlocal
pause
