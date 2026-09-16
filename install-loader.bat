@echo off
setlocal
REM ============================================================
REM  V.Adapter - 一键部署服务端引导器
REM
REM  自动完成三件事，无需手工编辑任何文件：
REM    1. 找到酒馆根目录
REM    2. 安装引导器到 <酒馆>\plugins\V.Adapter\
REM    3. 把 config.yaml 的 enableServerPlugins 改为 true（自动备份）
REM
REM  运行完成后重启酒馆一次即可。
REM ============================================================

set "DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  if exist "%DIR%..\..\..\..\node\node.exe" (
    set "NODE=%DIR%..\..\..\..\node\node.exe"
  ) else (
    echo [错误] 未找到 node。请先安装 Node.js，或把酒馆自带的 node 加入 PATH。
    pause
    exit /b 1
  )
) else (
  set "NODE=node"
)

"%NODE%" "%DIR%install-loader.mjs" %*
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
  echo [完成] 请重启酒馆一次，之后无需再做任何配置。
) else (
  echo [失败] 见上方提示。可手动指定酒馆目录：
  echo        install-loader.bat "C:\SillyTavern"
)
pause
exit /b %CODE%
