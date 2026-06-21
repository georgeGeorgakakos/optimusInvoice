/**
 * vlmOrchestrator.ts
 *
 * Orchestrates the Optimus VLM / OCR service stack.
 *
 * Services
 * ─────────
 *  • VLM Service   (port 8300) — Surya, GOT-OCR2, olmOCR, Marker, Qwen2.5-VL
 *  • Encoder       (port 8100) — LayoutLMv3 / LiLT
 *  • Detection     (port 8101) — YOLOv5 / ResNet50
 *
 * Engine selection strategy
 * ─────────────────────────
 *  "auto"     → Surya first; if confidence < 0.70 escalate to olmOCR
 *  "surya"    → Fast Greek/English OCR with layout lines
 *  "got_ocr2" → High-accuracy deep analysis fallback
 *  "olmocr"   → allenai/olmOCR-2-7B structured JSON extraction
 *  "marker"   → PDF → Markdown (full document, mixed text+scan)
 *  "qwen_vl"  → Qwen2.5-VL visual Q&A / custom prompts
 */

import axios, { AxiosError } from "axios";
import fs from "fs";
import path from "path";

// ─────────────────────────── config ──────────────────────────────
const VLM_BASE = process.env.VLM_SERVICE_URL ?? "http://localhost:8100";
const ENC_BASE = process.env.ENCODER_URL ?? "http://localhost:8100";
const DET_BASE = process.env.DETECTION_URL ?? "http://localhost:8101";
const VLLM_BASE = process.env.VLLM_URL ?? "http://localhost:8200";

// ─────────────────────────── types ───────────────────────────────

export type OcrEngine =
  | "auto"
  | "surya"
  | "got_ocr2"
  | "olmocr"
  | "marker"
  | "qwen_vl";

export interface OcrLine {
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
}

export interface OcrResult {
  engine: string;
  text: string;
  lines: OcrLine[];
  latency_ms: number;
  confidence: number | null;
  structured: InvoiceStructured | null;
}

export interface InvoiceStructured {
  header?: {
    supplier?: string;
    invoice_number?: string;
    date?: string;
    vat_number?: string;
  };
  line_items?: Array<{
    description: string;
    qty?: number;
    unit_price?: number;
    total?: number;
  }>;
  totals?: {
    subtotal?: number;
    vat?: number;
    total?: number;
  };
  raw_text?: string;
}

export interface MarkerResult {
  markdown: string;
  metadata: Record<string, unknown>;
  latency_ms: number;
}

export interface OrchestratorResult {
  ocr: OcrResult;
  layout?: LayoutResult;
  detection?: DetectionResult;
  pipeline?: string;
}

export interface LayoutResult {
  tokens: string[];
  boxes: number[][];
  entities?: Record<string, string[]>;
}

export interface DetectionResult {
  tables: BoundingBox[];
  stamps: BoundingBox[];
  logos: BoundingBox[];
}

export interface BoundingBox {
  bbox: [number, number, number, number];
  confidence: number;
  label: string;
}

// ─────────────────────────── helpers ─────────────────────────────

function toBase64(input: Buffer | string): string {
  if (Buffer.isBuffer(input)) return input.toString("base64");
  if (fs.existsSync(input)) return fs.readFileSync(input).toString("base64");
  return input; // assume already base64
}

function handleAxiosError(context: string, err: unknown): never {
  if (axios.isAxiosError(err)) {
    const ae = err as AxiosError<{ detail?: string }>;
    const detail = ae.response?.data?.detail ?? ae.message;
    throw new Error(
      `[${context}] ${ae.response?.status ?? "NETWORK"}: ${detail}`
    );
  }
  throw err;
}

// ─────────────────────────── OCR calls ───────────────────────────

/**
 * Run OCR on a single image using the specified engine.
 */
export async function runOcr(
  imageInput: Buffer | string,
  options: {
    engine?: OcrEngine;
    language?: string;
    prompt?: string;
  } = {}
): Promise<OcrResult> {
  const b64 = toBase64(imageInput);
  try {
    const { data } = await axios.post<OcrResult>(`${VLM_BASE}/ocr`, {
      image_b64: b64,
      engine: options.engine ?? "auto",
      language: options.language ?? "el",
      prompt: options.prompt,
    });
    return data;
  } catch (err) {
    return handleAxiosError("runOcr", err);
  }
}

/**
 * Two-stage pipeline: Surya → olmOCR escalation.
 * Mirrors the /ocr/pipeline endpoint but runs client-side for
 * more control over escalation threshold.
 */
export async function runPipeline(
  imageInput: Buffer | string,
  language = "el",
  confidenceThreshold = 0.7
): Promise<OcrResult> {
  const b64 = toBase64(imageInput);
  const surya = await runOcr(b64, { engine: "surya", language });
  const conf = surya.confidence ?? 0;

  if (conf >= confidenceThreshold) {
    console.log(
      `[vlmOrchestrator] Surya confidence ${conf.toFixed(2)} ✓ — no escalation needed`
    );
    return surya;
  }

  console.log(
    `[vlmOrchestrator] Surya confidence ${conf.toFixed(2)} < ${confidenceThreshold} — escalating to olmOCR`
  );
  const olmocr = await runOcr(b64, { engine: "olmocr", language });
  return { ...olmocr, engine: "surya+olmocr" };
}

/**
 * Convert a full PDF to Markdown using Marker.
 * Best for mixed (text + scanned) PDFs.
 */
export async function convertPdfWithMarker(
  pdfInput: Buffer | string,
  options: { forceOcr?: boolean; extractImages?: boolean } = {}
): Promise<MarkerResult> {
  const b64 = toBase64(pdfInput);
  try {
    const { data } = await axios.post<MarkerResult>(`${VLM_BASE}/convert/pdf`, {
      pdf_b64: b64,
      force_ocr: options.forceOcr ?? false,
      extract_images: options.extractImages ?? false,
    });
    return data;
  } catch (err) {
    return handleAxiosError("convertPdfWithMarker", err);
  }
}

/**
 * Structured invoice extraction via olmOCR or Qwen2.5-VL.
 * Returns parsed JSON fields when the model supports it.
 */
export async function extractInvoiceStructured(
  imageInput: Buffer | string,
  options: {
    engine?: Extract<OcrEngine, "olmocr" | "qwen_vl">;
    systemPrompt?: string;
    userPrompt?: string;
    maxTokens?: number;
  } = {}
): Promise<OcrResult> {
  const b64 = toBase64(imageInput);
  try {
    const { data } = await axios.post<OcrResult>(`${VLM_BASE}/chat/vision`, {
      model: options.engine ?? "olmocr",
      image_b64: b64,
      system_prompt: options.systemPrompt,
      user_prompt:
        options.userPrompt ??
        "Extract all invoice fields as JSON: supplier, date, invoice_number, " +
          "line_items (description, qty, unit_price, total), subtotal, vat, grand_total.",
      max_tokens: options.maxTokens ?? 2048,
      temperature: 0.0,
    });
    return data;
  } catch (err) {
    return handleAxiosError("extractInvoiceStructured", err);
  }
}

// ─────────────────────────── layout + detection ──────────────────

export async function runLayoutAnalysis(
  imageInput: Buffer | string
): Promise<LayoutResult> {
  const b64 = toBase64(imageInput);
  try {
    const { data } = await axios.post<LayoutResult>(`${ENC_BASE}/encode`, {
      image_b64: b64,
    });
    return data;
  } catch (err) {
    return handleAxiosError("runLayoutAnalysis", err);
  }
}

export async function runObjectDetection(
  imageInput: Buffer | string
): Promise<DetectionResult> {
  const b64 = toBase64(imageInput);
  try {
    const { data } = await axios.post<DetectionResult>(`${DET_BASE}/detect`, {
      image_b64: b64,
    });
    return data;
  } catch (err) {
    return handleAxiosError("runObjectDetection", err);
  }
}

// ─────────────────────────── full orchestration ──────────────────

/**
 * Full invoice processing pipeline:
 *   1. OCR  (engine = "auto" by default)
 *   2. Layout analysis  (optional, default on)
 *   3. Object detection (optional, default on)
 *
 * For scanned Greek invoices the recommended call is:
 *   orchestrateInvoice(imageBuffer, { engine: "auto", language: "el" })
 */
export async function orchestrateInvoice(
  imageInput: Buffer | string,
  options: {
    engine?: OcrEngine;
    language?: string;
    withLayout?: boolean;
    withDetection?: boolean;
    prompt?: string;
  } = {}
): Promise<OrchestratorResult> {
  const {
    engine = "auto",
    language = "el",
    withLayout = true,
    withDetection = true,
    prompt,
  } = options;

  const b64 = toBase64(imageInput);

  // Run OCR + layout + detection in parallel where possible
  const [ocr, layout, detection] = await Promise.all([
    runOcr(b64, { engine, language, prompt }),
    withLayout
      ? runLayoutAnalysis(b64).catch(e => {
          console.warn("[layout]", e.message);
          return undefined;
        })
      : undefined,
    withDetection
      ? runObjectDetection(b64).catch(e => {
          console.warn("[detection]", e.message);
          return undefined;
        })
      : undefined,
  ]);

  return {
    ocr,
    layout,
    detection,
    pipeline: `ocr:${ocr.engine}${layout ? "+layout" : ""}${detection ? "+detection" : ""}`,
  };
}

// ─────────────────────────── model management ────────────────────

/** Preload a heavy model in the background (non-blocking). */
export async function preloadEngine(engine: OcrEngine): Promise<void> {
  try {
    await axios.post(`${VLM_BASE}/preload/${engine}`);
    console.log(`[vlmOrchestrator] Preload triggered: ${engine}`);
  } catch (err) {
    console.warn(
      `[vlmOrchestrator] Preload failed for ${engine}:`,
      (err as Error).message
    );
  }
}

/** List all models currently loaded in the VLM service and vLLM server. */
export async function getServiceStatus(): Promise<{
  vlm: Record<string, unknown>;
  vllm: Record<string, unknown>;
}> {
  const [vlm, vllm] = await Promise.allSettled([
    axios.get(`${VLM_BASE}/health`).then(r => r.data),
    axios.get(`${VLM_BASE}/models`).then(r => r.data),
  ]);
  return {
    vlm:
      vlm.status === "fulfilled"
        ? vlm.value
        : { error: (vlm as PromiseRejectedResult).reason?.message },
    vllm:
      vllm.status === "fulfilled"
        ? vllm.value
        : { error: (vllm as PromiseRejectedResult).reason?.message },
  };
}
