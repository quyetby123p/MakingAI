@echo off
set "KEYFILE=%LOCALAPPDATA%\StudioFlow\openai-key.clixml"
if exist "%KEYFILE%" (
  del /q "%KEYFILE%"
  echo Da xoa API key ma hoa. Lan mo Studio Flow tiep theo se hoi key moi.
) else (
  echo Chua co API key da luu.
)
pause
