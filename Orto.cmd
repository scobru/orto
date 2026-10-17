@echo off
title Orto
cd /d "%~dp0"
if exist "node.exe" (
  "node.exe" --no-warnings desktop.js
) else (
  node --no-warnings desktop.js
)
if %errorlevel% neq 0 (
  echo.
  echo Errore durante l'avvio di Orto.
  echo Assicurati che Node.js (versione 22 o superiore) sia installato.
  pause
)
