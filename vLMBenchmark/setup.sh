#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Optimus VLM Benchmark — Setup Script
# ═══════════════════════════════════════════════════════════════
set -e

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║       Optimus VLM Benchmark — Setup                  ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# ── Check OS ──
OS=$(uname -s)
echo "► OS: $OS"

# ── Step 1: Install Ollama ──
echo ""
echo "═══ Step 1: Ollama ═══"
if command -v ollama &> /dev/null; then
    echo "✓ Ollama already installed: $(ollama --version 2>/dev/null || echo 'unknown version')"
else
    echo "Installing Ollama..."
    if [ "$OS" = "Linux" ]; then
        curl -fsSL https://ollama.com/install.sh | sh
    elif [ "$OS" = "Darwin" ]; then
        echo "Download from: https://ollama.com/download/mac"
        echo "Or: brew install ollama"
        exit 1
    else
        echo "Download from: https://ollama.com/download/windows"
        exit 1
    fi
fi

# ── Step 2: Start Ollama (if not running) ──
echo ""
echo "═══ Step 2: Starting Ollama ═══"
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "✓ Ollama is running"
else
    echo "Starting Ollama in background..."
    ollama serve &
    sleep 3
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo "✓ Ollama started"
    else
        echo "✗ Failed to start Ollama. Try: ollama serve"
        exit 1
    fi
fi

# ── Step 3: Pull models ──
echo ""
echo "═══ Step 3: Pulling Models ═══"
echo ""
echo "Available models (select which to pull):"
echo ""
echo "  [1] qwen2.5vl:7b        ~4.7 GB  — Best for invoices (vision model)"
echo "  [2] mistral:7b           ~4.1 GB  — Text-only fallback (fast, CPU-friendly)"
echo "  [3] llama3.2-vision:11b  ~7.9 GB  — Alternative vision model"
echo "  [4] gemma3:12b           ~8.1 GB  — Google vision model"
echo "  [A] All of the above"
echo "  [S] Skip (I'll pull manually)"
echo ""
read -p "Choose [1/2/3/4/A/S]: " choice

pull_model() {
    echo ""
    echo "Pulling $1..."
    ollama pull "$1"
    echo "✓ $1 ready"
}

case $choice in
    1) pull_model "qwen2.5vl:7b" ;;
    2) pull_model "mistral:7b" ;;
    3) pull_model "llama3.2-vision:11b" ;;
    4) pull_model "gemma3:12b" ;;
    [Aa])
        pull_model "qwen2.5vl:7b"
        pull_model "mistral:7b"
        pull_model "llama3.2-vision:11b"
        pull_model "gemma3:12b"
        ;;
    [Ss]) echo "Skipping model pulls." ;;
    *) echo "Invalid choice. Run manually: ollama pull <model>" ;;
esac

# ── Step 4: Python dependencies ──
echo ""
echo "═══ Step 4: Python Dependencies ═══"
pip install requests pdf2image Pillow rich 2>/dev/null || pip install --user requests pdf2image Pillow rich

# Optional: Tesseract for text-model comparison
if command -v tesseract &> /dev/null; then
    echo "✓ Tesseract installed"
    pip install pytesseract 2>/dev/null || pip install --user pytesseract
else
    echo "⚠ Tesseract not found (optional — needed for text-model comparison)"
    echo "  Install: sudo apt install tesseract-ocr tesseract-ocr-ell"
fi

# Check poppler (needed by pdf2image)
if command -v pdftoppm &> /dev/null; then
    echo "✓ poppler-utils installed"
else
    echo "Installing poppler-utils (for PDF rendering)..."
    if [ "$OS" = "Linux" ]; then
        sudo apt-get install -y poppler-utils 2>/dev/null || echo "⚠ Install manually: sudo apt install poppler-utils"
    elif [ "$OS" = "Darwin" ]; then
        brew install poppler 2>/dev/null || echo "⚠ Install manually: brew install poppler"
    fi
fi

# ── Done ──
echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║                    Setup Complete!                    ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""
echo "Available models:"
ollama list 2>/dev/null || echo "(run 'ollama list' to see)"
echo ""
echo "Quick test:"
echo "  python benchmark.py --pdf your_invoice.pdf --models qwen"
echo ""
echo "Full benchmark with ground truth:"
echo "  python benchmark.py --pdf invoices/ --ground-truth ground_truth.json --models qwen,mistral"
echo ""
