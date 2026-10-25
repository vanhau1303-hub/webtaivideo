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

if not exist .env (
  echo [!] Chua co file .env - copy tu .env.example va dat APP_PASSWORD truoc khi mo ra Internet.
)

start "" http://localhost:8686

:loop
node run.js
rem Ma 75 = trinh giam sat vua tu cap nhat, chay lai
if %errorlevel%==75 goto loop
pause
