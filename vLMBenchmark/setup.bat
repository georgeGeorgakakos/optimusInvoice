@echo off
chcp 65001 >nul 2>&1

echo.
echo  =========================================================
echo    Optimus VLM Benchmark - Windows Setup
echo  =========================================================
echo.

REM -- Step 1: Check Ollama --
echo [Step 1] Checking Ollama...
where ollama >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo   Ollama is not installed yet.
    echo.
    echo   1. Download from: https://ollama.com/download/windows
    echo   2. Run the installer (OllamaSetup.exe)
    echo   3. Restart this terminal after installation
    echo   4. Run this script again
    echo.
    pause
    exit /b 1
)
echo   [OK] Ollama found

REM -- Step 2: Check if Ollama is running --
echo.
echo [Step 2] Checking if Ollama is running...
curl -s http://localhost:11434/api/tags >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   Starting Ollama...
    start /B ollama serve >nul 2>&1
    timeout /t 5 /nobreak >nul
    curl -s http://localhost:11434/api/tags >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo   Could not start Ollama. Try running "ollama serve" in a separate terminal.
        pause
        exit /b 1
    )
)
echo   [OK] Ollama is running

REM -- Step 3: Show available models --
echo.
echo [Step 3] Current models:
ollama list 2>nul
echo.

REM -- Step 4: Pull models --
echo  Which models do you want to pull?
echo.
echo   [1] qwen2.5vl:7b        (~4.7 GB) - RECOMMENDED - Vision model
echo   [2] mistral:7b           (~4.1 GB) - Text-only fallback, fast on CPU
echo   [3] llama3.2-vision:11b  (~7.9 GB) - Alternative vision model (Meta)
echo   [4] gemma3:12b           (~8.1 GB) - Vision model (Google)
echo   [A] All of the above
echo   [S] Skip
echo.
set /p choice="  Your choice [1/2/3/4/A/S]: "

if "%choice%"=="1" goto pull_qwen
if "%choice%"=="2" goto pull_mistral
if "%choice%"=="3" goto pull_llama
if "%choice%"=="4" goto pull_gemma
if /i "%choice%"=="A" goto pull_all
if /i "%choice%"=="S" goto skip_pull
goto skip_pull

:pull_qwen
echo   Pulling qwen2.5vl:7b...
ollama pull qwen2.5vl:7b
goto done_pull

:pull_mistral
echo   Pulling mistral:7b...
ollama pull mistral:7b
goto done_pull

:pull_llama
echo   Pulling llama3.2-vision:11b...
ollama pull llama3.2-vision:11b
goto done_pull

:pull_gemma
echo   Pulling gemma3:12b...
ollama pull gemma3:12b
goto done_pull

:pull_all
ollama pull qwen2.5vl:7b
ollama pull mistral:7b
ollama pull llama3.2-vision:11b
ollama pull gemma3:12b
goto done_pull

:skip_pull
echo   Skipping model pulls.

:done_pull
echo.

REM -- Step 5: Python dependencies --
echo [Step 4] Installing Python dependencies...
pip install requests pdf2image Pillow rich 2>nul
if %ERRORLEVEL% NEQ 0 (
    pip install --user requests pdf2image Pillow rich
)

REM -- Step 6: poppler check --
echo.
echo [Step 5] Checking poppler (required for PDF rendering)...
where pdftoppm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo   poppler NOT FOUND - pdf2image needs it to render PDFs.
    echo.
    echo   Option A - scoop (easiest):
    echo     scoop install poppler
    echo.
    echo   Option B - conda:
    echo     conda install -c conda-forge poppler
    echo.
    echo   Option C - manual:
    echo     1. Download from: https://github.com/oschwartz10612/poppler-windows/releases
    echo     2. Extract zip to C:\poppler
    echo     3. Add C:\poppler\Library\bin to your system PATH
    echo     4. Restart terminal
    echo.
) else (
    echo   [OK] poppler found
)

REM -- Step 7: Tesseract check (optional) --
echo.
echo [Step 6] Checking Tesseract (optional - for text-model comparison)...
where tesseract >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   Tesseract not found (optional)
    echo   Download from: https://github.com/UB-Mannheim/tesseract/wiki
) else (
    echo   [OK] Tesseract found
    pip install pytesseract 2>nul
)

echo.
echo  =========================================================
echo    Setup Complete!
echo  =========================================================
echo.
echo  Quick test:
echo    python quick_test.py your_invoice.pdf
echo.
echo  Full benchmark:
echo    python benchmark.py --pdf invoices\ --models qwen,mistral
echo.
pause
