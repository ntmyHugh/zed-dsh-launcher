@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem 兼容两种布局：
rem   已安装：%~dp0dsh-zed.js
rem   仓库内：%~dp0..\src\dsh-zed.js
set "SCRIPT=%~dp0dsh-zed.js"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0..\src\dsh-zed.js"
if not exist "%SCRIPT%" (
  echo [ERROR] dsh-zed.js not found next to this launcher or in ..\src
  pause
  exit /b 1
)

set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul && set "NODE=node"
)
if not exist "%NODE%" (
  echo [ERROR] Node runtime not found. Check your DeepSeek Harness installation.
  pause
  exit /b 1
)

"%NODE%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%
