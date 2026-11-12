@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Dependencies are not installed. Run install.bat first.
  pause
  exit /b 1
)
echo Starting the scanner... The browser opens in a few seconds.
echo To stop, close this window or press Ctrl+C.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8787"
call npm start
pause
