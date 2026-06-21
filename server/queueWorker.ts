/**
 * queueWorker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Background processing worker for the invoice queue.
 *
 * WHAT IT DOES
 *   Runs an in-process loop that continuously:
 *     1. Atomically claims the next 'queued' invoice (FOR UPDATE SKIP LOCKED).
 *     2. Runs the shared extraction pipeline (processInvoiceById).
 *     3. On success → the pipeline already set status completed/review_needed.
 *        On failure → re-queues for retry up to WORKER_MAX_RETRIES, then fails.
 *     4. Loops. When the queue is empty it idles (polls every WORKER_IDLE_MS).
 *
 *   This decouples extraction from the HTTP request: uploads return instantly
 *   (status='queued'), and the worker chews through the queue in the background.
 *   The user can close the browser / navigate / refresh and come back later to
 *   see progress — nothing is lost, because all state lives in MySQL.
 *
 * VLM WARM-UP HANDLING (host sleep / container restart)
 *   When Docker Desktop closes on idle and resumes, containers restart in place:
 *   the app is ready in seconds but the vlm service needs several minutes to
 *   reload its models. During that window the extraction pipeline throws a
 *   VlmNotReadyError (code "VLM_NOT_READY"). We treat that as a TRANSIENT defer,
 *   NOT a failure: the invoice is re-queued to the BACK of the queue WITHOUT
 *   counting a retry, so the worker moves on to the next invoice and keeps
 *   cycling until vlm is ready. This means an ~8-minute model reload never
 *   exhausts the retry cap and never marks an invoice 'failed'.
 *
 * CONCURRENCY
 *   Defaults to 1 (WORKER_CONCURRENCY=1) — correct for a CPU-only box where a
 *   single invoice already saturates the cores (e.g. LLAMA_N_THREADS=10 of 12).
 *   Running multiple heavy VLM jobs at once would be the SAME total time or
 *   slower, plus OOM risk. The knob exists for a future GPU/bigger box: raise it
 *   and N independent claim-loops run in parallel (SKIP LOCKED keeps them from
 *   grabbing the same invoice).
 *
 * SAFETY / RECOVERY
 *   On startup we sweep orphaned 'processing' rows (from a crash/restart or a
 *   browser-killed request under the old inline model) back into the queue via
 *   recoverOrphanedProcessing(). Jobs past the retry cap are failed, not looped.
 *
 * LIFECYCLE
 *   startQueueWorker() is called once from server/_core/index.ts after the HTTP
 *   server starts listening. It returns a handle with stop() for graceful
 *   shutdown. Safe to call once; guards against double-start.
 */

import {
    claimNextQueuedInvoice,
    setInvoiceProgress,
    requeueInvoice,
    requeueInvoiceNoPenalty,
    markInvoiceFailed,
    recoverOrphanedProcessing,
    getInvoiceById,
} from "./invoiceDb";
import { processInvoiceById } from "./invoiceProcessor";

// ── Tunables (env-overridable) ───────────────────────────────────────────────
const CONCURRENCY = Math.max(1, parseInt(process.env.WORKER_CONCURRENCY || "1", 10));
// How long a claim-loop sleeps when the queue is empty before polling again.
const IDLE_MS = Math.max(500, parseInt(process.env.WORKER_IDLE_MS || "2000", 10));
// Max attempts per invoice before it's marked 'failed' for good. The claim
// increments retryCount each time it's picked up, so this bounds the loop.
const MAX_RETRIES = Math.max(1, parseInt(process.env.WORKER_MAX_RETRIES || "3", 10));
// Small backoff before a re-queued (failed) invoice can be retried, so a
// persistently-failing job doesn't hot-loop. Applied by delaying the re-queue.
const RETRY_BACKOFF_MS = Math.max(0, parseInt(process.env.WORKER_RETRY_BACKOFF_MS || "5000", 10));
// Backoff before a VLM-warm-up DEFER is re-queued. Longer than RETRY_BACKOFF_MS
// because vlm cold-load takes minutes — no point hammering it every few seconds.
const VLM_WARMUP_BACKOFF_MS = Math.max(0, parseInt(process.env.WORKER_VLM_WARMUP_BACKOFF_MS || "30000", 10));

let started = false;
let running = false;
const loopHandles: Array<{ stop: () => void }> = [];

function log(msg: string) {
    console.log(`[QueueWorker] ${msg}`);
}

/** True if the error signals "VLM is not ready yet" (transient warm-up), which we
 *  defer rather than count as a failed attempt. Matches both the typed error
 *  (code/name) and the message text, so it works regardless of how the error
 *  crossed module boundaries. */
function isVlmNotReady(err: any): boolean {
    if (!err) return false;
    if (err.code === "VLM_NOT_READY" || err.name === "VlmNotReadyError") return true;
    const m = String(err.message ?? err);
    return /SLM service (is not available|did not become ready)|VLM_NOT_READY/i.test(m);
}

/**
 * One claim-and-process cycle. Returns true if it processed (or attempted) an
 * invoice, false if the queue was empty (caller should idle).
 */
async function processOne(workerLabel: string): Promise<boolean> {
    let claim: { id: number; userId: number } | null = null;
    try {
        claim = await claimNextQueuedInvoice();
    } catch (err: any) {
        log(`${workerLabel} claim error: ${err?.message ?? err}`);
        return false; // treat as empty; back off
    }

    if (!claim) return false; // queue empty

    const { id, userId } = claim;
    log(`${workerLabel} claimed invoice #${id} (user ${userId})`);

    try {
        // Run the shared pipeline. Progress strings are persisted to the DB so the
        // UI shows live movement. The pipeline sets the final success status
        // (completed / review_needed) itself.
        const result = await processInvoiceById(id, userId, async (message) => {
            await setInvoiceProgress(id, message);
        });
        log(`${workerLabel} invoice #${id} → ${result.finalStatus} (engine: ${result.engine ?? "?"})`);
        return true;
    } catch (err: any) {
        const message = err?.message ?? String(err);

        // ── VLM still warming up → DEFER, don't fail ─────────────────────────
        // Re-queue to the BACK of the queue WITHOUT counting a retry, so a
        // multi-minute vlm model reload (e.g. after host sleep) never exhausts
        // the retry cap. The worker returns and immediately tries the next
        // invoice; this one comes back around after VLM_WARMUP_BACKOFF_MS.
        if (isVlmNotReady(err)) {
            log(`${workerLabel} invoice #${id} deferred — VLM warming up; re-queuing (no retry penalty) in ${VLM_WARMUP_BACKOFF_MS}ms`);
            if (VLM_WARMUP_BACKOFF_MS > 0) {
                await new Promise(r => setTimeout(r, VLM_WARMUP_BACKOFF_MS));
            }
            try {
                await requeueInvoiceNoPenalty(id);
            } catch (e: any) {
                log(`${workerLabel} no-penalty re-queue failed for #${id}: ${e?.message ?? e}`);
                // Fall back to a normal re-queue so the invoice isn't stranded in 'processing'.
                try { await requeueInvoice(id); } catch { await markInvoiceFailed(id, message).catch(() => {}); }
            }
            return true;
        }

        // ── Genuine failure → existing retry/fail path ───────────────────────
        log(`${workerLabel} invoice #${id} FAILED: ${message}`);

        // Retry bookkeeping: claimNextQueuedInvoice already incremented retryCount
        // when it claimed this row. Read the current count to decide retry vs fail.
        let retryCount = MAX_RETRIES;
        try {
            const inv = await getInvoiceById(id);
            retryCount = Number((inv as any)?.retryCount ?? MAX_RETRIES);
        } catch { /* fall through to fail */ }

        if (retryCount < MAX_RETRIES) {
            // Re-queue for another attempt after a short backoff.
            log(`${workerLabel} invoice #${id} will retry (attempt ${retryCount}/${MAX_RETRIES}) in ${RETRY_BACKOFF_MS}ms`);
            if (RETRY_BACKOFF_MS > 0) {
                await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
            }
            try { await requeueInvoice(id); } catch (e: any) {
                log(`${workerLabel} re-queue failed for #${id}: ${e?.message ?? e}`);
                await markInvoiceFailed(id, message).catch(() => {});
            }
        } else {
            // Exhausted retries → final failure.
            log(`${workerLabel} invoice #${id} exhausted ${MAX_RETRIES} retries → failed`);
            await markInvoiceFailed(id, message).catch(() => {});
        }
        return true;
    }
}

/**
 * A single claim-loop. We run CONCURRENCY of these in parallel. Each loops
 * forever (until stopped): process one if available, otherwise idle.
 */
function startLoop(workerLabel: string) {
    let stopped = false;
    const tick = async () => {
        while (!stopped) {
            let didWork = false;
            try {
                didWork = await processOne(workerLabel);
            } catch (err: any) {
                log(`${workerLabel} unexpected loop error: ${err?.message ?? err}`);
            }
            if (!didWork) {
                // Queue empty (or transient error) → idle before polling again.
                await new Promise(r => setTimeout(r, IDLE_MS));
            }
        }
        log(`${workerLabel} stopped`);
    };
    // Kick it off (don't await — it runs for the process lifetime).
    void tick();
    return { stop: () => { stopped = true; } };
}

/**
 * Start the background worker. Call ONCE on server boot (after listen()).
 * Returns a handle with stop() for graceful shutdown.
 */
export async function startQueueWorker(): Promise<{ stop: () => void }> {
    if (started) {
        log("Already started — ignoring duplicate startQueueWorker()");
        return { stop: stopQueueWorker };
    }
    started = true;
    running = true;

    // ── Startup recovery: rescue invoices stranded mid-processing ──
    try {
        const { requeued, failed } = await recoverOrphanedProcessing(MAX_RETRIES);
        if (requeued || failed) {
            log(`Startup recovery: re-queued ${requeued}, failed ${failed} orphaned 'processing' invoice(s)`);
        } else {
            log("Startup recovery: no orphaned invoices");
        }
    } catch (err: any) {
        log(`Startup recovery error (non-fatal): ${err?.message ?? err}`);
    }

    log(`Starting ${CONCURRENCY} worker loop(s) — idle ${IDLE_MS}ms, maxRetries ${MAX_RETRIES}`);
    for (let i = 0; i < CONCURRENCY; i++) {
        loopHandles.push(startLoop(`w${i + 1}`));
    }

    return { stop: stopQueueWorker };
}

/** Stop all worker loops (graceful shutdown). */
export function stopQueueWorker() {
    if (!running) return;
    running = false;
    log("Stopping worker loops…");
    for (const h of loopHandles) h.stop();
    loopHandles.length = 0;
}