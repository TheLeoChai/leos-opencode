@echo off
title Rebuild Leo's OpenCode
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0rebuild-opencode.ps1" %*
exit /b %ERRORLEVEL%
