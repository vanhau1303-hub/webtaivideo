@echo off
chcp 65001 >nul
cd /d "%~dp0"
title HD Video Downloader

where node >nul 2>nul || (echo [!] Chua cai Node.js. Tai tai https://nodejs.org roi chay lai. & pause & exit /b 1)

if not exist node_modules (
  echo Dang cai thu vien lan dau...
  call npm install || (pause & exit /b 1)
)

python -m yt_dlp --version >nul 2>nul || (
  echo Dang cai yt-dlp...
  python -m pip install --user -U yt-dlp
)

start "" http://localhost:8686
node server.js
pause
