@echo off
cd /d I:\AI\MyProject\grok2api
uv run granian --interface asgi --host 0.0.0.0 --port 8000 --workers 1 main:app
pause
