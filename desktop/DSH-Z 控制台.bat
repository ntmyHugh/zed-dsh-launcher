@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem 优先使用仓库内的启动器（开发时无需安装），否则回退到已安装版本
set "DSHZ=%~dp0..\bin\dsh-zed.cmd"
if not exist "%DSHZ%" set "DSHZ=%USERPROFILE%\.dsh\bin\dsh-zed.cmd"
if not exist "%DSHZ%" goto missing

call "%DSHZ%" tui
echo.
pause
exit /b 0

:missing
echo [ERROR] dsh-zed not found.
echo Run install.ps1 from the zed-dsh-launcher repository first.
pause
exit /b 1
