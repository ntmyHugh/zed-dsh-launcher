@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "SCRIPT=%~dp0dsh-zed.js"

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
