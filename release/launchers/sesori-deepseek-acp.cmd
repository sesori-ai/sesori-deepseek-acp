@echo off
setlocal DisableDelayedExpansion
"%~dp0node\node.exe" "%~dp0dist\src\bin.js" %*
exit /b %ERRORLEVEL%
