@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "DSHZ=%USERPROFILE%\.dsh\bin\dsh-zed.cmd"
if not exist "%DSHZ%" goto missing
call "%DSHZ%" tui
echo.
pause
exit /b 0

:missing
echo [ERROR] dsh-zed not found: %DSHZ%
echo Run install.ps1 from the zed-dsh-launcher repository first.
pause
exit /b 1
