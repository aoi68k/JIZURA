@echo off
cd /d "%~dp0"
dotnet run --project bridge -c Release -- %*
