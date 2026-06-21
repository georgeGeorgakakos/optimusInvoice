/**
 * Python ML System Integration Module
 * Provides Node.js interface to Python invoice extraction, product matching, and rule learning
 *
 * VLM Integration (Multi-Engine):
 * For scanned PDFs where pdfplumber fails, the VLM service provides visual OCR text
 * using one of three engines:
 *   - Surya (default, ~80s) — line-level detection + recognition
 *   - GOT-OCR2 (~7min) — generative OCR
 *   - Chandra (~30-60min) — full-page document understanding with structured markdown
 *
 * The VLM text feeds into the same Python extractors via --ocr-text.
 * Multiple engines can run together (e.g. "surya,chandra") for parallel extraction,
 * and the best result is selected automatically.
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import FormDataNode from "form-data";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Python scripts directory
const PYTHON_DIR = path.join(__dirname, "python");

// ── Robust Python command detection ──
let _resolvedPythonCmd: string | null = null;

async function resolvePythonCommand(): Promise<string> {
  if (_resolvedPythonCmd) return _resolvedPythonCmd;

  const candidates =
      process.platform === "win32"
          ? ["py", "python", "python3"]
          : ["python3", "python", "py"];

  for (const cmd of candidates) {
    try {
      const realPath = await new Promise<string | null>(resolve => {
        const proc = spawn(cmd, ["-c", "import sys; print(sys.executable)"], {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        });
        let out = "";
        proc.stdout.on("data", d => (out += d.toString()));
        proc.on("close", code => resolve(code === 0 ? out.trim() : null));
        proc.on("error", () => resolve(null));
      });

      if (realPath && realPath.length > 0) {
        _resolvedPythonCmd = realPath;
        console.log(`[ML] Python resolved: ${cmd} → ${realPath}`);
        return realPath;
      }
    } catch {
      // try next
    }
  }

  throw new Error(
      "Python not found. Tried: " +
      candidates.join(", ") +
      ". Please install Python and ensure it is on your PATH."
  );
}

// Data directories for Python ML system
const DATA_DIR = path.join(__dirname, "../data");
const INVOICES_DIR = path.join(DATA_DIR, "invoices");
const KNOWLEDGE_BASE_DIR = path.join(DATA_DIR, "knowledge_base");
const RULES_DIR = path.join(DATA_DIR, "rules");

// ── VLM Service Configuration ──
// New unified service on port 8300 (Surya + GOT-OCR2 + Marker + olmOCR + Qwen2.5-VL)
const VLM_SERVICE_URL = process.env.VLM_SERVICE_URL || "http://localhost:8100";
const VLM_ENABLED =
    (process.env.VLM_ENABLED || "true").toLowerCase() !== "false";
const VLM_TIMEOUT = parseInt(process.env.VLM_TIMEOUT || "600000", 10); // 10 min default (Qwen on CPU can take 2-5 min)
// Supported engines: surya | got_ocr2 | olmocr | marker | qwen_vl | auto
const VLM_ENGINE = process.env.VLM_ENGINE || "auto";

/**
 * Initialize required directories for Python ML system
 */
export async function initializePythonDirectories() {
  const dirs = [DATA_DIR, INVOICES_DIR, KNOWLEDGE_BASE_DIR, RULES_DIR];

  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error(`Failed to create directory ${dir}:`, error);
    }
  }
}

/**
 * Execute Python script with arguments and return parsed JSON result
 */
async function executePythonScript(
    scriptName: string,
    args: string[] = [],
    options: { timeout?: number } = {}
): Promise<any> {
  const scriptPath = path.join(PYTHON_DIR, scriptName);
  const timeout = options.timeout || 60000;
  const pythonCmd = await resolvePythonCommand();

  return new Promise((resolve, reject) => {
    const pythonProcess = spawn(pythonCmd, [scriptPath, ...args], {
      cwd: PYTHON_DIR,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        DATA_DIR,
        INVOICES_DIR,
        KNOWLEDGE_BASE_DIR,
        RULES_DIR,
      },
    });

    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", data => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on("data", data => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      pythonProcess.kill();
      reject(
          new Error(`Python script ${scriptName} timed out after ${timeout}ms`)
      );
    }, timeout);

    pythonProcess.on("close", code => {
      clearTimeout(timeoutId);

      if (code !== 0) {
        reject(
            new Error(
                `Python script ${scriptName} failed with code ${code}: ${stderr}`
            )
        );
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (error) {
        resolve({ output: stdout, stderr });
      }
    });

    pythonProcess.on("error", error => {
      clearTimeout(timeoutId);
      reject(
          new Error(
              `Failed to start Python script ${scriptName}: ${error.message}`
          )
      );
    });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VLM Service Integration (Multi-Engine)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface VlmHealthStatus {
  status: string;
  device: string;
  loaded_models: string[];
  vllm_url: string;
  semantic_llm?: string;   // e.g. "online (qwen2.5:3b)" or "offline (regex fallback active)"
  ollama_url?: string;
  // legacy compat fields
  engines?: Record<string, { loaded: boolean; type: string; params: string }>;
  default_engine?: string;
}

interface VlmEngineResult {
  text: string;
  chars: number;
  elapsed: number;
  status: string;
}

interface VlmExtractResult {
  ocr_text: string;
  engines: Record<string, VlmEngineResult>;
  engines_used: string[];
  elapsed_seconds: number;
  confidence: number;
}

/**
 * Check if VLM sidecar service is available and which engines are loaded
 */
async function getVlmStatus(): Promise<VlmHealthStatus | null> {
  if (!VLM_ENABLED) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${VLM_SERVICE_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = (await res.json()) as VlmHealthStatus;
    // New service returns { status: "ok", device, loaded_models, vllm_url }
    // Old service returned { status: "ok"|"degraded", engines, default_engine }
    return data?.status === "ok" || data?.status === "degraded" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Error thrown when the VLM service is reachable-in-principle but not ready to
 * serve extractions yet (still loading models after a restart / host resume).
 * The queue worker treats this specially: it DEFERS the invoice (re-queue to the
 * back of the queue without counting a retry) instead of failing it.
 */
export class VlmNotReadyError extends Error {
  code = "VLM_NOT_READY" as const;
  constructor(message: string) {
    super(message);
    this.name = "VlmNotReadyError";
  }
}

/**
 * Probe VLM readiness with a short budget. Returns the health status if the
 * service answers ok within the budget; otherwise throws VlmNotReadyError.
 *
 * This is intentionally SHORT (a couple of probes, ~8s): we do NOT block the
 * single worker for the full ~8-min vlm cold-load. Instead, on "not ready" the
 * worker defers this invoice to the back of the queue and processes the next
 * one, cycling until vlm is ready. Net effect: the queue keeps moving and no
 * invoice fails during warm-up.
 *
 * Tunables:
 *   VLM_READY_TIMEOUT_MS  (default 8000)  — total budget for the precheck
 *   VLM_READY_POLL_MS     (default 4000)  — gap between probes
 */
async function requireVlmReady(): Promise<VlmHealthStatus> {
  if (!VLM_ENABLED) {
    throw new VlmNotReadyError("[VLM] VLM is disabled (VLM_ENABLED=false).");
  }
  const budgetMs = parseInt(process.env.VLM_READY_TIMEOUT_MS || "8000", 10);
  const pollMs = parseInt(process.env.VLM_READY_POLL_MS || "4000", 10);
  const deadline = Date.now() + budgetMs;

  // Always try at least once.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await getVlmStatus(); // single probe, already 5s-bounded
    if (status) return status;
    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, Math.min(pollMs, deadline - Date.now())));
  }

  throw new VlmNotReadyError(
      "[VLM] SLM service is not available at " + VLM_SERVICE_URL +
      " (still loading models or not reachable). It will be retried automatically."
  );
}


/**
 * Check if VLM service is available (backward compatible)
 */
async function isVlmAvailable(): Promise<boolean> {
  const status = await getVlmStatus();
  return status?.status === "ok";
}

/**
 * Call VLM service to get OCR text from ALL pages of a PDF.
 *
 * New service (port 8300) exposes /extract-pdf which:
 *   - Primary:  Marker (PDF→Markdown, handles text+scanned, best Greek accuracy)
 *   - Fallback: per-page Surya (if Marker not loaded)
 *   - For deep/structured extraction: olmOCR-2-7B or Qwen2.5-VL via vLLM
 *
 * Engine selection via VLM_ENGINE env var or per-call:
 *   auto     → Marker first, escalate to olmOCR if confidence < 0.70
 *   surya    → Fast layout-aware OCR
 *   got_ocr2 → High-accuracy generative OCR
 *   olmocr   → allenai/olmOCR-2-7B (structured JSON extraction)
 *   marker   → PDF → Markdown (best for mixed PDFs)
 *   qwen_vl  → Qwen2.5-VL-7B/3B (visual Q&A)
 */
async function getVlmOcrText(
    pdfPath: string,
    engine: string = VLM_ENGINE,
    useNativeText: boolean = false
): Promise<{
  text: string;
  engine: string;
  extractionMethod: string;
  totalPages: number;
  allResults: Record<string, VlmEngineResult>;
  structured?: any;
} | null> {
  if (!VLM_ENABLED) return null;

  try {
    const pdfBuffer = await fs.readFile(pdfPath);

    // Use form-data + http module instead of native fetch + Blob
    // Native Node.js fetch with FormData+Blob fails silently on Windows (undici bug)
    const form = new FormDataNode();
    form.append("file", pdfBuffer, {
      filename: path.basename(pdfPath),
      contentType: "application/pdf",
    });
    form.append("doc_type", "auto");
    form.append("engine", engine);
    form.append("extract_invoice", "1");
    form.append("use_native_text", useNativeText ? "1" : "0");

    // Timeouts by engine
    // qwen_vl_local: 30 min first run (downloads ~2.3 GB), ~2 min after (cached)
    // Timeout by engine — qwen_vl_local gets 30 min for CPU inference
    const baseTimeout = engine === "qwen_vl_local"
        ? 1800000  // 30 min — Qwen2.5-VL-3B CPU inference
        : engine.includes("got_ocr2")
            ? 600000   // 10 min
            : engine.includes("olmocr") || engine === "qwen_vl"
                ? 300000   // 5 min
                : VLM_TIMEOUT;  // surya / pdfplumber: 10 min default

    console.log(
        `[VLM] Sending ${path.basename(pdfPath)} to VLM service (engine=${engine})...`
    );

    // POST using Node.js http module — reliable multipart on Windows
    // NOTE: http.request "timeout" option is an INACTIVITY timeout (fires if no
    // data flows for N ms). For Qwen2.5-VL this is wrong — the server is silent
    // for the entire ~600s inference then sends the full response in one shot.
    // We use a wall-clock deadline via setTimeout instead.
    const serviceUrl = new URL(`${VLM_SERVICE_URL}/extract-pdf`);
    const resBody = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      // Wall-clock deadline — fires if the entire request+response cycle
      // hasn't completed within baseTimeout ms (e.g. 30 min for qwen_vl_local)
      const deadline = setTimeout(() => {
        req.destroy();
        done(() => reject(new Error(`Request timed out after ${baseTimeout}ms`)));
      }, baseTimeout);

      const req = http.request({
        hostname: serviceUrl.hostname,
        port: parseInt(serviceUrl.port || "8100"),
        path: serviceUrl.pathname,
        method: "POST",
        headers: form.getHeaders(),
        // No socket-level timeout here — that would fire during silent inference
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(deadline);
          done(() => resolve(Buffer.concat(chunks).toString("utf-8")));
        });
        res.on("error", (err) => {
          clearTimeout(deadline);
          done(() => reject(err));
        });
      });
      req.on("error", (err) => {
        clearTimeout(deadline);
        done(() => reject(err));
      });
      form.pipe(req);
    });

    const res = { ok: true, status: 200, json: async () => JSON.parse(resBody) };
    if (!res.ok) {
      console.warn(`[VLM] Service returned HTTP ${res.status}`);
      return null;
    }

    const result = (await res.json()) as any;
    const allResults = result.engines || {};
    const totalPages = result.total_pages || 1;
    const bestText: string = result.ocr_text || "";
    const bestEngine: string = (result.engines_used || [engine])[0] || engine;
    const extractionMethod: string = result.extraction_method || "unknown";
    const structured = result.invoice || result.structured || null; // ← pick up parsed invoice

    if (bestText.trim().length > 50) {
      // Label the extraction method clearly in logs
      const methodLabel =
          extractionMethod === "native_text" ? "📄 pdfplumber (text-based PDF — no OCR needed)" :
              extractionMethod === "ocr_image"   ? "🔍 " + bestEngine + " (image OCR)" :
                  extractionMethod === "vlm"         ? "🤖 " + bestEngine + " (VLM)" :
                      bestEngine;
      console.log(
          `[VLM] ${methodLabel}: ${bestText.length} chars across ${totalPages} pages in ${result.elapsed_seconds}s`
      );
      for (const [eng, data] of Object.entries(allResults) as any) {
        const status = data.status === "ok" ? "✅" : "❌";
        console.log(
            `[VLM]   ${status} ${eng}: ${data.chars} chars in ${data.elapsed}s`
        );
      }
      return {
        text: bestText,
        engine: bestEngine,
        extractionMethod,
        totalPages,
        allResults,
        structured,
      };
    } else {
      console.warn(
          `[VLM] Service returned very little text (${bestText.length} chars)`
      );
      return null;
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn(`[VLM] Request timed out`);
    } else {
      console.warn(`[VLM] Request failed: ${err?.message || err}`);
    }
    return null;
  }
}

/**
 * Save VLM OCR text to a temp file for Python extractors to use.
 */
async function saveVlmText(
    pdfPath: string,
    vlmText: string,
    engine: string
): Promise<string> {
  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  const vlmTextPath = path.join(INVOICES_DIR, `${baseName}.vlm.txt`);
  await fs.writeFile(vlmTextPath, vlmText, "utf-8");
  console.log(
      `[VLM] ${engine} text saved: ${vlmTextPath} (${vlmText.length} chars)`
  );
  return vlmTextPath;
}

/**
 * If multiple engines ran, save all results for comparison/debugging
 */
async function saveAllVlmResults(
    pdfPath: string,
    allResults: Record<string, VlmEngineResult>
): Promise<void> {
  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  for (const [eng, data] of Object.entries(allResults)) {
    if (data.status === "ok" && data.text.length > 0) {
      const filePath = path.join(INVOICES_DIR, `${baseName}.vlm.${eng}.txt`);
      await fs.writeFile(filePath, data.text, "utf-8");
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Extraction & Classification API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Extract invoice data from PDF using Python ML system
 */
export interface InvoiceExtractionResult {
  success: boolean;
  invoiceNumber?: string;
  invoiceDate?: string;
  supplier?: {
    name: string;
    code?: string;
    vatNumber?: string;
  };
  lineItems: Array<{
    description: string;
    supplierCode: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    vatRate?: number;
  }>;
  totals?: {
    subtotal: number;
    vat: number;
    total: number;
  };
  error?: string;
}

export async function extractInvoiceFromPDF(
    pdfPath: string
): Promise<InvoiceExtractionResult> {
  try {
    const pdfFilename = path.basename(pdfPath);
    const targetPath = path.join(INVOICES_DIR, pdfFilename);
    await fs.copyFile(pdfPath, targetPath);

    const result = await executePythonScript(
        "invoice_extractor_advanced.py",
        [targetPath, "--json"],
        { timeout: 120000 }
    );

    return {
      success: true,
      ...result,
    };
  } catch (error) {
    console.error("Invoice extraction failed:", error);
    return {
      success: false,
      lineItems: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Classify document type from PDF content
 */
export interface ClassificationResult {
  documentType: "invoice" | "credit_note" | "cmr" | "dispatch_note";
  confidence: number;
  scores?: Record<string, number>;
  error?: string;
}

export async function classifyDocument(
    pdfPath: string
): Promise<ClassificationResult> {
  try {
    const pdfFilename = path.basename(pdfPath);
    const targetPath = path.join(INVOICES_DIR, pdfFilename);
    try {
      await fs.copyFile(pdfPath, targetPath);
    } catch {}

    const result = await executePythonScript(
        "document_classifier.py",
        [targetPath],
        { timeout: 30000 }
    );
    return {
      documentType: result.documentType || "invoice",
      confidence: result.confidence || 0,
      scores: result.scores,
    };
  } catch (error) {
    console.error("Document classification failed:", error);
    return {
      documentType: "invoice",
      confidence: 0,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Extract CMR (Consignment Note) data from PDF
 */
export async function extractCMR(pdfPath: string): Promise<any> {
  try {
    const pdfFilename = path.basename(pdfPath);
    const targetPath = path.join(INVOICES_DIR, pdfFilename);
    try {
      await fs.copyFile(pdfPath, targetPath);
    } catch {}

    const result = await executePythonScript(
        "cmr_extractor.py",
        [targetPath, "--json"],
        { timeout: 120000 }
    );
    return { success: true, ...result };
  } catch (error) {
    console.error("CMR extraction failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Extract Dispatch Note data from PDF
 */
export async function extractDispatchNote(pdfPath: string): Promise<any> {
  try {
    const pdfFilename = path.basename(pdfPath);
    const targetPath = path.join(INVOICES_DIR, pdfFilename);
    try {
      await fs.copyFile(pdfPath, targetPath);
    } catch {}

    const result = await executePythonScript(
        "dispatch_extractor.py",
        [targetPath, "--json"],
        { timeout: 120000 }
    );
    return { success: true, ...result };
  } catch (error) {
    console.error("Dispatch note extraction failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Extract Credit Note data from PDF
 */
export async function extractCreditNote(pdfPath: string): Promise<any> {
  try {
    const pdfFilename = path.basename(pdfPath);
    const targetPath = path.join(INVOICES_DIR, pdfFilename);
    try {
      await fs.copyFile(pdfPath, targetPath);
    } catch {}

    const result = await executePythonScript(
        "credit_note_extractor.py",
        [targetPath, "--json"],
        { timeout: 120000 }
    );
    return { success: true, ...result };
  } catch (error) {
    console.error("Credit note extraction failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VLM-direct helpers (used by classifyAndExtract below)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Parse invoice fields from raw VLM text by calling vlm_invoice_parser.py.
 * Handles dual-currency invoices, exchange rate lines, service invoices,
 * and the "Number XXXXX" vs "INVOICE" word ambiguity.
 */
async function parseInvoiceWithVlmParser(text: string): Promise<any> {
  const tmpPath = path.join(INVOICES_DIR, `vlm_parse_${Date.now()}.txt`);
  await fs.writeFile(tmpPath, text, "utf-8");
  try {
    const result = await executePythonScript(
        "vlm_invoice_parser.py",
        ["--text-file", tmpPath, "--json"],
        { timeout: 15000 }
    );
    return result;
  } finally {
    fs.unlink(tmpPath).catch(() => {});
  }
}

/**
 * Lightweight document-type detector that works on raw text.
 * Avoids spawning document_classifier.py when we already have clean VLM text.
 */
function detectDocumentType(
    text: string
): ClassificationResult["documentType"] {
  const t = text.toUpperCase();
  if (/\bCREDIT\s+NOTE\b|\bΠΙΣΤΩΤΙΚΟ\b/.test(t)) return "credit_note";
  if (/\bCMR\b|\bCONSIGNMENT\b/.test(t)) return "cmr";
  if (/\bDELIVERY\s+NOTE\b|\bΔΕΛΤΙΟ\s+ΑΠΟΣΤΟΛΗΣ\b/.test(t))
    return "dispatch_note";
  return "invoice";
}

/**
 * Resolve the currency for an extracted invoice.
 *
 * Strategy: trust the LLM/parser's value if and only if it's consistent with
 * the currency symbols actually present in the OCR text. The common failure
 * mode is the LLM defaulting to "EUR" even when the invoice clearly shows
 * USD ($) — typically on US-domiciled supplier invoices like New Relic,
 * Adobe US, Datadog, etc.
 *
 * Detection signals (priority order):
 *   1. ISO codes in the text: USD, EUR, GBP, BGN, JPY, CNY, ILS, CHF, CAD, AUD
 *   2. Explicit text like "Invoice Total (USD)", "Total in EUR", etc.
 *   3. Currency symbols: $ € £ лв ¥ ₪
 *
 * Decision rules:
 *   - If LLM returned a value AND that value's signal appears in the text → trust it
 *   - If LLM returned a value but NO matching signal exists → check if another
 *     currency's signal IS present; if so, switch to that. Otherwise keep LLM's value.
 *   - If LLM returned nothing AND text has a clear signal → use the detected signal
 *   - If no signal at all → return whatever the LLM said (or null if nothing)
 *
 * This deliberately avoids overriding the LLM when it has cross-evidence, while
 * catching the EUR-default failure mode.
 */
function resolveCurrency(
    llmCurrency: string | null | undefined,
    ocrText: string | null | undefined
): string | null {
  const text = ocrText || "";
  const llm  = (llmCurrency || "").toUpperCase().trim();

  // Detect which ISO currencies have positive signals in the OCR text
  // We do BOTH symbol AND code/word checks. "$" alone is enough for USD.
  const signals: Record<string, RegExp[]> = {
    USD: [/\bUSD\b/i, /\$/],
    EUR: [/\bEUR\b/i, /€/],
    GBP: [/\bGBP\b/i, /£/],
    BGN: [/\bBGN\b/i, /лв/i],
    JPY: [/\bJPY\b/i],
    CNY: [/\bCNY\b/i, /¥/],   // ¥ is ambiguous JPY/CNY — assigning to CNY for now (CN context more common in our PoC)
    ILS: [/\bILS\b/i, /₪/],
    CHF: [/\bCHF\b/i],
    CAD: [/\bCAD\b/i],
    AUD: [/\bAUD\b/i],
  };

  const detected = new Set<string>();
  for (const [iso, patterns] of Object.entries(signals)) {
    if (patterns.some(p => p.test(text))) detected.add(iso);
  }

  // No signals at all — trust LLM (or return null if it also said nothing)
  if (detected.size === 0) {
    return llm || null;
  }

  // LLM returned nothing — use the most-likely detected currency
  if (!llm) {
    // Prefer USD/EUR/GBP/BGN over symbol-only matches
    for (const pref of ["USD", "EUR", "GBP", "BGN", "ILS", "CHF", "JPY", "CNY"]) {
      if (detected.has(pref)) return pref;
    }
    return Array.from(detected)[0];
  }

  // LLM's value matches a detected signal → trust LLM
  if (detected.has(llm)) {
    return llm;
  }

  // LLM said something but no signal supports it AND another currency's signal IS present
  // → switch to the detected one (catches the "defaulted to EUR" bug)
  console.warn(
      `[CurrencyResolver] LLM said currency=${llm} but OCR text has signals for ` +
      `${Array.from(detected).join(",")}. Switching to detected currency.`
  );
  // Prefer USD/EUR/GBP/BGN as primary
  for (const pref of ["USD", "EUR", "GBP", "BGN"]) {
    if (detected.has(pref)) return pref;
  }
  return Array.from(detected)[0];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Smart extraction — VLM-only path
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Classify and extract invoice data.
 *
 * Sends the PDF DIRECTLY to the SLM/VLM service on :8300.
 * The OCR pipeline (pdfjs / tesseract / ocr_helper.py) is bypassed entirely.
 * If the VLM service is not running the call throws a clear actionable error.
 */
export async function classifyAndExtract(
    pdfPath: string,
    engineOverride?: string,
    useNativeText: boolean = false
): Promise<{ classification: ClassificationResult; extraction: any }> {
  // ── 1. Require VLM — wait briefly for readiness, else DEFER (no fail) ─────
  // On host sleep/resume vlm needs minutes to reload models. requireVlmReady()
  // throws VlmNotReadyError if it's not ready within a short budget; the queue
  // worker catches that and re-queues this invoice without a retry penalty,
  // moving on to the next one. So warm-up never fails an invoice.
  const vlmStatus = await requireVlmReady();

  console.log(
      `[VLM-DIRECT] SLM service online — loaded: ${
          ((vlmStatus.loaded_models ?? []).join(", ") ||
              vlmStatus.default_engine) ??
          "auto"
      }`
  );

  // ── 2. Send PDF to VLM — request structured invoice fields in one call ───
  const vlmResult = await getVlmOcrText(pdfPath, engineOverride ?? VLM_ENGINE, useNativeText);

  if (!vlmResult || vlmResult.text.trim().length < 20) {
    throw new Error(
        "[VLM] SLM returned no usable text for " +
        path.basename(pdfPath) +
        ". " +
        "Check docker logs for the vlm-service container."
    );
  }

  console.log(
      `[VLM-DIRECT] Engine: ${vlmResult.engine} | ` +
      `Text: ${vlmResult.text.length} chars | ` +
      `Pages: ${vlmResult.totalPages}`
  );

  // ── 3. Parse structured invoice fields ───────────────────────────────────
  // If the VLM engine (olmOCR / Qwen) already returned a structured object, use it.
  // Otherwise run vlm_invoice_parser.py on the raw OCR text.
  let invoiceFields: any;

  if (vlmResult.structured && Object.keys(vlmResult.structured).length > 2) {
    console.log(
        `[VLM-DIRECT] Using structured output from ${vlmResult.engine}`
    );
    invoiceFields = vlmResult.structured;
  } else {
    console.log(`[VLM-DIRECT] Running vlm_invoice_parser on extracted text`);
    invoiceFields = await parseInvoiceWithVlmParser(vlmResult.text);
  }

  // ── 4. Build ClassificationResult ────────────────────────────────────────
  const classification: ClassificationResult = {
    documentType: detectDocumentType(vlmResult.text),
    confidence: invoiceFields.confidence ?? 70,
  };

  console.log(
      `[VLM-DIRECT] Classified: ${classification.documentType} ` +
      `(${classification.confidence}% confidence)`
  );

  // ── 5. Build extraction in the same shape as the old pipeline ────────────
  const extraction = {
    success: true,
    documentType: classification.documentType,
    confidence: invoiceFields.confidence ?? 70,
    invoiceNumber: invoiceFields.invoiceNumber ?? invoiceFields.invoice_number,
    invoiceDate: invoiceFields.invoiceDate ?? invoiceFields.date,
    supplier: invoiceFields.supplier
        ? {
          name: invoiceFields.supplier,
          vatNumber: invoiceFields.supplierVat ?? invoiceFields.vat_number,
          address: invoiceFields.supplierAddress,
        }
        : undefined,
    client: invoiceFields.client,
    clientVat: invoiceFields.clientVat,
    // ── Full issuer / recipient objects from vlm_invoice_parser ──────
    issuer:    invoiceFields.issuer    ?? null,
    recipient: invoiceFields.recipient ?? null,
    // ── Order number (Fiverr, Adobe, etc.) ───────────────────────────
    orderNumber: invoiceFields.orderNumber ?? null,
    // ── myDATA header fields ─────────────────────────────────────────
    mark:                invoiceFields.mark                ?? null,
    uid:                 invoiceFields.uid                 ?? null,
    authenticationCode:  invoiceFields.authenticationCode  ?? null,
    provider:            invoiceFields.provider            ?? null,
// ── Dispatch fields (also present in combined ΤΔΑ invoices) ─────
    dispatchDate:        invoiceFields.dispatchDate        ?? null,
    vehicleNumber:       invoiceFields.vehicleNumber       ?? null,
    purpose:             invoiceFields.purpose             ?? null,
    lineItems: (invoiceFields.lineItems ?? []).map((li: any) => ({
      description: li.description,
      supplierCode: li.supplierCode ?? "",
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      totalPrice: li.totalPrice,
      vatRate: li.vatRate ?? invoiceFields.vatRate ?? 0,
    })),
    totals: {
      // Accept multiple possible Python output shapes:
      //   - semantic_extractor.py uses flat `subtotal` / `vatAmount` / `total`
      //   - vlm_invoice_parser.py (regex) uses flat `subtotal` / `vat` / `total`
      //   - some VLM paths may also wrap them in a `totals` object
      // The UI/DB always expects `totals.{subtotal, vat, total}`, so we
      // normalise here. Without this, totals end up as 0 because field names
      // didn't match (e.g. semantic returns `vatAmount` but we looked for `vat`).
      subtotal: invoiceFields.subtotal
          ?? invoiceFields.totals?.subtotal
          ?? 0,
      vat:      invoiceFields.vatAmount
          ?? invoiceFields.vat
          ?? invoiceFields.totals?.vat
          ?? invoiceFields.totals?.vatAmount
          ?? 0,
      total:    invoiceFields.total
          ?? invoiceFields.totalAmount
          ?? invoiceFields.totals?.total
          ?? invoiceFields.totals?.totalAmount
          ?? 0,
    },
    // ── Currency: detect from OCR text if engine didn't return one or
    //    returned the suspicious "EUR" default. We scan the raw OCR text
    //    for currency symbols ($, €, £, лв, ¥, ₪) and ISO codes. This
    //    catches the common case where the LLM defaults to EUR even when
    //    the invoice clearly shows USD/$ amounts (e.g. US invoices like
    //    New Relic, Adobe US, etc.).
    currency: resolveCurrency(invoiceFields.currency, vlmResult.text),
    paymentMethod: invoiceFields.paymentMethod,
    // VLM metadata — consumed by routers.ts for audit trail
    _vlm_used: true,
    _vlm_engine: vlmResult.engine,
    _vlm_extraction_method: (vlmResult as any).extractionMethod ?? "unknown",
    _vlm_raw_text: vlmResult.text,
    _vlm_structured: vlmResult.structured ?? null,
  };

  console.log(
      `[VLM-DIRECT] Result: ` +
      `invoiceNumber=${extraction.invoiceNumber} | ` +
      `supplier=${extraction.supplier?.name} | ` +
      `total=${extraction.totals.total} ${extraction.currency} | ` +
      `lineItems=${extraction.lineItems.length}`
  );

  return { classification, extraction };
}

/**
 * Classify document with optional OCR text file argument
 */
async function classifyDocumentWithArgs(
    pdfPath: string,
    extraArgs: string[]
): Promise<ClassificationResult> {
  try {
    const pdfFilename = path.basename(pdfPath);
    const targetPath = path.join(INVOICES_DIR, pdfFilename);
    try {
      await fs.copyFile(pdfPath, targetPath);
    } catch {}

    const result = await executePythonScript(
        "document_classifier.py",
        [targetPath, ...extraArgs],
        { timeout: 30000 }
    );
    return {
      documentType: result.documentType || "invoice",
      confidence: result.confidence || 0,
      scores: result.scores,
    };
  } catch (error) {
    console.error("Document classification failed:", error);
    return {
      documentType: "invoice",
      confidence: 0,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Run any extractor script with optional OCR text file argument
 */
async function extractWithArgs(
    script: string,
    pdfPath: string,
    extraArgs: string[]
): Promise<any> {
  try {
    const pdfFilename = path.basename(pdfPath);
    const targetPath = path.join(INVOICES_DIR, pdfFilename);
    try {
      await fs.copyFile(pdfPath, targetPath);
    } catch {}

    const result = await executePythonScript(
        script,
        [targetPath, "--json", ...extraArgs],
        { timeout: 120000 }
    );
    return { success: true, ...result };
  } catch (error) {
    console.error(`${script} extraction failed:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Match product codes using ML system
 */
export interface ProductMatch {
  erpCode: string;
  confidence: number;
  method: "exact" | "fuzzy" | "tfidf" | "pattern";
  description?: string;
  supplierCode?: string;
}

export interface ProductMatchingResult {
  success: boolean;
  matches: ProductMatch[];
  error?: string;
}

export async function matchProduct(
    supplierCode: string,
    description: string,
    supplierName: string,
    topN: number = 5
): Promise<ProductMatchingResult> {
  try {
    const result = await executePythonScript("ml_product_matcher_v2.py", [
      "--supplier-code",
      supplierCode,
      "--description",
      description,
      "--supplier",
      supplierName,
      "--top-n",
      topN.toString(),
      "--json",
    ]);

    return {
      success: true,
      matches: result.matches || [],
    };
  } catch (error) {
    console.error("Product matching failed:", error);
    return {
      success: false,
      matches: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Learn transformation rule from user correction
 */
export interface RuleLearningResult {
  success: boolean;
  ruleId?: string;
  pattern?: {
    type: string;
    transformation: string;
    confidence: number;
    occurrences: number;
  };
  message?: string;
  error?: string;
}

export async function learnFromCorrection(
    supplierName: string,
    supplierCode: string,
    correctErpCode: string,
    description?: string
): Promise<RuleLearningResult> {
  try {
    const args = [
      "--supplier",
      supplierName,
      "--supplier-code",
      supplierCode,
      "--erp-code",
      correctErpCode,
      "--json",
    ];

    if (description) {
      args.push("--description", description);
    }

    const result = await executePythonScript("rule_learning_engine.py", args);

    return {
      success: true,
      ...result,
    };
  } catch (error) {
    console.error("Rule learning failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get learned rules for a supplier
 */
export interface LearnedRule {
  id: string;
  supplier: string;
  pattern: {
    type: string;
    transformation: string;
    confidence: number;
    occurrences: number;
    examples: Array<{
      supplierCode: string;
      erpCode: string;
    }>;
  };
  createdAt: string;
  lastUsed?: string;
}

export async function getLearnedRules(
    supplierName?: string
): Promise<LearnedRule[]> {
  try {
    const args = ["--list", "--json"];
    if (supplierName) {
      args.push("--supplier", supplierName);
    }

    const result = await executePythonScript("rule_learning_engine.py", args);
    return result.rules || [];
  } catch (error) {
    console.error("Failed to get learned rules:", error);
    return [];
  }
}

/**
 * Get knowledge base statistics
 */
export interface KnowledgeBaseStats {
  totalMappings: number;
  suppliers: number;
  products: number;
  rules: number;
  automationRate?: number;
}

export async function getKnowledgeBaseStats(): Promise<KnowledgeBaseStats> {
  try {
    const knowledgeFiles = await fs.readdir(KNOWLEDGE_BASE_DIR);
    const ruleFiles = await fs.readdir(RULES_DIR);

    let totalMappings = 0;
    const suppliers = new Set<string>();
    const products = new Set<string>();

    for (const file of knowledgeFiles) {
      if (file.endsWith(".json")) {
        const filePath = path.join(KNOWLEDGE_BASE_DIR, file);
        const content = await fs.readFile(filePath, "utf-8");
        const data = JSON.parse(content);

        if (data.mappings) {
          totalMappings += Object.keys(data.mappings).length;
          suppliers.add(data.supplier || file.replace(".json", ""));
          Object.values(data.mappings).forEach((code: any) =>
              products.add(code)
          );
        }
      }
    }

    return {
      totalMappings,
      suppliers: suppliers.size,
      products: products.size,
      rules: ruleFiles.filter(f => f.endsWith(".json")).length,
    };
  } catch (error) {
    console.error("Failed to get knowledge base stats:", error);
    return {
      totalMappings: 0,
      suppliers: 0,
      products: 0,
      rules: 0,
    };
  }
}

// Initialize directories on module load
initializePythonDirectories().catch(console.error);