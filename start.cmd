@echo off
rem Starts the CoverWell Marketplace test app on http://localhost:3000
rem Optional: set PORT=8080, set ACA_RESET_ON_START=1 (reseed DB at every start), set ACA_DB_PATH=C:\path\aca.db
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning src\server.js
