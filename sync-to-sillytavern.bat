@echo off
setlocal
REM ============================================================
REM  V.Adapter - sync source into the SillyTavern install dirs
REM    (1) frontend extension -> data\default-user\extensions\V.Adapter
REM    (2) server-side plugin -> plugins\V.Adapter   (data\ is NOT touched)
REM
REM  SRC is derived from this script's own directory, so it needs no edit.
REM  ST must point at the SillyTavern root directory - edit the line below.
REM
REM  (Keep this file ASCII-only: cmd.exe reads .bat as ANSI. Wildcards are
REM   used for the .md files so that no CJK filename appears in this file.)
REM ============================================================

REM -------- source: the directory holding this script --------
set "SRC=%~dp0"
set "SRC=%SRC:~0,-1%"

REM -------- EDIT THIS: SillyTavern root directory --------
set "ST=<SillyTavern>"

set "EXT=%ST%\data\default-user\extensions\V.Adapter"
set "PLG=%ST%\plugins\V.Adapter"

if not exist "%SRC%\manifest.json" (
  echo [error] source not found: %SRC%
  echo         Run this script from inside the V.Adapter source folder.
  exit /b 1
)
if not exist "%ST%" (
  echo [error] SillyTavern not found: %ST%
  echo         Open this .bat in a text editor and set ST to your SillyTavern root.
  exit /b 1
)

REM ---------- (1) frontend extension (+ the server impl it carries) ----------
if not exist "%EXT%" mkdir "%EXT%"
if not exist "%EXT%\lib" mkdir "%EXT%\lib"
copy /Y "%SRC%\manifest.json" "%EXT%\manifest.json" >nul
copy /Y "%SRC%\index.js"      "%EXT%\index.js"      >nul
copy /Y "%SRC%\style.css"     "%EXT%\style.css"     >nul
copy /Y "%SRC%\panel.html"    "%EXT%\panel.html"    >nul
copy /Y "%SRC%\README.md"     "%EXT%\README.md"     >nul
copy /Y "%SRC%\LICENSE"       "%EXT%\LICENSE"       >nul
copy /Y "%SRC%\lib\*.js"      "%EXT%\lib"          >nul

REM  The server implementation lives inside the extension folder and is loaded
REM  on demand, so it must travel with the extension.
if not exist "%EXT%\server-plugin" mkdir "%EXT%\server-plugin"
if not exist "%EXT%\server-plugin\lib" mkdir "%EXT%\server-plugin\lib"
copy /Y "%SRC%\server-plugin\index.js"     "%EXT%\server-plugin\index.js"     >nul
copy /Y "%SRC%\server-plugin\package.json" "%EXT%\server-plugin\package.json" >nul
copy /Y "%SRC%\server-plugin\panel.html"   "%EXT%\server-plugin\panel.html"   >nul
copy /Y "%SRC%\server-plugin\lib\*.js"     "%EXT%\server-plugin\lib"          >nul
echo [ok] extension      -> %EXT%

REM ---------- (2) loader into the plugins dir ----------
REM  Only the boot loader goes here. data\ holds the runtime config and must survive.
if not exist "%PLG%" mkdir "%PLG%"
copy /Y "%SRC%\bootstrap\index.js"     "%PLG%\index.js"     >nul
copy /Y "%SRC%\bootstrap\package.json" "%PLG%\package.json" >nul
echo [ok] loader         -> %PLG%   (data\ untouched)

echo.
echo Restart SillyTavern (or reload the page) to pick up changes.
exit /b 0
