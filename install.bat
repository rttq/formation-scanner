@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === FORMATION SCANNER: setup ===
echo.

where node >nul 2>nul
if %errorlevel%==0 goto :node_ok

echo Node.js not found. Trying to install it via winget...
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if %errorlevel% neq 0 (
  echo.
  echo Automatic install failed.
  echo Install Node.js LTS manually: https://nodejs.org
  pause
  exit /b 1
)
echo.
echo Node.js installed. CLOSE this window and run install.bat AGAIN
echo ^(a new window picks up the updated PATH^).
pause
exit /b 0

:node_ok
for /f "delims=" %%v in ('node -v') do echo Node.js found: %%v
echo.
echo Installing project dependencies (npm install)...
call npm install
if %errorlevel% neq 0 (
  echo.
  echo npm install failed, see the messages above.
  pause
  exit /b 1
)
echo.
echo === Done. Now run start.bat ===
pause
