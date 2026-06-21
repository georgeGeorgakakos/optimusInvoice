/**
 * Native Node.js PDF Text Extraction + OCR
 *
 * Zero native/system dependencies — pure WASM:
 *   pnpm add pdfjs-dist mupdf tesseract.js
 *
 * Pipeline:
 *   1. pdfjs-dist → text extraction (fast, for text-based PDFs)
 *   2. If scanned → mupdf (WASM, renders pages to PNG) + tesseract.js (WASM OCR)
 */

import path from "path";
import fs from "fs/promises";
import os from "os";

export interface OcrResult {
  text: string;
  method: "pdfjs" | "ocr" | "failed";
  pages: number;
  confidence: number;
}

// ── OCR language config ──
// Greek + English for mixed-language invoices (Τιμολόγιο, Δελτίο Αποστολής, etc.)
const OCR_LANGUAGES = "eng+ell";

/**
 * Extract text from PDF — tries pdfjs-dist first, falls back to OCR.
 */
export async function extractTextFromPdf(
  pdfPath: string,
  maxPages = 10
): Promise<OcrResult> {
  // ── Step 1: pdfjs-dist text extraction (fast for text-based PDFs) ──
  try {
    const pdfjsText = await extractWithPdfjs(pdfPath, maxPages);
    if (pdfjsText.trim().length > 50) {
      console.log(
        `[OCR] pdfjs-dist extracted ${pdfjsText.length} chars — text-based PDF`
      );
      return {
        text: pdfjsText,
        method: "pdfjs",
        pages: maxPages,
        confidence: 100,
      };
    }
    console.log(
      `[OCR] pdfjs-dist got only ${pdfjsText.trim().length} chars — scanned PDF, starting OCR...`
    );
  } catch (err: any) {
    console.log(`[OCR] pdfjs-dist failed: ${err.message} — trying OCR...`);
  }

  // ── Step 2: mupdf + tesseract.js OCR ──
  try {
    return await ocrScannedPdf(pdfPath, maxPages);
  } catch (err: any) {
    console.error(`[OCR] OCR failed:`, err.message);
    return { text: "", method: "failed", pages: 0, confidence: 0 };
  }
}

/**
 * Text extraction using pdfjs-dist (Mozilla PDF.js)
 */
async function extractWithPdfjs(
  pdfPath: string,
  maxPages: number
): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(await fs.readFile(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true })
    .promise;

  let fullText = "";
  const pagesToProcess = Math.min(doc.numPages, maxPages);

  for (let i = 1; i <= pagesToProcess; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .filter((item: any) => item.str !== undefined)
      .map((item: any) => item.str)
      .join(" ");
    fullText += pageText + "\n";
  }

  doc.destroy();
  return fullText;
}

/**
 * OCR scanned PDFs using mupdf (WASM) + tesseract.js (WASM)
 *
 * Optimizations for Greek invoices:
 *   - Render at 300 DPI for scanned text in tables
 *   - RGB for better contrast on colored scans
 *   - Greek + English language model (eng+ell)
 *   - Dual-pass: PSM 3 (auto) + PSM 6 (table blocks)
 */
async function ocrScannedPdf(
  pdfPath: string,
  maxPages: number
): Promise<OcrResult> {
  let mupdf: any;
  try {
    mupdf = await import("mupdf");
  } catch {
    throw new Error("mupdf not installed. Run: pnpm add mupdf");
  }

  let Tesseract: any;
  try {
    Tesseract = await import("tesseract.js");
  } catch {
    throw new Error("tesseract.js not installed. Run: pnpm add tesseract.js");
  }

  console.log(`[OCR] Rendering PDF pages with mupdf (WASM) at 300 DPI...`);
  const pdfBuffer = await fs.readFile(pdfPath);

  const doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");
  const pageCount = Math.min(doc.countPages(), maxPages);

  // Render all pages to PNG at 300 DPI RGB (best for OCR on colored scanned invoices)
  const pngPaths: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    // 300 DPI — optimal for scanned invoices (higher DPI reduces accuracy)
    const scaleFactor = 300 / 72;
    const matrix = mupdf.Matrix.scale(scaleFactor, scaleFactor);
    // RGB preserves color contrast better than grayscale for scanned docs
    const pixmap = page.toPixmap(
      matrix,
      mupdf.ColorSpace.DeviceRGB,
      false,
      true
    );
    const png = pixmap.asPNG();
    const pngPath = path.join(os.tmpdir(), `ocr_${Date.now()}_p${i + 1}.png`);
    await fs.writeFile(pngPath, Buffer.from(png));
    pngPaths.push(pngPath);
    console.log(
      `[OCR] Rendered page ${i + 1} (${png.byteLength} bytes, 300dpi RGB)`
    );
  }

  // ── OCR with tesseract.js — dual-pass for best results ──
  // Pass 1 (PSM 3): High confidence text, good number formatting
  // Pass 2 (PSM 6): Better table structure, more items found
  console.log(
    `[OCR] Starting tesseract.js OCR (${OCR_LANGUAGES}, dual-pass)...`
  );
  const createWorker =
    Tesseract.createWorker ?? Tesseract.default?.createWorker;

  // --- Pass 1: PSM 3 (auto segmentation — best for text quality) ---
  const worker1 = await createWorker(OCR_LANGUAGES, undefined, {
    logger: () => {},
  });
  await worker1.setParameters({
    tessedit_pageseg_mode: "3",
    preserve_interword_spaces: "1",
  });

  let fullText = "";
  let totalConfidence = 0;
  let processedPages = 0;

  try {
    for (let i = 0; i < pngPaths.length; i++) {
      try {
        console.log(`[OCR] Pass 1 (PSM 3) page ${i + 1}...`);
        const { data } = await worker1.recognize(pngPaths[i]);
        fullText += `\n--- PAGE ${i + 1} ---\n` + data.text;
        totalConfidence += data.confidence;
        processedPages++;
        console.log(
          `[OCR] Page ${i + 1}: ${data.text.length} chars, ${Math.round(data.confidence)}% confidence`
        );
      } catch (err: any) {
        console.log(`[OCR] Page ${i + 1} failed: ${err.message}`);
      }
    }
  } finally {
    await worker1.terminate();
  }

  // --- Pass 2: PSM 6 (uniform block — preserves table columns) ---
  const worker2 = await createWorker(OCR_LANGUAGES, undefined, {
    logger: () => {},
  });
  await worker2.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1",
  });

  let pass2Text = "";
  try {
    for (let i = 0; i < pngPaths.length; i++) {
      try {
        console.log(`[OCR] Pass 2 (PSM 6) page ${i + 1}...`);
        const { data } = await worker2.recognize(pngPaths[i]);
        pass2Text += `\n--- PAGE ${i + 1} ---\n` + data.text;
        console.log(
          `[OCR] Page ${i + 1}: ${data.text.length} chars, ${Math.round(data.confidence)}% confidence`
        );
      } catch (err: any) {
        console.log(`[OCR] Page ${i + 1} PSM6 failed: ${err.message}`);
      }
    }
  } finally {
    await worker2.terminate();
  }

  // Merge: PSM 3 text first (quality), then PSM 6 (table coverage) separated by marker
  fullText += "\n\n=== PSM6_TABLE_PASS ===\n" + pass2Text;

  // Clean up PNGs
  for (const p of pngPaths) {
    await fs.unlink(p).catch(() => {});
  }

  const avgConfidence =
    processedPages > 0 ? totalConfidence / processedPages : 0;
  console.log(
    `[OCR] Complete: ${fullText.length} chars from ${processedPages} pages (${Math.round(avgConfidence)}% avg confidence)`
  );

  return {
    text: fullText,
    method: "ocr",
    pages: processedPages,
    confidence: avgConfidence,
  };
}

/**
 * Save OCR text for Python extractors to read via --ocr-text
 */
export async function saveOcrText(
  pdfPath: string,
  text: string
): Promise<string> {
  const textPath = pdfPath.replace(/\.pdf$/i, ".ocr.txt");
  await fs.writeFile(textPath, text, "utf-8");
  return textPath;
}
