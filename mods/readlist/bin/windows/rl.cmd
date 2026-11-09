@echo off
rem rl: put files and URLs on the person's Herdr reading list.
rem The Windows rl for cmd.exe and programs that start rl.cmd: runs rl.ps1 next to this file
rem with PowerShell 7 (pwsh). From PowerShell, rl runs rl.ps1 itself.
setlocal
set "RL_VIA=cmd"
where pwsh >nul 2>nul || (echo rl: needs PowerShell 7 ^(pwsh^): https://aka.ms/powershell 1>&2 & exit /b 1)
pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0rl.ps1" %*
exit /b %ERRORLEVEL%
