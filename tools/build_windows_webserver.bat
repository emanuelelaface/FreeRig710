@echo off
setlocal
cd /d "%~dp0\.."

where py >nul 2>nul
if not errorlevel 1 (
    set "PYTHON=py"
) else (
    set "PYTHON=python"
)

%PYTHON% -m PyInstaller --version >nul 2>nul
if errorlevel 1 (
    echo PyInstaller is not installed.
    echo Install it once with:
    echo   %PYTHON% -m pip install pyinstaller
    echo.
    exit /b 1
)

if exist build\serve_gui rmdir /s /q build\serve_gui
if exist tools\serve_gui.exe del /q tools\serve_gui.exe

%PYTHON% -m PyInstaller --noconfirm --clean --onefile --console ^
  --name serve_gui ^
  --distpath tools ^
  --workpath build\serve_gui ^
  --specpath build ^
  --add-data "frontend;frontend" ^
  tools\serve_gui.py

if errorlevel 1 exit /b %errorlevel%

echo.
echo Built successfully:
echo   tools\serve_gui.exe
endlocal
