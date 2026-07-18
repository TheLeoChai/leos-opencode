@echo off
title Rebuild Leo's OpenCode
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0rebuild-opencode.ps1"
