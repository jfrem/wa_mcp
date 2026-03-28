@echo off
setlocal

set "CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_PATH%" set "CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME_PATH%" (
  echo No se encontro Chrome en la ruta esperada.
  exit /b 1
)

set "PROFILE_DIR=%USERPROFILE%\.whatsapp-web-mcp\chrome-profile"
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

start "" "%CHROME_PATH%" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%PROFILE_DIR%" ^
  --new-window ^
  "https://web.whatsapp.com"

echo Chrome iniciado con CDP en el puerto 9222.
echo Abre WhatsApp Web y escanea el QR si hace falta.
exit /b 0
