@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === FORMATION SCANNER: установка ===
echo.

where node >nul 2>nul
if %errorlevel%==0 goto :node_ok

echo Node.js не найден. Пробую установить через winget...
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if %errorlevel% neq 0 (
  echo.
  echo Не получилось установить автоматически.
  echo Установите Node.js LTS вручную: https://nodejs.org
  pause
  exit /b 1
)
echo.
echo Node.js установлен. ЗАКРОЙТЕ это окно и запустите install.bat ЕЩЁ РАЗ
echo ^(новое окно увидит обновлённый PATH^).
pause
exit /b 0

:node_ok
for /f "delims=" %%v in ('node -v') do echo Node.js найден: %%v
echo.
echo Устанавливаю зависимости проекта (npm install)...
call npm install
if %errorlevel% neq 0 (
  echo.
  echo npm install завершился с ошибкой — см. сообщения выше.
  pause
  exit /b 1
)
echo.
echo === Готово. Запускайте start.bat ===
pause
