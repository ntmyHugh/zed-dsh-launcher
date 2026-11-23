@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "DSHZ=%USERPROFILE%\.dsh\bin\dshz.cmd"
if not exist "%DSHZ%" (
  echo [错误] 找不到 %DSHZ%
  pause
  exit /b 1
)
call "%DSHZ%" ui
endlocal