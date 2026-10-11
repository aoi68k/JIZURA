@echo off
cd /d "%~dp0"

dotnet run --project bridge -c Release -- %*
if %ERRORLEVEL% NEQ 0 (
    python server.py %*
)
