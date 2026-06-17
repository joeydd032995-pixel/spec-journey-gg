@echo off
REM ============================================================
REM  H2H GG Analyzer — one-click PyInstaller build
REM  Run from the repo root (the folder containing ggba_gui.py)
REM  Output: dist\H2H_GG_Analyzer.exe
REM ============================================================

echo Installing / updating build dependencies...
pip install --quiet pyinstaller httpx

echo.
echo Building H2H_GG_Analyzer.exe (single-file, no console)...
pyinstaller --onefile --windowed --name "H2H_GG_Analyzer" ^
    --add-data "ggba_h2hggl.py;." ^
    ggba_gui.py

echo.
if exist "dist\H2H_GG_Analyzer.exe" (
    echo BUILD SUCCEEDED
    echo Executable: dist\H2H_GG_Analyzer.exe
) else (
    echo BUILD FAILED — check the output above for errors.
    exit /b 1
)
