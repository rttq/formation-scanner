@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Зависимости не установлены — сначала запустите install.bat
  pause
  exit /b 1
)
echo Запускаю сканер... Браузер откроется через пару секунд.
echo Для остановки закройте это окно или нажмите Ctrl+C.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8787"
call npm start
pause
