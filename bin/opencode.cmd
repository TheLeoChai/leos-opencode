@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "POINTER=%~dp0current.txt"
if not exist "%POINTER%" (
  >&2 echo OpenCode launcher error: missing pointer "%POINTER%"
  exit /b 1
)

set "TARGET="
<"%POINTER%" set /p "TARGET="
if not defined TARGET (
  >&2 echo OpenCode launcher error: empty pointer "%POINTER%"
  exit /b 1
)

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
if not "%TARGET:~1,1%"==":" if not "%TARGET:~0,2%"=="\\" set "TARGET=%ROOT%\%TARGET%"
for %%I in ("%TARGET%") do set "TARGET=%%~fI"

if not exist "%TARGET%" (
  >&2 echo OpenCode launcher error: pointer target does not exist: "%TARGET%"
  exit /b 1
)
if exist "%TARGET%\NUL" (
  >&2 echo OpenCode launcher error: pointer target is not a file: "%TARGET%"
  exit /b 1
)

"%TARGET%" %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
