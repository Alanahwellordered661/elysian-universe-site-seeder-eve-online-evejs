@echo off
setlocal EnableExtensions
title Elysian Universe Site Seeder
set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" (
  echo PowerShell was not found at %POWERSHELL_EXE%.
  pause
  exit /b 1
)
"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\StartUniverseSeeder.ps1" %*
set "ELYSIAN_EXIT=%errorlevel%"
if not "%ELYSIAN_EXIT%"=="0" pause
exit /b %ELYSIAN_EXIT%
