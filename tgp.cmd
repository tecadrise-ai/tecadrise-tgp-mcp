@echo off
rem Fallback launcher when "npm link" is not used: put this folder on PATH or call it by full path.
node "%~dp0bin\tgp.js" %*
