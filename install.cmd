@echo off
rem Double-clickable entry point. All messages come from install.ps1, which is
rem UTF-8 with a BOM so Chinese renders correctly in both Windows PowerShell 5.1
rem and PowerShell 7. This file stays pure ASCII on purpose: a .cmd carrying
rem Chinese would need the console's OEM code page, which differs per machine.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
