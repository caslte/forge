@echo off
REM forge 一键启动（双击即可）
REM 包装 npm run dev：build core/desktop -> vite dev -> electron
cd /d "%~dp0"
echo Starting forge...
call npm run dev
echo.
echo forge 已退出（按任意键关闭窗口）
pause >nul
