/**
 * invoiceProcessor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SHARED extraction pipeline for a single invoice.
 *
 * WHY THIS MODULE EXISTS
 *   The extraction logic used to live INSIDE the `invoices.process` tRPC
 *   mutation in routers.ts. That coupled the (2–90 min on CPU) extraction to the
 *   HTTP request lifecycle: if the user closed the browser or navigated away, the
 *   in-flight request was abandoned and the invoice was stranded at
 *   status='processing' forever, losing all the work.
 *
 *   To support a persistent processing QUEUE (work survives navigation/refresh,
 *   batch processing, live status for a returning user), the extraction had to be
 *   decoupled from the request. So the exact same logic now lives here as a
 *   plain async function that the BACKGROUND WORKER calls (server/queueWorker.ts).
 *   The router's `process` mutation becomes a thin "enqueue" that returns
 *   immediately.
 *
 *   This is a faithful move of the original logic — same engine selection, same
 *   document-type branches (cmr / dispatch_note / invoice|credit_note), same
 *   line-item creation + ML matching + auto-accept, same notifications, same
 *   on-disk extraction export, same OptimusDB auto-push. The ONLY additions are:
 *     • an optional onProgress() callback so the worker can persist live progress
 *       strings the UI shows ("OCR page 2/5", "Matching line items", …)
 *     • it records which engine ran (invoices.engine column)
 *     • it returns a structured result instead of being a mutation resolver
 *
 * USED BY
 *   • server/queueWorker.ts  → the background worker (primary caller)
 *   • server/routers.ts      → re-exports tryPushToOptimusDb; `process` enqueues
 */

import {
    writeExtraction,
} from "./extractionExporter";

// ─────────────────────────────────────────────────────────────────────────────
// Progress callback type. The worker passes a function that writes the string to
// invoices.progress so the UI can show live movement. In contexts without a
// worker (e.g. a direct synchronous call), onProgress can be omitted (no-op).
// ─────────────────────────────────────────────────────────────────────────────
export type ProgressFn = (message: string) => void | Promise<void>;

export interface ProcessResult {
    success: boolean;
    documentType: string;
    /** Final status the invoice landed on: 'completed' | 'review_needed'. */
    finalStatus: "completed" | "review_needed";
    /** The engine that actually ran (surya | qwen_vl_local | gemma_vl_local | undefined). */
    engine?: string;
    extractedData: any;
    lineItems?: any[];
}

// ── Helper: Auto-push completed invoice to OptimusDB (non-blocking) ──
// MOVED verbatim from routers.ts so both the worker and the router share ONE
// copy. routers.ts now imports this from here (re-exported) instead of defining
// its own. Behaviour is unchanged: best-effort, never throws into the caller.
export async function tryPushToOptimusDb(invoiceId: number, userId: number) {
    try {
        const { getInvoiceById, getLineItemsByInvoiceId, getUserConfiguration } =
            await import("./invoiceDb");
        const config = await getUserConfiguration(userId);
        if (!config?.settingsJson) return;

        let settings: any = {};
        try {
            settings = JSON.parse(config.settingsJson);
        } catch {
            return;
        }
        if (!settings.optimusDbApiUrl || !settings.optimusDbEnabled) return;

        const { createOptimusDbClient, buildInvoiceMetadata } = await import(
            "./optimusDbClient"
            );
        const client = createOptimusDbClient({
            apiUrl: settings.optimusDbApiUrl,
            authToken: settings.optimusDbAuthToken,
            catalogName: settings.optimusDbCatalog || "invoices",
            nodeId: settings.optimusDbNodeId,
        });

        const invoice = await getInvoiceById(invoiceId);
        if (!invoice) return;

        const lineItems = await getLineItemsByInvoiceId(invoiceId);
        let extractedData: any = {};
        try {
            extractedData = JSON.parse(invoice.extractedData || "{}");
        } catch {}

        const metadata = buildInvoiceMetadata(invoice, extractedData, lineItems, {
            name: extractedData?.supplier?.name,
            taxId: extractedData?.supplier?.taxId,
        });

        const result = await client.pushInvoice(metadata);
        if (result.success) {
            console.log(
                `[OptimusDB] Auto-pushed invoice #${invoiceId} → entry ${result.entryId}`
            );
        } else {
            console.warn(
                `[OptimusDB] Auto-push failed for #${invoiceId}: ${result.error}`
            );
        }
    } catch (err: any) {
        console.warn(
            `[OptimusDB] Auto-push error for #${invoiceId}: ${err.message}`
        );
    }
}

/**
 * Process ONE invoice end-to-end: classify → extract → persist → match → notify.
 *
 * This contains the full pipeline previously inside the `invoices.process`
 * mutation. It updates invoices.status itself (processing → completed/
 * review_needed) and, on throw, the CALLER (worker) is responsible for marking
 * the invoice failed + retry bookkeeping — EXCEPT we still write the failure
 * notification here to match original behaviour. We re-throw so the worker can
 * record the error + decide on retry.
 *
 * @param invoiceId  the invoice to process
 * @param userId     owner (used for config lookup, notifications, OptimusDB)
 * @param onProgress optional live-progress sink (worker persists to DB)
 */
export async function processInvoiceById(
    invoiceId: number,
    userId: number,
    onProgress?: ProgressFn,
): Promise<ProcessResult> {
    const report = async (msg: string) => {
        try { if (onProgress) await onProgress(msg); } catch { /* progress is best-effort */ }
    };
    // Emit a structured step into the live ProcessingTimeline (best-effort).
    const step = async (
        stage: string,
        status: "running" | "done" | "skipped" | "error",
        extra: { engine?: string; path?: "a" | "b"; reasoning?: string } = {},
    ) => {
        try {
            await appendInvoiceStep(invoiceId, {
                stage, status, at: new Date().toISOString(), ...extra,
            });
        } catch { /* timeline is best-effort */ }
    };

    const {
        getInvoiceById,
        updateInvoiceStatus,
        updateInvoiceExtractedData,
        createInvoiceLineItem,
        deleteLineItemsByInvoiceId,
        getUserConfiguration,
        updateLineItemMatch,
        updateInvoiceDocumentType,
        setInvoiceEngine,          // NEW (records which engine ran)
        appendInvoiceStep,         // NEW (live processing timeline)
        resetInvoiceSteps,         // NEW (clears timeline at run start)
    } = await import("./invoiceDb");
    const { classifyAndExtract, matchProduct } = await import(
        "./python-integration"
        );

    const invoice = await getInvoiceById(invoiceId);
    if (!invoice || invoice.userId !== userId) {
        throw new Error("Invoice not found");
    }

    try {
        await updateInvoiceStatus(invoiceId, "processing");
        await report("Starting extraction");
        await resetInvoiceSteps(invoiceId);
        await step("Queue claim", "done", { reasoning: "Worker claimed invoice, status → processing" });
        await deleteLineItemsByInvoiceId(invoiceId);

        // ── Read engine + extraction preferences from user config ──────
        let engineToUse: string | undefined = undefined;
        let useNativeText = false;
        try {
            const userCfg = await getUserConfiguration(userId);
            if (userCfg?.settingsJson) {
                const cfgSettings = JSON.parse(userCfg.settingsJson);
                if (cfgSettings.vlmEngine && cfgSettings.vlmEngine !== "auto") {
                    engineToUse = cfgSettings.vlmEngine;
                    console.log(`[ML] Using engine from user config: ${engineToUse}`);
                }
                // useNativeText=true → pdfplumber runs first for digital PDFs (fast path)
                // useNativeText=false → Surya always runs regardless of PDF type
                useNativeText = cfgSettings.useNativeText === true;
                if (useNativeText) console.log("[ML] Native text extraction enabled (pdfplumber pre-flight on)");
            }
        } catch { /* non-fatal — fall back to env default */ }

        // Record the engine we're about to use (best-effort; shown in queue UI)
        try { await setInvoiceEngine(invoiceId, engineToUse ?? "auto"); } catch {}
        await step("Engine routing", "running", {
            engine: engineToUse ?? "auto",
            reasoning: engineToUse
                ? `User config engine: ${engineToUse}`
                : "No explicit engine → auto (pdfplumber → Surya on scans)",
        });

        // Download PDF to temp location
        if (!invoice.pdfFileKey) {
            throw new Error("Invoice PDF file key not found");
        }
        await report("Downloading PDF");
        await step("Download PDF", "done", { reasoning: "PDF written to temp path" });
        const { storageGetBuffer } = await import("./storage");
        const buffer = await storageGetBuffer(invoice.pdfFileKey);
        const os = await import("os");
        const path = await import("path");
        const tempPath = path.join(
            os.tmpdir(),
            `invoice_${invoiceId}.pdf`
        );
        await import("fs/promises").then(fs =>
            fs.writeFile(tempPath, Buffer.from(buffer))
        );

        // ═══ STEP 1: Classify document type ═══
        await report("Classifying & extracting (OCR/VLM)");

        // Flip the timeline to the stage that's about to do the heavy work, as
        // RUNNING, before the (potentially multi-minute) extraction call. We
        // don't yet know digital-vs-scanned (Python decides via pdfplumber), so
        // pick the long stage by engine family: vision engines → "Vision → JSON",
        // everything else → "OCR / reader". The post-call block below corrects
        // this to the true path/engine/reasoning once extraction returns.
        {
            const chosen = engineToUse ?? "auto";
            const visionChosen = ["gemma_vl_local", "qwen3vl_local", "qwen_vl_local"].includes(chosen);
            await step("Engine routing", "done", {
                engine: chosen,
                reasoning: `Engine selected: ${chosen} — running extraction…`,
            });
            if (visionChosen) {
                await step("Vision → JSON", "running", {
                    engine: chosen, path: "b",
                    reasoning: "Vision model reading the image (CPU — this can take minutes)…",
                });
            } else {
                await step("OCR / reader", "running", {
                    engine: chosen === "auto" ? "pdfplumber / surya" : chosen,
                    path: "a",
                    reasoning: "Extracting text — digital via pdfplumber, scanned via OCR (CPU, slow)…",
                });
            }
        }

        const { classification, extraction: extractionResult } =
            await classifyAndExtract(tempPath, engineToUse, useNativeText);
        const docType = classification.documentType;
        const handling = classification.handling;

        // ── Emit the real extraction trace into the live timeline ──────────────
        // The Python service reports which engine actually ran, the routing
        // reasoning, and the extraction method. From the method we know whether
        // this run took Path A (OCR/reader → semantic) or Path B (vision → JSON).
        try {
            const ranEngine: string =
                (extractionResult as any)?._vlm_engine ?? engineToUse ?? "auto";
            const method: string =
                (extractionResult as any)?._vlm_extraction_method ??
                (extractionResult as any)?.extraction_method ?? "";
            const why: string =
                (extractionResult as any)?._vlm_reasoning ??
                (extractionResult as any)?.reasoning ?? "";
            const isVision =
                method === "vlm" ||
                ["gemma_vl_local", "qwen3vl_local", "qwen_vl_local"].includes(ranEngine);
            const path: "a" | "b" = isVision ? "b" : "a";

            await step("Engine routing", "done", { engine: ranEngine, path, reasoning: why || `engine: ${ranEngine}` });

            if (isVision) {
                await step("OCR / reader", "skipped", {
                    reasoning: "Vision model reads the image directly — no OCR step",
                });
                await step("Vision → JSON", "done", {
                    engine: ranEngine, path: "b",
                    reasoning: "Vision model returned structured invoice fields directly",
                });
            } else {
                await step("OCR / reader", "done", {
                    engine: ranEngine, path: "a",
                    reasoning: method === "markdown"
                        ? "Reader produced Markdown (tables + text)"
                        : method === "native_text"
                            ? "pdfplumber extracted the PDF text layer"
                            : "OCR transcribed the page to text",
                });
                await step("Semantic extract", "done", {
                    engine: "qwen2.5-3b", path: "a",
                    reasoning: "Local Qwen2.5-3B mapped the text to the invoice schema",
                });
            }
        } catch { /* timeline is best-effort */ }

        // ═══ Non-invoice / non-postable gate ═══
        // Drive the decision off the classifier's `handling` directive:
        //   flag_no_extract → recognised non-invoice (cheque, order, statement,
        //                     unknown): do NOT extract, flag for review.
        // This is what stopped a cheque's IBAN digits becoming a €7-trillion
        // "total". `supported === false` is kept as a belt-and-braces fallback.
        const isFlagNoExtract =
            handling === "flag_no_extract" ||
            classification.supported === false &&
            handling !== "extract_review" &&
            handling !== "extract_no_post";

        if (isFlagNoExtract || docType === "cheque" || docType === "unknown") {
            const reason =
                classification.reason ||
                `Document classified as '${docType}', which is not a supported invoice type.`;
            console.warn(`[ML] Non-invoice document (invoiceId=${invoiceId}): ${reason}`);
            // Persist the REAL type. updateInvoiceDocumentType maps any value the
            // DB enum can't store down to a safe placeholder, so this never throws
            // (see invoiceDb). The precise type still rides in extractedData below.
            try { await updateInvoiceDocumentType(invoiceId, docType); } catch {}
            await report(`Needs review: ${reason}`);
            await updateInvoiceStatus(invoiceId, "review_needed");
            try {
                const { createNotification } = await import("./invoiceDb");
                await createNotification(
                    userId,
                    "review",
                    `Document #${invoiceId} needs review`,
                    reason,
                    invoiceId
                );
            } catch {}
            return {
                success: false,
                documentType: docType,
                finalStatus: "review_needed",
                extractedData: {
                    reason,
                    documentType: docType,
                    handling,
                    supported: classification.supported,
                    scores: classification.scores,
                },
            };
        }

        console.log(
            "[ML] Extraction result:",
            JSON.stringify({
                documentType: docType,
                confidence: classification.confidence,
                success: extractionResult.success,
                invoiceNumber:
                    extractionResult.invoiceNumber ||
                    extractionResult.cmrNumber ||
                    extractionResult.documentNumber,
                supplier:
                    extractionResult.supplier?.name ||
                    extractionResult.sender?.name,
                lineItemCount:
                    extractionResult.lineItems?.length ||
                    extractionResult.goods?.length ||
                    extractionResult.items?.length ||
                    0,
                error: extractionResult.error,
            })
        );

        if (!extractionResult.success) {
            throw new Error(extractionResult.error || "Extraction failed");
        }

        // Capture the engine the pipeline actually used (for the queue UI / result)
        const usedEngine: string | undefined = (extractionResult as any)?._vlm_engine ?? engineToUse;
        try { if (usedEngine) await setInvoiceEngine(invoiceId, usedEngine); } catch {}

        // ═══ STEP 2: Store document type ═══
        await updateInvoiceDocumentType(invoiceId, docType);

        // ═══ STEP 3: Store extracted data based on type ═══
        if (docType === "cmr") {
            await report("Saving CMR data");
            await updateInvoiceExtractedData(
                invoiceId,
                JSON.stringify({
                    documentType: "cmr",
                    cmrNumber: extractionResult.cmrNumber,
                    date: extractionResult.date,
                    sender: extractionResult.sender,
                    carrier: extractionResult.carrier,
                    consignee: extractionResult.consignee,
                    placeOfLoading: extractionResult.placeOfLoading,
                    placeOfDelivery: extractionResult.placeOfDelivery,
                    dateOfLoading: extractionResult.dateOfLoading,
                    goods: extractionResult.goods,
                    totalPackages: extractionResult.totalPackages,
                    totalGrossWeight: extractionResult.totalGrossWeight,
                    totalVolume: extractionResult.totalVolume,
                    freightCharges: extractionResult.freightCharges,
                    instructions: extractionResult.instructions,
                    classificationConfidence: classification.confidence,
                    rawTextPreview: extractionResult.rawTextPreview?.substring(
                        0,
                        500
                    ),
                })
            );

            await import("fs/promises").then(fs =>
                fs.unlink(tempPath).catch(() => {})
            );
            await updateInvoiceStatus(invoiceId, "completed");
            tryPushToOptimusDb(invoiceId, userId).catch(() => {}); // non-blocking

            // ── Auto-export extraction JSON to disk (fire-and-forget) ──
            // Persists the full extractionResult under <EXTRACTIONS_DIR>/
            // <YYYY-MM-DD>/<clientName>/<docNumber>_<HHmmss>.json so the
            // Extractions browser page can list and preview it. Failures
            // here are logged but do not affect the result.
            writeExtraction(
                extractionResult,
                invoiceId,
                userId,
                { engine: (extractionResult as any)?._vlm_engine, extractionMethod: "cmr" },
            ).catch(() => {});

            return {
                success: true,
                documentType: docType,
                finalStatus: "completed",
                engine: usedEngine,
                extractedData: extractionResult,
            };
        } else if (docType === "dispatch_note") {
            await report("Saving dispatch note data");
            await updateInvoiceExtractedData(
                invoiceId,
                JSON.stringify({
                    documentType: "dispatch_note",
                    documentNumber: extractionResult.documentNumber,
                    date: extractionResult.date,
                    sender: extractionResult.sender,
                    recipient: extractionResult.recipient,
                    deliveryAddress: extractionResult.deliveryAddress,
                    transportMethod: extractionResult.transportMethod,
                    vehicleNumber: extractionResult.vehicleNumber,
                    purpose: extractionResult.purpose,
                    items: extractionResult.items,
                    totalQuantity: extractionResult.totalQuantity,
                    notes: extractionResult.notes,
                    classificationConfidence: classification.confidence,
                    rawTextPreview: extractionResult.rawTextPreview?.substring(
                        0,
                        500
                    ),
                })
            );

            await import("fs/promises").then(fs =>
                fs.unlink(tempPath).catch(() => {})
            );
            await updateInvoiceStatus(invoiceId, "completed");
            tryPushToOptimusDb(invoiceId, userId).catch(() => {}); // non-blocking

            // ── Auto-export extraction JSON to disk (fire-and-forget) ──
            writeExtraction(
                extractionResult,
                invoiceId,
                userId,
                { engine: (extractionResult as any)?._vlm_engine, extractionMethod: "dispatch_note" },
            ).catch(() => {});

            return {
                success: true,
                documentType: docType,
                finalStatus: "completed",
                engine: usedEngine,
                extractedData: extractionResult,
            };
        } else {
            // Invoice or Credit Note — same flow with line items + matching
            const extractedDataJson: any = {
                documentType: docType,
                invoiceNumber: extractionResult.invoiceNumber,
                invoiceDate: extractionResult.invoiceDate,
                orderNumber: (extractionResult as any).orderNumber ?? null,
                mark: (extractionResult as any).mark,
                // ── myDATA full set ──────────────────────────────────────────────
                uid:                 (extractionResult as any).uid                ?? null,
                authenticationCode:  (extractionResult as any).authenticationCode ?? null,
                provider:            (extractionResult as any).provider           ?? null,
                // ── Payment method (was extracted but previously dropped) ───────
                paymentMethod:       (extractionResult as any).paymentMethod      ?? null,
                // ── Dispatch fields (combined ΤΔΑ support) ──────────────────────
                dispatchDate:        (extractionResult as any).dispatchDate       ?? null,
                vehicleNumber:       (extractionResult as any).vehicleNumber      ?? null,
                purpose:             (extractionResult as any).purpose            ?? null,
                supplierName: extractionResult.supplier?.name,
                supplierCode: extractionResult.supplier?.code,
                supplierVatNumber: extractionResult.supplier?.vatNumber,
                customerName: (extractionResult as any).customer?.name,
                customerVatNumber: (extractionResult as any).customer?.vatNumber,
                // Full issuer / recipient objects from parser
                issuer: (extractionResult as any).issuer ?? null,
                recipient: (extractionResult as any).recipient ?? null,
                subtotal: extractionResult.totals?.subtotal,
                vatAmount: extractionResult.totals?.vat,
                totalAmount: extractionResult.totals?.total,
                payableAmount: extractionResult.totals?.payable,
                withholdingTax: (extractionResult as any).withholdingTax,
                // Currency — was previously lost between extraction and DB persist.
                // This is the value resolveCurrency() picked (e.g. USD for New Relic
                // invoices), so it must be saved so the UI can render the right symbol.
                currency: (extractionResult as any).currency ?? null,
                classificationConfidence: classification.confidence,
                rawTextPreview: (extractionResult as any).rawTextPreview?.substring(0, 500),
                // VLM debug info
                _vlm_engine: (extractionResult as any)._vlm_engine,
                _vlm_extraction_method: (extractionResult as any)._vlm_extraction_method,
                _vlm_raw_text: (extractionResult as any)._vlm_raw_text,
            };

            // Credit note specific fields
            if (docType === "credit_note") {
                extractedDataJson.originalInvoiceNumber =
                    extractionResult.originalInvoiceNumber;
                extractedDataJson.originalInvoiceDate =
                    extractionResult.originalInvoiceDate;
                extractedDataJson.creditReason = extractionResult.creditReason;
                extractedDataJson.isFull = extractionResult.isFull;
            }

            await updateInvoiceExtractedData(
                invoiceId,
                JSON.stringify(extractedDataJson)
            );

            // ── Auto-enrich supplier record with issuer data ───────────────
            // If the extraction found a richer issuer object, update the
            // suppliers table so the Knowledge Base shows full details.
            try {
                const issuerObj = (extractionResult as any).issuer;
                if (issuerObj && invoice.supplierId) {
                    const { getDb } = await import("./db");
                    const { suppliers } = await import("../drizzle/schema");
                    const { eq: _eq } = await import("drizzle-orm");
                    const dbConn = await getDb();
                    if (dbConn) {
                        // Read current supplier so we don't clobber an existing taxId
                        const existing = await dbConn
                            .select({ taxId: suppliers.taxId })
                            .from(suppliers)
                            .where(_eq(suppliers.id, invoice.supplierId))
                            .limit(1);
                        const existingTaxId = existing[0]?.taxId ?? null;

                        const updates: Record<string, string> = {};
                        if (issuerObj.vatNumber && !existingTaxId) {
                            updates.taxId = issuerObj.vatNumber;
                        }
                        if (issuerObj.address) {
                            updates.address = [
                                issuerObj.address,
                                issuerObj.city,
                                issuerObj.postCode,
                                issuerObj.country,
                            ].filter(Boolean).join(", ");
                        }
                        if (Object.keys(updates).length > 0) {
                            await dbConn.update(suppliers)
                                .set(updates)
                                .where(_eq(suppliers.id, invoice.supplierId));
                        }
                    }
                }
            } catch (enrichErr) {
                console.warn("[Supplier enrich] Non-fatal:", enrichErr);
            }

            // Get user settings for auto-accept threshold
            const userConfig = await getUserConfiguration(userId);
            let autoAcceptThreshold = 90;
            try {
                if (userConfig?.settingsJson) {
                    const settings = JSON.parse(userConfig.settingsJson);
                    if (settings.autoAcceptThreshold !== undefined) {
                        autoAcceptThreshold = Number(settings.autoAcceptThreshold);
                    }
                }
            } catch {}

            // Create line items and get ML product matches
            const lineItemsWithMatches = [];
            const lineItems = Array.isArray(extractionResult.lineItems)
                ? extractionResult.lineItems
                : [];
            let autoAcceptedCount = 0;
            let lineNum = 0;
            const totalLines = lineItems.length;
            await step("Match & save", "running", {
                reasoning: `Matching ${totalLines} line item(s) against ERP catalog…`,
            });
            for (const item of lineItems) {
                lineNum++;
                await report(`Matching line items (${lineNum}/${totalLines})`);
                const netAmt = item.totalPrice || 0;

                // VAT handling — extract-only policy.
                // If `item.vatRate` is null/undefined, the invoice did NOT specify
                // a VAT rate for this line. We MUST NOT synthesize one. Persist
                // vatRate=null, vatAmount=null, totalWithVat=netAmt (no VAT added).
                // If vatRate is 0 (e.g. export invoice), vatAmount=0.00 and
                // totalWithVat=netAmt. Only compute VAT when an actual rate is
                // present on the invoice.
                const hasVatRate = item.vatRate != null;
                const vatRateNum = hasVatRate ? Number(item.vatRate) : null;
                const vatAmt = hasVatRate ? (netAmt * (vatRateNum ?? 0)) / 100 : null;
                const totalWithVat = hasVatRate ? netAmt + (vatAmt ?? 0) : netAmt;

                const lineItemId = await createInvoiceLineItem({
                    invoiceId: invoiceId,
                    lineNumber: lineNum,
                    description: item.description,
                    supplierCode: item.supplierCode,
                    quantity: item.quantity.toString(),
                    unit: item.unit || null,
                    unitPrice: item.unitPrice.toString(),
                    netAmount: item.totalPrice.toString(),
                    vatRate: hasVatRate ? vatRateNum!.toString() : null,
                    vatAmount: vatAmt != null ? vatAmt.toFixed(2) : null,
                    totalWithVat: totalWithVat.toFixed(2),
                    discount1: item.discount1?.toString() || null,
                    discount2: item.discount2?.toString() || null,
                    discount3: item.discount3?.toString() || null,
                    matchStatus: "pending",
                });

                const matchResult = await matchProduct(
                    item.supplierCode,
                    item.description,
                    extractionResult.supplier?.name || "Unknown",
                    5
                );

                if (matchResult.matches?.length > 0) {
                    const topMatch = matchResult.matches[0];
                    if (topMatch.confidence >= autoAcceptThreshold) {
                        await updateLineItemMatch(
                            lineItemId,
                            topMatch.erpCode,
                            "matched",
                            topMatch.confidence.toString()
                        );
                        autoAcceptedCount++;
                        console.log(
                            `[ML] Auto-accepted: ${item.supplierCode} -> ${topMatch.erpCode} (${topMatch.confidence}% >= ${autoAcceptThreshold}%)`
                        );
                    }
                }

                lineItemsWithMatches.push({
                    lineItemId,
                    ...item,
                    matches: matchResult.matches,
                });
            }

            if (autoAcceptedCount > 0) {
                console.log(
                    `[ML] Auto-accepted ${autoAcceptedCount}/${lineItems.length} line items`
                );
            }

            await import("fs/promises").then(fs =>
                fs.unlink(tempPath).catch(() => {})
            );
            await updateInvoiceStatus(invoiceId, "review_needed");
            await step("Match & save", "done", {
                reasoning: "Line items matched; invoice flagged for review",
            });
            tryPushToOptimusDb(invoiceId, userId).catch(() => {}); // non-blocking

            // Notification: review needed
            const { createNotification } = await import("./invoiceDb");
            const invNum =
                extractionResult.invoiceNumber || `#${invoiceId}`;
            const supplierLabel =
                extractionResult.supplier?.name || "Unknown supplier";
            const pendingItems = lineItems.length - autoAcceptedCount;
            createNotification(
                userId,
                "review_needed",
                `Review needed: ${invNum}`,
                `${supplierLabel} — ${pendingItems} of ${lineItems.length} items need manual review`,
                invoiceId
            ).catch(() => {});

            // ── Attach line items to the exported JSON ──────────────────────
            // lineItemsWithMatches is only in scope here (built above), so we
            // add the array to extractedDataJson right before writing it. This
            // gives the saved file (and the Extractions browser) the per-line
            // detail with ERP/product match status — previously the export had
            // totals but no lineItems array. Falls back to the raw parser items.
            extractedDataJson.lineItems =
                (Array.isArray(lineItemsWithMatches) && lineItemsWithMatches.length > 0)
                    ? lineItemsWithMatches
                    : (Array.isArray((extractionResult as any).lineItems)
                        ? (extractionResult as any).lineItems
                        : []);

            // ── Auto-export extraction JSON to disk (fire-and-forget) ──
            // For invoices/credit-notes we save the FULL extractedDataJson
            // (which contains the merged supplier/totals/line-items + myDATA
            // fields), not the raw extractionResult — that's what InvoiceDetail
            // reads back from the DB, so this keeps the on-disk form consistent
            // with what the UI shows.
            writeExtraction(
                extractedDataJson,
                invoiceId,
                userId,
                {
                    engine: (extractionResult as any)?._vlm_engine,
                    extractionMethod: docType,
                },
            ).catch(() => {});

            return {
                success: true,
                documentType: docType,
                finalStatus: "review_needed",
                engine: usedEngine,
                extractedData: extractionResult,
                lineItems: lineItemsWithMatches,
            };
        }
    } catch (error: any) {
        // NOTE: we intentionally do NOT set status='failed' here. The WORKER owns
        // failure/retry bookkeeping (retryCount, re-queue vs. final-fail) so it
        // can decide whether to retry. We still emit the failure notification to
        // preserve the original user-facing behaviour, then re-throw so the
        // worker records the error.
        const { createNotification: createFailNotif } = await import(
            "./invoiceDb"
            );
        createFailNotif(
            userId,
            "processing_failed",
            `Processing failed: Invoice #${invoiceId}`,
            error.message,
            invoiceId
        ).catch(() => {});
        throw error;
    }
}