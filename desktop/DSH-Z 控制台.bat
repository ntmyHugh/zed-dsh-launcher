@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "DSHZ=%USERPROFILE%\.dsh\bin\dshz.cmd"
if not exist "%DSHZ%" (
  echo [����] �Ҳ��� %DSHZ%
  pause
  exit /b 1
)
call "%DSHZ%" tui
echo.
pause
endlocal