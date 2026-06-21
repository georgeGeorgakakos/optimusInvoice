/**
 * extractionExporter.ts
 *
 * Persistent JSON exporter for finalised invoice extractions.
 *
 * What it does
 * ────────────
 *  When an invoice extraction completes successfully (routers.ts hooks), this
 *  module writes the full structured `extractedData` JSON to disk at:
 *
 *      <EXTRACTIONS_DIR>/<YYYY-MM-DD>/<clientNameSanitized>/<invoiceNumber>_<HHmmss>.json
 *
 *  Example:
 *      ./extractions/2026-06-01/Ferryscanner_com_EOOD/FI454831_142305.json
 *
 *  The clientName segment is derived from the recipient (or sender for outgoing
 *  invoices) and run through `transliterateForFs()` so Windows / Linux / macOS
 *  filesystems can all handle it safely (no Greek chars, no spaces, no slashes).
 *
 *  The "<HHmmss>" suffix guarantees uniqueness: re-processing the same invoice
 *  never overwrites a previous run — useful for audit and for comparing how
 *  different engines extracted the same source PDF.
 *
 * Storage location
 * ────────────────
 *  Configurable via the `EXTRACTIONS_DIR` env variable; defaults to
 *  `./extractions/` (sibling of `./uploads/`). Absolute paths are honoured if
 *  someone wants to mount a network share.
 *
 * Safety
 * ──────
 *  - Writes go through a `.tmp` file + `fs.rename()` to make them atomic.
 *    Even if the process is killed mid-write, the destination JSON never
 *    contains a half-written payload.
 *  - All path components are sanitized to remove `/`, `\`, `..`, control chars,
 *    and anything else that could break out of the EXTRACTIONS_DIR root.
 *  - Read operations always re-validate that the resolved absolute path is
 *    still under EXTRACTIONS_DIR — defence in depth against path traversal
 *    even though sanitization should prevent it upstream.
 *
 * Used by
 * ───────
 *  - routers.ts → invoices.processWithVlm (auto on successful finalize)
 *  - routers.ts → extractions.* (list / get / delete / reexport endpoints)
 */

import fs from "fs/promises";
import path from "path";

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Resolves the configured extractions root directory.
 * Defaults to `./extractions/` relative to the process CWD if EXTRACTIONS_DIR
 * is not set. Returns an absolute path so subsequent path operations are
 * unambiguous.
 */
function getExtractionsRoot(): string {
    const configured = process.env.EXTRACTIONS_DIR || "./extractions";
    return path.resolve(configured);
}

// ── Sanitization helpers ──────────────────────────────────────────────────────

/**
 * Greek-to-Latin transliteration map. Covers uppercase + lowercase + accented
 * variants. Anything not in this map (e.g. Cyrillic, Arabic) falls through to
 * the generic non-ASCII strip in `transliterateForFs()`.
 */
const GREEK_TO_LATIN: Record<string, string> = {
    // Uppercase
    "Α": "A", "Β": "B", "Γ": "G", "Δ": "D", "Ε": "E", "Ζ": "Z", "Η": "I",
    "Θ": "Th", "Ι": "I", "Κ": "K", "Λ": "L", "Μ": "M", "Ν": "N", "Ξ": "X",
    "Ο": "O", "Π": "P", "Ρ": "R", "Σ": "S", "Τ": "T", "Υ": "Y", "Φ": "F",
    "Χ": "Ch", "Ψ": "Ps", "Ω": "O",
    // Lowercase
    "α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i",
    "θ": "th", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x",
    "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y",
    "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o",
    // Accented vowels (tonos)
    "Ά": "A", "Έ": "E", "Ή": "I", "Ί": "I", "Ό": "O", "Ύ": "Y", "Ώ": "O",
    "ά": "a", "έ": "e", "ή": "i", "ί": "i", "ό": "o", "ύ": "y", "ώ": "o",
    // Diaeresis
    "Ϊ": "I", "Ϋ": "Y", "ϊ": "i", "ϋ": "y", "ΐ": "i", "ΰ": "y",
};

/**
 * Convert a free-form string (typically a company name) into a filesystem-safe
 * segment. Pipeline:
 *   1. Transliterate Greek → Latin
 *   2. Strip any remaining non-ASCII
 *   3. Replace runs of unsafe chars with single underscore
 *   4. Trim leading/trailing underscores + dots
 *   5. Cap at 80 chars (sane max filename length, leaves room for suffixes)
 *
 * Examples:
 *   "Ferryscanner.com EOOD"        → "Ferryscanner_com_EOOD"
 *   "ΑΒΓ Α.Ε."                     → "ABG_A_E"
 *   "Müller Söhne GmbH"            → "Muller_Sohne_GmbH"
 *   "../../etc/passwd"             → "etc_passwd"   (.. and / stripped)
 *   ""                             → "_unknown_"
 */
export function transliterateForFs(input: string | null | undefined): string {
    if (!input || typeof input !== "string") return "_unknown_";

    // 1. Transliterate Greek + decompose Latin diacritics
    let s = "";
    for (const ch of input) {
        if (GREEK_TO_LATIN[ch]) {
            s += GREEK_TO_LATIN[ch];
        } else {
            // Use NFD decomposition to strip combining diacritics (umlauts, accents)
            const decomposed = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            s += decomposed;
        }
    }

    // 2. Strip remaining non-ASCII (anything that didn't transliterate)
    s = s.replace(/[^\x20-\x7E]/g, "");

    // 3. Replace unsafe chars with underscore. We keep [A-Za-z0-9._-] which
    //    is the conservative POSIX portable filename charset.
    s = s.replace(/[^A-Za-z0-9._-]+/g, "_");

    // 4. Collapse repeating underscores, strip leading/trailing _ and dots
    s = s.replace(/_+/g, "_").replace(/^[_.]+|[_.]+$/g, "");

    // 5. Cap length
    if (s.length > 80) s = s.substring(0, 80);

    return s || "_unknown_";
}

/**
 * Resolve client display name from extracted data. For incoming invoices
 * (typical case), the client is the *recipient*. For outgoing invoices (the
 * iKnowHow company invoicing someone else), the client is the *issuer*.
 *
 * We try multiple fallbacks because different engines populate different
 * fields:
 *   - issuer.name             (modern nested shape)
 *   - sender.name             (older shape, used by dispatch_note)
 *   - supplierName            (regex parser legacy)
 *   - recipient.name          (when issuer is missing — outgoing)
 *   - customerName            (legacy outgoing)
 */
function pickClientName(extractedData: any): string {
    const candidates = [
        extractedData?.issuer?.name,
        extractedData?.sender?.name,
        extractedData?.supplierName,
        extractedData?.recipient?.name,
        extractedData?.customerName,
    ];
    for (const c of candidates) {
        if (typeof c === "string" && c.trim().length > 0) {
            return c.trim();
        }
    }
    return "_unknown_";
}

/**
 * Format the invoice number safely for use as a filename. Falls back to the
 * DB invoice ID if no extracted invoice number is available.
 */
function pickInvoiceNumber(extractedData: any, invoiceId: number): string {
    const num =
        extractedData?.invoiceNumber ??
        extractedData?.documentNumber ??
        extractedData?.cmrNumber ??
        null;
    if (typeof num === "string" && num.trim().length > 0) {
        return transliterateForFs(num);
    }
    return `invoice_${invoiceId}`;
}

/**
 * Pick a date string to use as the date folder. Prefers the actual invoice
 * date (so re-processing today an invoice from 2024 puts it under 2024-XX),
 * falls back to today's date.
 *
 * Returns YYYY-MM-DD. If we can't parse the invoice date, returns today's
 * date in the server's local timezone.
 */
function pickDateFolder(extractedData: any): string {
    const raw =
        extractedData?.invoiceDate ??
        extractedData?.date ??
        null;

    if (raw) {
        // Already in YYYY-MM-DD form?
        if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
            return raw.substring(0, 10);
        }
        // Try parsing — Date constructor is liberal but unpredictable; we accept
        // anything that returns a valid Date object.
        const parsed = new Date(raw);
        if (!isNaN(parsed.getTime())) {
            return parsed.toISOString().substring(0, 10);
        }
    }

    // Fallback: today
    return new Date().toISOString().substring(0, 10);
}

/**
 * Format HHmmss in the server's local time for the filename suffix.
 * Used to disambiguate multiple runs of the same invoice on the same day.
 */
function timeSuffix(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Result of pre-computing the target path. We expose it so callers (routers)
 * can record the path in the DB if they wish (e.g. an `extractionJsonPath`
 * column added later).
 */
export interface ExtractionTarget {
    /** Absolute path of the destination JSON file. */
    filePath: string;
    /** Path components for breadcrumbs / UI display, relative to the root. */
    dateFolder: string;
    clientFolder: string;
    fileName: string;
}

/**
 * Compute (but don't create) the target file path for an extraction.
 * Pure function — does not touch the filesystem.
 */
export function resolveTarget(
    extractedData: any,
    invoiceId: number,
): ExtractionTarget {
    const dateFolder   = pickDateFolder(extractedData);
    const clientFolder = transliterateForFs(pickClientName(extractedData));
    const invoiceNum   = pickInvoiceNumber(extractedData, invoiceId);
    const fileName     = `${invoiceNum}_${timeSuffix()}.json`;

    const filePath = path.join(getExtractionsRoot(), dateFolder, clientFolder, fileName);
    return { filePath, dateFolder, clientFolder, fileName };
}

/**
 * Validate that `absPath` is still inside the extractions root after resolution.
 * Defence-in-depth against any path-traversal we might have missed.
 * Throws an Error if the check fails.
 */
function assertInsideRoot(absPath: string): void {
    const root = getExtractionsRoot();
    const resolved = path.resolve(absPath);
    // path.relative returns a string starting with ".." if `resolved` is outside `root`
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(
            `[extractionExporter] Path traversal blocked: ${resolved} is not inside ${root}`
        );
    }
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Wrapper that bundles the raw extractedData with some metadata, so the saved
 * JSON has more value than just the model output: who triggered it, when,
 * which engine was used, and the source invoice ID in our DB.
 */
interface ExportEnvelope {
    meta: {
        invoiceId:      number;
        userId:         number;
        exportedAt:     string; // ISO 8601
        engine?:        string | null;
        extractionMethod?: string | null;
    };
    data: any;
}

/**
 * Atomically write the extraction JSON to disk. Creates parent directories as
 * needed. Returns the full ExtractionTarget so callers can log the path.
 *
 * Errors are logged but NOT re-thrown — JSON export is a non-critical
 * side-effect, and we don't want to fail the entire invoice processing flow
 * if the disk is full or the directory is read-only. Callers should treat
 * the returned Promise as fire-and-forget if they want.
 */
export async function writeExtraction(
    extractedData: any,
    invoiceId: number,
    userId: number,
    opts: { engine?: string | null; extractionMethod?: string | null } = {},
): Promise<ExtractionTarget | null> {
    try {
        const target = resolveTarget(extractedData, invoiceId);

        // Defence in depth: verify the resolved path is inside our root.
        assertInsideRoot(target.filePath);

        // Ensure parent dirs exist
        await fs.mkdir(path.dirname(target.filePath), { recursive: true });

        // Build the envelope
        const envelope: ExportEnvelope = {
            meta: {
                invoiceId,
                userId,
                exportedAt: new Date().toISOString(),
                engine: opts.engine ?? null,
                extractionMethod: opts.extractionMethod ?? null,
            },
            data: extractedData,
        };

        // Atomic write: write to .tmp then rename
        const tmpPath = `${target.filePath}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(envelope, null, 2), "utf-8");
        await fs.rename(tmpPath, target.filePath);

        console.log(
            `[extractionExporter] Saved extraction for invoice #${invoiceId} → ${target.filePath}`
        );
        return target;
    } catch (err: any) {
        console.error(
            `[extractionExporter] Failed to write extraction for invoice #${invoiceId}: ${err.message}`
        );
        return null;
    }
}

// ── Read / List ──────────────────────────────────────────────────────────────

export interface ExtractionFileInfo {
    /** Full path relative to the extractions root, with forward slashes for UI use. */
    relativePath: string;
    /** Date folder (YYYY-MM-DD) — first segment. */
    date: string;
    /** Client folder (sanitized name) — second segment. */
    client: string;
    /** File name — leaf. */
    fileName: string;
    /** Size in bytes. */
    sizeBytes: number;
    /** Modification time as ISO string. */
    modifiedAt: string;
}

/**
 * List all extraction files under the root, grouped by date then by client.
 * Walks at most 3 levels deep (date → client → files), so it's bounded and
 * cheap even with thousands of extractions.
 *
 * Returns files sorted: dates desc (newest first), clients asc within date,
 * files desc within client (newest first).
 *
 * If the extractions dir doesn't exist yet (first run), returns an empty list
 * — no error.
 */
export async function listExtractions(): Promise<ExtractionFileInfo[]> {
    const root = getExtractionsRoot();
    const results: ExtractionFileInfo[] = [];

    let dateDirs: string[];
    try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        dateDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch (err: any) {
        if (err.code === "ENOENT") return []; // root doesn't exist yet
        throw err;
    }

    // Sort dates desc (newest first), tolerating non-date dirs by leaving them at the end
    dateDirs.sort((a, b) => b.localeCompare(a));

    for (const dateDir of dateDirs) {
        const dateAbs = path.join(root, dateDir);
        let clientDirs: string[];
        try {
            const entries = await fs.readdir(dateAbs, { withFileTypes: true });
            clientDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
        } catch {
            continue;
        }
        clientDirs.sort((a, b) => a.localeCompare(b));

        for (const clientDir of clientDirs) {
            const clientAbs = path.join(dateAbs, clientDir);
            let files: string[];
            try {
                const entries = await fs.readdir(clientAbs, { withFileTypes: true });
                files = entries
                    .filter(e => e.isFile() && e.name.endsWith(".json"))
                    .map(e => e.name);
            } catch {
                continue;
            }
            files.sort((a, b) => b.localeCompare(a)); // newest first by timestamp suffix

            for (const fileName of files) {
                const abs = path.join(clientAbs, fileName);
                try {
                    const stat = await fs.stat(abs);
                    results.push({
                        relativePath: [dateDir, clientDir, fileName].join("/"),
                        date: dateDir,
                        client: clientDir,
                        fileName,
                        sizeBytes: stat.size,
                        modifiedAt: stat.mtime.toISOString(),
                    });
                } catch {
                    // Skip files we can't stat (race condition with delete, etc.)
                }
            }
        }
    }

    return results;
}

/**
 * Read a single extraction JSON file by its relative path (the form returned
 * by `listExtractions()`). Validates the resolved path stays inside the root
 * before reading.
 *
 * Returns the parsed JSON envelope (with meta + data), or null if not found.
 */
export async function readExtraction(
    relativePath: string,
): Promise<ExportEnvelope | null> {
    // Normalize the input — disallow absolute paths, backslashes, ..
    // We use forward slashes in our list output, but be defensive.
    const safe = relativePath.replace(/\\/g, "/");
    if (safe.includes("..") || path.isAbsolute(safe)) {
        throw new Error(`[extractionExporter] Invalid relative path: ${relativePath}`);
    }

    const abs = path.join(getExtractionsRoot(), safe);
    assertInsideRoot(abs);

    try {
        const text = await fs.readFile(abs, "utf-8");
        return JSON.parse(text) as ExportEnvelope;
    } catch (err: any) {
        if (err.code === "ENOENT") return null;
        throw err;
    }
}

/**
 * Delete a single extraction JSON file. Returns true if deleted, false if it
 * didn't exist. Used by the manual "delete" button in the Extractions UI.
 *
 * Also cleans up empty parent directories afterwards so the tree doesn't fill
 * up with orphan folders.
 */
export async function deleteExtraction(relativePath: string): Promise<boolean> {
    const safe = relativePath.replace(/\\/g, "/");
    if (safe.includes("..") || path.isAbsolute(safe)) {
        throw new Error(`[extractionExporter] Invalid relative path: ${relativePath}`);
    }
    const abs = path.join(getExtractionsRoot(), safe);
    assertInsideRoot(abs);

    try {
        await fs.unlink(abs);
    } catch (err: any) {
        if (err.code === "ENOENT") return false;
        throw err;
    }

    // Cleanup empty parents (client dir, then date dir if also empty)
    const clientDir = path.dirname(abs);
    const dateDir   = path.dirname(clientDir);
    for (const dir of [clientDir, dateDir]) {
        try {
            const entries = await fs.readdir(dir);
            if (entries.length === 0) {
                await fs.rmdir(dir);
            } else {
                break; // not empty — stop pruning
            }
        } catch {
            break;
        }
    }

    return true;
}