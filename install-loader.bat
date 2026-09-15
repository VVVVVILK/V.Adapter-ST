@echo off
setlocal
REM ============================================================
REM  V.Adapter - install the server loader into SillyTavern
REM
REM  Run this once after installing the extension itself.
REM  It copies bootstrap\ into <ST>\plugins\V.Adapter\ so that the
REM  drawer button can start the NovelAI protocol service.
REM
REM  Existing runtime config in <ST>\plugins\V.Adapter\data\ is kept.
REM
REM  EDIT ST BELOW to point at your SillyTavern root directory.
REM  (Keep this file ASCII-only: cmd.exe reads .bat as ANSI.)
REM ============================================================

set "SRC=%~dp0"
set "SRC=%SRC:~0,-1%"

REM -------- EDIT THIS: SillyTavern root directory --------
set "ST=<SillyTavern>"

set "BOOT=%SRC%\bootstrap"
set "DST=%ST%\plugins\V.Adapter"

if not exist "%BOOT%\index.js" (
  echo [error] bootstrap\index.js not found: %BOOT%
  echo         Run this script from inside the V.Adapter folder.
  exit /b 1
)
if not exist "%ST%" (
  echo [error] SillyTavern not found: %ST%
  echo         Open this .bat in a text editor and set ST to your SillyTavern root.
  exit /b 1
)

if not exist "%ST%\plugins" mkdir "%ST%\plugins"
if not exist "%DST%" mkdir "%DST%"
if not exist "%DST%\data" mkdir "%DST%\data"

copy /Y "%BOOT%\index.js"      "%DST%\index.js"      >nul
copy /Y "%BOOT%\package.json"  "%DST%\package.json"  >nul

echo.
echo [ok] loader installed -> %DST%
echo      runtime config kept in %DST%\data
echo.
echo Next: set enableServerPlugins: true in config.yaml, restart SillyTavern,
echo       then open the V.Adapter drawer and press "Start protocol service".
exit /b 0
