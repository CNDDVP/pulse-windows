@echo off
title Pulse for Windows
cd /d "%~dp0"
echo 启动 Pulse for Windows...
start "" "%~dp0src-tauri\target\release\pulse-windows.exe"
exit
