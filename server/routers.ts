import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { clientProfileRouter } from "./clientProfileRouter";
import { vlmRouter } from "./vlmRouter";
import {
    writeExtraction,
    listExtractions,
    readExtraction,
    deleteExtraction,
} from "./extractionExporter";
// ─────────────────────────────────────────────────────────────────────────────
// QUEUE EDIT 1: tryPushToOptimusDb + the full extraction pipeline now live in
// invoiceProcessor.ts (shared by the background worker and this router). We
// import tryPushToOptimusDb from there instead of defining a second copy here.
// processInvoiceById is the moved pipeline — not called directly by the router
// anymore (the worker calls it), but imported so the module is wired in one place.
// ─────────────────────────────────────────────────────────────────────────────
import { tryPushToOptimusDb } from "./invoiceProcessor";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
    system: systemRouter,
    auth: router({
        me: publicProcedure.query(opts => opts.ctx.user),
        logout: publicProcedure.mutation(({ ctx }) => {
            const cookieOptions = getSessionCookieOptions(ctx.req);
            ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
            return {
                success: true,
            } as const;
        }),
    }),

    clientProfile: clientProfileRouter,
    vlm: vlmRouter,

    // ─── Extractions: list, view, delete, manually re-export the JSON dumps ──
    // Files live on disk under EXTRACTIONS_DIR (default ./extractions/).
    // The Extractions page on the frontend uses these procedures to power the
    // file tree + JSON preview UI.
    extractions: router({
        // List all extraction JSON files, grouped server-side by date then client.
        // Cheap (single fs walk, ~ms even with thousands of files).
        list: protectedProcedure.query(async () => {
            return listExtractions();
        }),

        // Read one extraction JSON by its relative path (as returned by list()).
        // Server-side validates the path stays inside EXTRACTIONS_DIR.
        get: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "relativePath" in val) {
                    return val as { relativePath: string };
                }
                throw new Error("relativePath is required");
            })
            .query(async ({ input }) => {
                const result = await readExtraction(input.relativePath);
                if (!result) {
                    throw new Error(`Extraction not found: ${input.relativePath}`);
                }
                return result;
            }),

        // Delete one extraction JSON. Also prunes empty parent dirs.
        delete: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "relativePath" in val) {
                    return val as { relativePath: string };
                }
                throw new Error("relativePath is required");
            })
            .mutation(async ({ input }) => {
                const deleted = await deleteExtraction(input.relativePath);
                return { success: deleted };
            }),

        // Manual re-export: takes an invoiceId, reads the latest extractedData from
        // the DB, and writes a fresh JSON file. Useful when the auto-export failed
        // (disk full, permissions) or when the user wants a new dated snapshot
        // after editing the extracted data in the UI.
        reexport: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "invoiceId" in val) {
                    return val as { invoiceId: number };
                }
                throw new Error("invoiceId is required");
            })
            .mutation(async ({ input, ctx }) => {
                const { getInvoiceById } = await import("./invoiceDb");
                const invoice = await getInvoiceById(input.invoiceId);
                if (!invoice) throw new Error(`Invoice #${input.invoiceId} not found`);

                let extractedData: any = {};
                try {
                    extractedData = JSON.parse(invoice.extractedData || "{}");
                } catch {
                    throw new Error("Invoice has no parseable extractedData");
                }

                const target = await writeExtraction(
                    extractedData,
                    input.invoiceId,
                    ctx.user.id,
                    {
                        engine: extractedData?._vlm_engine ?? null,
                        extractionMethod: invoice.documentType ?? null,
                    },
                );

                if (!target) {
                    throw new Error("Failed to write extraction file — see server logs");
                }

                return {
                    success: true,
                    filePath: target.filePath,
                    relativePath: [target.dateFolder, target.clientFolder, target.fileName].join("/"),
                };
            }),
    }),

    invoices: router({
        list: protectedProcedure.query(async ({ ctx }) => {
            const { getInvoicesByUserId } = await import("./invoiceDb");
            return getInvoicesByUserId(ctx.user.id);
        }),

        getById: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "id" in val) {
                    return { id: Number((val as any).id) };
                }
                throw new Error("Invalid input");
            })
            .query(async ({ input, ctx }) => {
                const { getInvoiceById, getLineItemsByInvoiceId } = await import(
                    "./invoiceDb"
                    );
                const invoice = await getInvoiceById(input.id);
                if (!invoice || invoice.userId !== ctx.user.id) {
                    throw new Error("Invoice not found");
                }
                const lineItems = await getLineItemsByInvoiceId(input.id);
                return { invoice, lineItems };
            }),

        delete: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "id" in val) {
                    return { id: Number((val as any).id) };
                }
                throw new Error("Invalid input");
            })
            .mutation(async ({ input, ctx }) => {
                const {
                    getInvoiceById,
                    deleteLineItemsByInvoiceId,
                    deleteInvoiceById,
                } = await import("./invoiceDb");
                const invoice = await getInvoiceById(input.id);
                if (!invoice || invoice.userId !== ctx.user.id) {
                    throw new Error("Invoice not found");
                }
                // Delete line items first, then the invoice
                await deleteLineItemsByInvoiceId(input.id);
                await deleteInvoiceById(input.id);
                return { success: true };
            }),

        getPdf: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "id" in val) {
                    return { id: Number((val as any).id) };
                }
                throw new Error("Invalid input");
            })
            .query(async ({ input, ctx }) => {
                const { getInvoiceById } = await import("./invoiceDb");
                const { storageGetBuffer } = await import("./storage");
                const invoice = await getInvoiceById(input.id);
                if (!invoice || invoice.userId !== ctx.user.id) {
                    throw new Error("Invoice not found");
                }
                if (!invoice.pdfFileKey) {
                    throw new Error("No PDF file associated with this invoice");
                }
                const buffer = await storageGetBuffer(invoice.pdfFileKey);
                return {
                    base64: buffer.toString("base64"),
                    fileName: invoice.pdfFileKey.split("/").pop() || "invoice.pdf",
                };
            }),

        upload: protectedProcedure
            .input((val: unknown) => {
                if (
                    typeof val === "object" &&
                    val !== null &&
                    "fileData" in val &&
                    "fileName" in val
                ) {
                    return {
                        fileData: String((val as any).fileData), // base64 encoded file
                        fileName: String((val as any).fileName),
                    };
                }
                throw new Error("Invalid input");
            })
            .mutation(async ({ input, ctx }) => {
                const { createInvoice, enqueueInvoice } = await import("./invoiceDb");
                const { storagePut } = await import("./storage");

                // Decode base64 file data
                const fileBuffer = Buffer.from(input.fileData, "base64");

                // Upload to S3
                const fileKey = `invoices/${ctx.user.id}/${Date.now()}-${input.fileName}`;
                const { url } = await storagePut(
                    fileKey,
                    fileBuffer,
                    "application/pdf"
                );

                // Create invoice record
                const invoiceId = await createInvoice({
                    userId: ctx.user.id,
                    pdfUrl: url,
                    pdfFileKey: fileKey,
                    status: "pending",
                });

                // ─────────────────────────────────────────────────────────────────
                // QUEUE EDIT 3: auto-enqueue on upload.
                // Immediately place the freshly-uploaded invoice into the processing
                // queue (status 'pending' → 'queued'). The background worker picks it
                // up; the client gets `invoiceId` back instantly and can watch /queue.
                // Best-effort: if enqueue fails the invoice still exists as 'pending'
                // and can be processed/retried manually, so we don't fail the upload.
                // ─────────────────────────────────────────────────────────────────
                try {
                    await enqueueInvoice(invoiceId as number);
                } catch (e: any) {
                    console.warn(
                        `[Queue] Auto-enqueue failed for invoice #${invoiceId}: ${e?.message ?? e}`
                    );
                }

                return { invoiceId, url };
            }),

        // ─────────────────────────────────────────────────────────────────────────
        // QUEUE EDIT 2: `process` is now a THIN ENQUEUE.
        // Previously this ran the entire (2–90 min) extraction inline, blocking the
        // HTTP request and stranding the invoice at 'processing' if the browser
        // closed. Now it simply enqueues the invoice and returns immediately; the
        // background worker (queueWorker.ts) runs the shared pipeline
        // (invoiceProcessor.processInvoiceById) and updates status/progress in the
        // DB. Callers that used to await the result (InvoiceUpload, InvoiceList
        // Reprocess, InvoiceDetail) now get an instant { queued: true } and should
        // watch the Processing Queue page for live status.
        // ─────────────────────────────────────────────────────────────────────────
        process: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "invoiceId" in val) {
                    return { invoiceId: Number((val as any).invoiceId) };
                }
                throw new Error("Invalid input");
            })
            .mutation(async ({ input, ctx }) => {
                const { getInvoiceById, enqueueInvoice } = await import("./invoiceDb");

                const invoice = await getInvoiceById(input.invoiceId);
                if (!invoice || invoice.userId !== ctx.user.id) {
                    throw new Error("Invoice not found");
                }

                // Enqueue (idempotent-ish: sets status 'queued', stamps queuedAt,
                // clears any prior error). The worker claims it from here.
                await enqueueInvoice(input.invoiceId);

                return {
                    success: true,
                    queued: true,
                    invoiceId: input.invoiceId,
                    message: "Invoice queued for processing",
                };
            }),

        // ── QUEUE: batch enqueue ──────────────────────────────────────────────
        // Enqueue many invoices at once under a shared batchId so the queue UI can
        // show per-batch progress. Returns the batchId and how many were queued.
        batchEnqueue: protectedProcedure
            .input((val: unknown) => {
                const v = val as any;
                if (!v || !Array.isArray(v.invoiceIds)) {
                    throw new Error("invoiceIds array is required");
                }
                return {
                    invoiceIds: v.invoiceIds.map((x: any) => Number(x)) as number[],
                    ...(v.batchId ? { batchId: String(v.batchId) } : {}),
                };
            })
            .mutation(async ({ input, ctx }) => {
                const { getInvoiceById, enqueueInvoice } = await import("./invoiceDb");
                const batchId =
                    input.batchId ||
                    `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                let queued = 0;
                for (const id of input.invoiceIds) {
                    try {
                        const inv = await getInvoiceById(id);
                        if (!inv || inv.userId !== ctx.user.id) continue; // ownership check
                        await enqueueInvoice(id, batchId);
                        queued++;
                    } catch (e: any) {
                        console.warn(
                            `[Queue] batchEnqueue failed for #${id}: ${e?.message ?? e}`
                        );
                    }
                }
                return { success: true, batchId, queued, total: input.invoiceIds.length };
            }),

        // ── QUEUE: live status (polled by ProcessingQueue page + sidebar badge) ──
        // Returns { counts, active, recent, batches } for the current user.
        queueStatus: protectedProcedure.query(async ({ ctx }) => {
            const { getQueueStatus } = await import("./invoiceDb");
            return getQueueStatus(ctx.user.id);
        }),

        // ── QUEUE: retry a failed invoice ─────────────────────────────────────
        // Re-queues a 'failed' invoice (resets retryCount, clears error) so the
        // worker attempts it again.
        retry: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "invoiceId" in val) {
                    return { invoiceId: Number((val as any).invoiceId) };
                }
                throw new Error("Invalid input");
            })
            .mutation(async ({ input, ctx }) => {
                const { getInvoiceById, requeueInvoice } = await import("./invoiceDb");
                const invoice = await getInvoiceById(input.invoiceId);
                if (!invoice || invoice.userId !== ctx.user.id) {
                    throw new Error("Invoice not found");
                }
                await requeueInvoice(input.invoiceId, true /* reset retry count */);
                return { success: true, queued: true };
            }),

        // ── QUEUE: cancel a queued invoice ────────────────────────────────────
        // Removes a 'queued' invoice from the queue (back to 'pending'). Only works
        // while still queued — once a worker has claimed it (processing) it can't be
        // cancelled mid-flight; the response reports whether it was cancelled.
        cancelQueued: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "invoiceId" in val) {
                    return { invoiceId: Number((val as any).invoiceId) };
                }
                throw new Error("Invalid input");
            })
            .mutation(async ({ input, ctx }) => {
                const { getInvoiceById, cancelQueuedInvoice } = await import(
                    "./invoiceDb"
                    );
                const invoice = await getInvoiceById(input.invoiceId);
                if (!invoice || invoice.userId !== ctx.user.id) {
                    throw new Error("Invoice not found");
                }
                const cancelled = await cancelQueuedInvoice(input.invoiceId);
                return { success: true, cancelled };
            }),

        statistics: protectedProcedure.query(async ({ ctx }) => {
            const { getInvoiceStatistics, getMatchStatistics } = await import(
                "./invoiceDb"
                );
            const invoiceStats = await getInvoiceStatistics(ctx.user.id);
            const matchStats = await getMatchStatistics(ctx.user.id);
            return { invoiceStats, matchStats };
        }),

        analytics: protectedProcedure.query(async ({ ctx }) => {
            const {
                getDailyInvoiceVolume,
                getSupplierBreakdown,
                getRecentInvoices,
                getLineItemCounts,
            } = await import("./invoiceDb");
            const [dailyVolume, supplierBreakdown, recentInvoices, lineItemCounts] =
                await Promise.all([
                    getDailyInvoiceVolume(ctx.user.id),
                    getSupplierBreakdown(ctx.user.id),
                    getRecentInvoices(ctx.user.id),
                    getLineItemCounts(ctx.user.id),
                ]);
            const avgItems =
                lineItemCounts.length > 0
                    ? Math.round(
                        lineItemCounts.reduce(
                            (sum: number, l: any) => sum + Number(l.itemCount),
                            0
                        ) / lineItemCounts.length
                    )
                    : 0;
            const avgMatchRate =
                lineItemCounts.length > 0
                    ? Math.round(
                        lineItemCounts.reduce(
                            (sum: number, l: any) =>
                                sum +
                                (Number(l.itemCount) > 0
                                    ? (Number(l.matchedCount) / Number(l.itemCount)) * 100
                                    : 0),
                            0
                        ) / lineItemCounts.length
                    )
                    : 0;
            return {
                dailyVolume,
                supplierBreakdown,
                recentInvoices,
                avgItemsPerInvoice: avgItems,
                avgMatchRate,
            };
        }),

        // Export full invoice history with line items
        exportHistory: protectedProcedure.query(async ({ ctx }) => {
            const { getInvoiceExportData } = await import("./invoiceDb");
            const data = await getInvoiceExportData(ctx.user.id);
            return data;
        }),

        exportById: protectedProcedure
            .input((val: unknown) => ({ invoiceId: Number((val as any).invoiceId) }))
            .query(async ({ input }) => {
                const { getInvoiceWithLineItems } = await import("./invoiceDb");
                return getInvoiceWithLineItems(input.invoiceId);
            }),
    }),

    products: router({
        search: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "query" in val) {
                    return { query: String((val as any).query) };
                }
                throw new Error("Invalid input");
            })
            .query(async ({ input }) => {
                const { searchProducts } = await import("./invoiceDb");
                return searchProducts(input.query);
            }),

        match: protectedProcedure
            .input((val: unknown) => {
                if (
                    typeof val === "object" &&
                    val !== null &&
                    "supplierName" in val &&
                    "supplierCode" in val &&
                    "description" in val
                ) {
                    return {
                        supplierName: String((val as any).supplierName),
                        supplierCode: String((val as any).supplierCode),
                        description: String((val as any).description),
                        topN: (val as any).topN ? Number((val as any).topN) : 5,
                    };
                }
                throw new Error("Invalid input");
            })
            .query(async ({ input }) => {
                const { matchProduct } = await import("./python-integration");
                return matchProduct(
                    input.supplierCode,
                    input.description,
                    input.supplierName,
                    input.topN
                );
            }),

        confirmMatch: protectedProcedure
            .input((val: unknown) => {
                if (
                    typeof val === "object" &&
                    val !== null &&
                    "lineItemId" in val &&
                    "erpCode" in val
                ) {
                    return {
                        lineItemId: Number((val as any).lineItemId),
                        erpCode: String((val as any).erpCode),
                        supplierName: String((val as any).supplierName),
                        supplierCode: String((val as any).supplierCode),
                        description: (val as any).description
                            ? String((val as any).description)
                            : undefined,
                        confidence: (val as any).confidence
                            ? String((val as any).confidence)
                            : undefined,
                    };
                }
                throw new Error("Invalid input");
            })
            .mutation(async ({ input }) => {
                const { updateLineItemMatch } = await import("./invoiceDb");
                const { learnFromCorrection } = await import("./python-integration");

                // Update line item with matched ERP code
                await updateLineItemMatch(
                    input.lineItemId,
                    input.erpCode,
                    "matched",
                    input.confidence
                );

                // Learn transformation rule from this correction
                const learningResult = await learnFromCorrection(
                    input.supplierName,
                    input.supplierCode,
                    input.erpCode,
                    input.description
                );

                return {
                    success: true,
                    ruleId: learningResult.ruleId,
                    pattern: learningResult.pattern,
                    message: learningResult.message,
                };
            }),
    }),

    configuration: router({
        get: protectedProcedure.query(async ({ ctx }) => {
            const { getUserConfiguration } = await import("./invoiceDb");
            return getUserConfiguration(ctx.user.id);
        }),

        getSettings: protectedProcedure.query(async ({ ctx }) => {
            const { getUserConfiguration } = await import("./invoiceDb");
            const config = await getUserConfiguration(ctx.user.id);
            const defaults = {
                erpType: "softone",
                softoneApiUrl: "",
                softoneUsername: "",
                softonePassword: "",
                softoneClientId: "",
                softoneAppId: "",
                softoneCompany: "",
                softoneBranch: "",
                softoneModule: "",
                softoneRefId: "",
                extractionLanguage: "mixed",
                defaultVatRate: "24",
                defaultCurrency: "EUR",
                autoProcessOnUpload: true,
                autoAcceptThreshold: 90,
                matchingMethods: ["exact", "fuzzy", "tfidf", "pattern"],
                minConfidenceToShow: 30,
                maxSuggestionsPerItem: 5,
                emailNotifications: false,
                notifyOnComplete: false,
                notifyOnError: false,
                defaultSortOrder: "newest",
                dashboardRefreshInterval: 30,
                sapApiUrl: "",
                sapCompanyDb: "",
                sapUsername: "",
                sapPassword: "",
                dynamicsTenantId: "",
                dynamicsClientId: "",
                dynamicsClientSecret: "",
                dynamicsEnvironment: "",
                customApiUrl: "",
                customAuthType: "bearer",
                customAuthToken: "",
                customHeaders: "",
            };
            if (!config) return defaults;
            // Merge: defaults < settingsJson < DB columns (Softone fields take priority from DB)
            let merged = { ...defaults };
            try {
                if (config.settingsJson)
                    merged = { ...merged, ...JSON.parse(config.settingsJson) };
            } catch {}
            return {
                ...merged,
                erpType: config.erpType || "softone",
                softoneApiUrl: config.softoneApiUrl || "",
                softoneUsername: config.softoneUsername || "",
                softonePassword: config.softonePassword || "",
                softoneClientId: config.softoneClientId || "",
                softoneAppId: config.softoneAppId || "",
                softoneCompany: config.softoneCompany || "",
                softoneBranch: config.softoneBranch || "",
                softoneModule: config.softoneModule || "",
                softoneRefId: config.softoneRefId || "",
            };
        }),

        saveSettings: protectedProcedure
            .input((val: unknown) => val as any)
            .mutation(async ({ input, ctx }) => {
                const { getUserConfiguration, upsertConfiguration } = await import(
                    "./invoiceDb"
                    );
                const { erpType, ...rest } = input;
                // Separate softone fields from settings
                const softoneFields = [
                    "softoneApiUrl",
                    "softoneUsername",
                    "softonePassword",
                    "softoneClientId",
                    "softoneAppId",
                    "softoneCompany",
                    "softoneBranch",
                    "softoneModule",
                    "softoneRefId",
                ];
                const softoneData: any = {};
                const settingsData: any = {};
                for (const [k, v] of Object.entries(rest)) {
                    if (softoneFields.includes(k)) softoneData[k] = v;
                    else settingsData[k] = v;
                }
                await upsertConfiguration({
                    userId: ctx.user.id,
                    erpType: erpType || "softone",
                    ...softoneData,
                    settingsJson: JSON.stringify(settingsData),
                });
                return { success: true };
            }),

        save: protectedProcedure
            .input((val: unknown) => val as any)
            .mutation(async ({ input, ctx }) => {
                const { upsertConfiguration } = await import("./invoiceDb");
                await upsertConfiguration({ userId: ctx.user.id, ...input });
                return { success: true };
            }),

        testConnection: protectedProcedure.mutation(async ({ ctx }) => {
            const { getUserConfiguration, updateConnectionTest } = await import(
                "./invoiceDb"
                );
            const { createSoftoneClient } = await import("./softoneClient");

            const config = await getUserConfiguration(ctx.user.id);
            if (!config) {
                throw new Error(
                    "Configuration not found. Please save your ERP settings first."
                );
            }

            if (!config.softoneApiUrl || !config.softoneUsername) {
                throw new Error(
                    "Softone API URL and Username are required. Please fill in your ERP settings."
                );
            }

            // Create a client with saved config and test login
            const client = createSoftoneClient(config);
            const loginResult = await client.login();

            await updateConnectionTest(ctx.user.id, loginResult.success);

            if (loginResult.success) {
                return {
                    success: true,
                    message: "Successfully connected to Softone ERP",
                };
            } else {
                return {
                    success: false,
                    error: loginResult.error || "Connection failed",
                };
            }
        }),
    }),

    rules: router({
        list: protectedProcedure.query(async () => {
            const { getLearnedRules } = await import("./python-integration");
            return getLearnedRules();
        }),

        bySupplier: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "supplierName" in val) {
                    return { supplierName: String((val as any).supplierName) };
                }
                throw new Error("Invalid input");
            })
            .query(async ({ input }) => {
                const { getLearnedRules } = await import("./python-integration");
                return getLearnedRules(input.supplierName);
            }),

        statistics: protectedProcedure.query(async () => {
            const { getKnowledgeBaseStats } = await import("./python-integration");
            return getKnowledgeBaseStats();
        }),
    }),

    // Knowledge Base - Supplier mappings and transformation rules
    knowledgeBase: router({
        // Get all mappings with supplier info
        mappings: protectedProcedure.query(async () => {
            const { getAllMappings } = await import("./invoiceDb");
            return getAllMappings();
        }),

        // Update a mapping
        updateMapping: protectedProcedure
            .input((val: unknown) => {
                const v = val as any;
                return {
                    id: Number(v.id),
                    erpCode: v.erpCode ? String(v.erpCode) : undefined,
                    description: v.description ? String(v.description) : undefined,
                    price: v.price ? String(v.price) : undefined,
                };
            })
            .mutation(async ({ input }) => {
                const { updateProductMapping } = await import("./invoiceDb");
                const { id, ...data } = input;
                await updateProductMapping(id, data);
                return { success: true };
            }),

        // Delete a mapping
        deleteMapping: protectedProcedure
            .input((val: unknown) => ({ id: Number((val as any).id) }))
            .mutation(async ({ input }) => {
                const { deleteProductMapping } = await import("./invoiceDb");
                await deleteProductMapping(input.id);
                return { success: true };
            }),

        // Get all transformation rules from DB
        rules: protectedProcedure.query(async () => {
            const { getAllRules } = await import("./invoiceDb");
            return getAllRules();
        }),

        // Delete a rule
        deleteRule: protectedProcedure
            .input((val: unknown) => ({ id: Number((val as any).id) }))
            .mutation(async ({ input }) => {
                const { deleteTransformationRule } = await import("./invoiceDb");
                await deleteTransformationRule(input.id);
                return { success: true };
            }),

        // Update a rule
        updateRule: protectedProcedure
            .input((val: unknown) => {
                const v = val as any;
                return {
                    id: Number(v.id),
                    pattern: v.pattern ? String(v.pattern) : undefined,
                    confidence: v.confidence ? String(v.confidence) : undefined,
                };
            })
            .mutation(async ({ input }) => {
                const { updateTransformationRule } = await import("./invoiceDb");
                const { id, ...data } = input;
                await updateTransformationRule(id, data);
                return { success: true };
            }),

        // Get all suppliers
        suppliers: protectedProcedure.query(async () => {
            const { getAllSuppliers } = await import("./invoiceDb");
            return getAllSuppliers();
        }),

        // Stats
        stats: protectedProcedure.query(async () => {
            const { getMappingsCount, getRulesCount, getSuppliersCount } =
                await import("./invoiceDb");
            const [mappings, rules, suppliers] = await Promise.all([
                getMappingsCount(),
                getRulesCount(),
                getSuppliersCount(),
            ]);
            return { mappings, rules, suppliers };
        }),

        // Import mappings (bulk)
        importMappings: protectedProcedure
            .input((val: unknown) => {
                const v = val as any;
                if (!Array.isArray(v.mappings)) throw new Error("Invalid input");
                return {
                    mappings: v.mappings as Array<{
                        supplierCode: string;
                        erpCode: string;
                        description?: string;
                        supplierName?: string;
                    }>,
                };
            })
            .mutation(async ({ input }) => {
                const { createProductMapping, getSupplierByCode, createSupplier } =
                    await import("./invoiceDb");
                let imported = 0;
                for (const m of input.mappings) {
                    try {
                        // Find or create supplier
                        let supplierId = 1; // default
                        if (m.supplierName) {
                            const existing = await getSupplierByCode(
                                m.supplierName.substring(0, 10)
                            );
                            if (existing) {
                                supplierId = existing.id;
                            } else {
                                supplierId = (await createSupplier({
                                    code: m.supplierName.substring(0, 10),
                                    name: m.supplierName,
                                })) as number;
                            }
                        }
                        await createProductMapping({
                            supplierId,
                            supplierCode: m.supplierCode,
                            erpCode: m.erpCode,
                            description: m.description || null,
                            confidence: "100",
                            usageCount: 0,
                        });
                        imported++;
                    } catch (e) {
                        // Skip duplicates
                    }
                }
                return { success: true, imported };
            }),
    }),

    // Softone ERP Integration
    softone: router({
        testConnection: protectedProcedure.mutation(async ({ ctx }) => {
            const { getSoftoneClientForUser } = await import("./softoneClient");
            try {
                const client = await getSoftoneClientForUser(ctx.user.id);
                return await client.testConnection();
            } catch (error: any) {
                return { success: false, error: error.message };
            }
        }),

        getProducts: protectedProcedure.query(async ({ ctx }) => {
            const { getSoftoneClientForUser } = await import("./softoneClient");
            const client = await getSoftoneClientForUser(ctx.user.id);
            const products = await client.getProducts();
            return { products };
        }),

        findProduct: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "code" in val) {
                    return { code: String((val as any).code) };
                }
                throw new Error("Invalid input");
            })
            .query(async ({ input, ctx }) => {
                const { getSoftoneClientForUser } = await import("./softoneClient");
                const client = await getSoftoneClientForUser(ctx.user.id);
                const product = await client.findProductByCode(input.code);
                return { product };
            }),

        getSuppliers: protectedProcedure.query(async ({ ctx }) => {
            const { getSoftoneClientForUser } = await import("./softoneClient");
            const client = await getSoftoneClientForUser(ctx.user.id);
            const suppliers = await client.getSuppliers();
            return { suppliers };
        }),

        findSupplier: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "searchTerm" in val) {
                    return { searchTerm: String((val as any).searchTerm) };
                }
                throw new Error("Invalid input");
            })
            .query(async ({ input, ctx }) => {
                const { getSoftoneClientForUser } = await import("./softoneClient");
                const client = await getSoftoneClientForUser(ctx.user.id);
                const supplier = await client.findSupplier(input.searchTerm);
                return { supplier };
            }),

        createInvoice: protectedProcedure
            .input((val: unknown) => {
                if (typeof val === "object" && val !== null && "invoiceId" in val) {
                    return { invoiceId: Number((val as any).invoiceId) };
                }
                throw new Error("Invalid input");
            })
            .mutation(async ({ input, ctx }) => {
                const { getInvoiceById, getLineItemsByInvoiceId, updateInvoiceStatus } =
                    await import("./invoiceDb");
                const { getSoftoneClientForUser } = await import("./softoneClient");

                // Get configured client (throws if not configured)
                const client = await getSoftoneClientForUser(ctx.user.id);

                // Get invoice and line items
                const invoice = await getInvoiceById(input.invoiceId);
                if (!invoice || invoice.userId !== ctx.user.id) {
                    throw new Error("Invoice not found");
                }

                const lineItems = await getLineItemsByInvoiceId(input.invoiceId);

                // Check if all line items are matched
                const unmatchedItems = lineItems.filter(
                    (item: any) =>
                        item.matchStatus !== "matched" && item.matchStatus !== "manual"
                );
                if (unmatchedItems.length > 0) {
                    throw new Error(
                        `${unmatchedItems.length} line items are not matched yet`
                    );
                }

                // Parse extracted data
                const extractedData = invoice.extractedData
                    ? JSON.parse(invoice.extractedData)
                    : {};

                // Prepare invoice data for Softone
                const invoiceData = {
                    supplierCode: extractedData.supplierCode || "UNKNOWN",
                    invoiceNumber:
                        extractedData.invoiceNumber || invoice.invoiceNumber || "N/A",
                    invoiceDate:
                        extractedData.invoiceDate || new Date().toISOString().split("T")[0],
                    lineItems: lineItems.map((item: any) => ({
                        productCode: item.erpCode || "",
                        quantity: parseFloat(item.quantity || "0"),
                        unitPrice: parseFloat(item.unitPrice || "0"),
                        discount: parseFloat(item.discount1 || "0"),
                        // VAT rate sent to ERP: preserve what was extracted, including 0
                        // (zero-VAT / export invoices). When the invoice did NOT specify
                        // a VAT rate, send 0 — NEVER synthesize 24%. The Softone client
                        // should treat 0 as "no VAT line" if its business logic requires.
                        vatRate:
                            item.vatRate != null && item.vatRate !== ""
                                ? parseFloat(String(item.vatRate))
                                : 0,
                    })),
                };

                // Create invoice in Softone
                const result = await client.createPurchaseInvoice(invoiceData);

                if (result.success) {
                    await updateInvoiceStatus(input.invoiceId, "completed");
                    return {
                        success: true,
                        message: "Invoice created successfully in Softone ERP",
                        data: result.data,
                    };
                } else {
                    await updateInvoiceStatus(input.invoiceId, "failed", result.error);
                    throw new Error(
                        result.error || "Failed to create invoice in Softone"
                    );
                }
            }),
    }),

    // ERP Data Model Editor
    erpModel: router({
        // Get products (paginated + search + filter)
        products: protectedProcedure
            .input((val: unknown) => {
                const v = (val as any) || {};
                return {
                    search: v.search ? String(v.search) : undefined,
                    category: v.category ? String(v.category) : undefined,
                    page: v.page ? Number(v.page) : 1,
                    pageSize: v.pageSize ? Number(v.pageSize) : 50,
                };
            })
            .query(async ({ input }) => {
                const { getAllErpProducts } = await import("./invoiceDb");
                return getAllErpProducts(input);
            }),

        // Get categories
        categories: protectedProcedure.query(async () => {
            const { getProductCategories } = await import("./invoiceDb");
            return getProductCategories();
        }),

        // Get stats
        stats: protectedProcedure.query(async () => {
            const { getErpModelStats, getAutoMatchRate } = await import(
                "./invoiceDb"
                );
            const [stats, matchRate] = await Promise.all([
                getErpModelStats(),
                getAutoMatchRate(),
            ]);
            return { ...stats, autoMatchRate: matchRate };
        }),

        // Get mapping counts per ERP code
        mappingCounts: protectedProcedure.query(async () => {
            const { getMappingCountByErpCode } = await import("./invoiceDb");
            return getMappingCountByErpCode();
        }),

        // Get unmapped items
        unmapped: protectedProcedure.query(async () => {
            const { getUnmappedItems } = await import("./invoiceDb");
            return getUnmappedItems();
        }),

        // Upsert a product
        upsertProduct: protectedProcedure
            .input((val: unknown) => {
                const v = val as any;
                if (!v.erpCode) throw new Error("erpCode required");
                return {
                    erpCode: String(v.erpCode),
                    description: v.description ? String(v.description) : undefined,
                    price: v.price ? String(v.price) : undefined,
                    category: v.category ? String(v.category) : undefined,
                    unit: v.unit ? String(v.unit) : undefined,
                    vatRate: v.vatRate ? String(v.vatRate) : undefined,
                    active: v.active !== undefined ? Boolean(v.active) : true,
                    source: v.source ? String(v.source) : "manual",
                };
            })
            .mutation(async ({ input }) => {
                const { upsertErpProduct } = await import("./invoiceDb");
                return upsertErpProduct(input);
            }),

        // Delete a product
        deleteProduct: protectedProcedure
            .input((val: unknown) => ({ id: Number((val as any).id) }))
            .mutation(async ({ input }) => {
                const { deleteErpProduct } = await import("./invoiceDb");
                await deleteErpProduct(input.id);
                return { success: true };
            }),

        // Bulk import from CSV
        importProducts: protectedProcedure
            .input((val: unknown) => {
                const v = val as any;
                if (!Array.isArray(v.items)) throw new Error("items array required");
                return {
                    items: v.items as Array<{
                        erpCode: string;
                        description?: string;
                        price?: string;
                        category?: string;
                        unit?: string;
                        vatRate?: string;
                    }>,
                };
            })
            .mutation(async ({ input }) => {
                const { bulkImportProducts } = await import("./invoiceDb");
                return bulkImportProducts(input.items, "csv_import");
            }),

        // Auto-map unmapped items (tries matchProduct for each unmapped supplier code)
        autoMap: protectedProcedure.mutation(async () => {
            const {
                getUnmappedItems,
                createProductMapping,
                getSupplierByCode,
                createSupplier,
            } = await import("./invoiceDb");
            const { matchProduct } = await import("./python-integration");
            const unmapped = (await getUnmappedItems(100)) as any[];
            const rows = Array.isArray(unmapped) ? unmapped[0] || [] : unmapped;
            let mapped = 0,
                skipped = 0;

            for (const item of Array.isArray(rows) ? rows : []) {
                try {
                    const matchResult = await matchProduct(
                        item.supplierCode || "",
                        item.description || "",
                        item.supplierName || "",
                        1
                    );
                    const top = matchResult.matches?.[0];
                    if (
                        top &&
                        Number(top.confidence) >= 70
                    ) {
                        let supplierId = 1;
                        if (item.supplierName) {
                            const existing = await getSupplierByCode(
                                item.supplierName.substring(0, 30)
                            );
                            if (existing) supplierId = existing.id;
                            else
                                supplierId = (await createSupplier({
                                    code: item.supplierName.substring(0, 30),
                                    name: item.supplierName,
                                })) as number;
                        }
                        await createProductMapping({
                            supplierId,
                            supplierCode: item.supplierCode,
                            erpCode: top.erpCode,
                            description: item.description,
                            confidence: String(top.confidence),
                            usageCount: 0,
                        });
                        mapped++;
                    } else {
                        skipped++;
                    }
                } catch {
                    skipped++;
                }
            }
            return { mapped, skipped };
        }),

        // Get all mappings with enriched info (for mappings tab)
        allMappings: protectedProcedure
            .input((val: unknown) => {
                const v = (val as any) || {};
                return {
                    search: v.search ? String(v.search) : undefined,
                    supplierFilter: v.supplierFilter
                        ? String(v.supplierFilter)
                        : undefined,
                    sourceFilter: v.sourceFilter ? String(v.sourceFilter) : undefined,
                };
            })
            .query(async ({ input }) => {
                const { getAllMappings } = await import("./invoiceDb");
                let mappings = await getAllMappings();
                if (input.search) {
                    const s = input.search.toLowerCase();
                    mappings = mappings.filter(
                        (m: any) =>
                            (m.supplierCode || "").toLowerCase().includes(s) ||
                            (m.erpCode || "").toLowerCase().includes(s) ||
                            (m.description || "").toLowerCase().includes(s)
                    );
                }
                if (input.supplierFilter) {
                    mappings = mappings.filter(
                        (m: any) => m.supplierName === input.supplierFilter
                    );
                }
                if (input.sourceFilter) {
                    mappings = mappings.filter((m: any) => {
                        const src = (m as any).source || "manual";
                        return src === input.sourceFilter;
                    });
                }
                return mappings;
            }),

        // Add a new supplier→ERP mapping
        addMapping: protectedProcedure
            .input((val: unknown) => {
                const v = val as any;
                if (!v.supplierCode || !v.erpCode)
                    throw new Error("supplierCode and erpCode required");
                return {
                    supplierCode: String(v.supplierCode),
                    erpCode: String(v.erpCode),
                    description: v.description ? String(v.description) : undefined,
                    supplierName: v.supplierName ? String(v.supplierName) : undefined,
                    confidence: v.confidence ? String(v.confidence) : "100",
                };
            })
            .mutation(async ({ input }) => {
                const { createProductMapping, getSupplierByCode, createSupplier } =
                    await import("./invoiceDb");
                let supplierId = 1;
                if (input.supplierName) {
                    const existing = await getSupplierByCode(
                        input.supplierName.substring(0, 30)
                    );
                    if (existing) {
                        supplierId = existing.id;
                    } else {
                        supplierId = (await createSupplier({
                            code: input.supplierName.substring(0, 30),
                            name: input.supplierName,
                        })) as number;
                    }
                }
                const id = await createProductMapping({
                    supplierId,
                    supplierCode: input.supplierCode,
                    erpCode: input.erpCode,
                    description: input.description,
                    confidence: input.confidence,
                    usageCount: 0,
                });
                return { id, success: true };
            }),

        // Update existing mapping
        updateMapping: protectedProcedure
            .input((val: unknown) => {
                const v = val as any;
                if (!v.id) throw new Error("id required");
                return {
                    id: Number(v.id),
                    erpCode: v.erpCode ? String(v.erpCode) : undefined,
                    description: v.description ? String(v.description) : undefined,
                    confidence: v.confidence ? String(v.confidence) : undefined,
                };
            })
            .mutation(async ({ input }) => {
                const { updateProductMapping } = await import("./invoiceDb");
                await updateProductMapping(input.id, input);
                return { success: true };
            }),

        // Delete mapping
        deleteMapping: protectedProcedure
            .input((val: unknown) => ({ id: Number((val as any).id) }))
            .mutation(async ({ input }) => {
                const { deleteProductMapping } = await import("./invoiceDb");
                await deleteProductMapping(input.id);
                return { success: true };
            }),

        // Export products as JSON (frontend converts to CSV)
        exportProducts: protectedProcedure.query(async () => {
            const { getAllErpProducts } = await import("./invoiceDb");
            const { rows } = await getAllErpProducts({ pageSize: 99999 });
            return rows;
        }),

        // Get all suppliers for filter dropdowns
        suppliers: protectedProcedure.query(async () => {
            const { getDb } = await import("./db");
            const { suppliers } = await import("../drizzle/schema");
            const db = await getDb();
            if (!db) return [];
            return db.select().from(suppliers).orderBy(suppliers.name);
        }),
    }),

    // Notifications
    notifications: router({
        list: protectedProcedure.query(async ({ ctx }) => {
            const { getNotifications } = await import("./invoiceDb");
            return getNotifications(ctx.user.id);
        }),
        unreadCount: protectedProcedure.query(async ({ ctx }) => {
            const { getUnreadCount } = await import("./invoiceDb");
            return { count: await getUnreadCount(ctx.user.id) };
        }),
        markRead: protectedProcedure
            .input((val: unknown) => ({ id: Number((val as any).id) }))
            .mutation(async ({ input }) => {
                const { markNotificationRead } = await import("./invoiceDb");
                await markNotificationRead(input.id);
                return { success: true };
            }),
        markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
            const { markAllNotificationsRead } = await import("./invoiceDb");
            await markAllNotificationsRead(ctx.user.id);
            return { success: true };
        }),
    }),

    // Approval chain
    approvals: router({
        pending: protectedProcedure.query(async ({ ctx }) => {
            const { getPendingApprovals } = await import("./invoiceDb");
            return getPendingApprovals(ctx.user.id);
        }),
        byInvoice: protectedProcedure
            .input((val: unknown) => ({ invoiceId: Number((val as any).invoiceId) }))
            .query(async ({ input }) => {
                const { getApprovalsByInvoice } = await import("./invoiceDb");
                return getApprovalsByInvoice(input.invoiceId);
            }),
        submit: protectedProcedure
            .input((val: unknown) => ({
                invoiceId: Number((val as any).invoiceId),
                comment: String((val as any).comment || ""),
            }))
            .mutation(async ({ input, ctx }) => {
                const { createApproval, createNotification, getInvoiceById } =
                    await import("./invoiceDb");
                const invoice = await getInvoiceById(input.invoiceId);
                const label = invoice?.invoiceNumber || `#${input.invoiceId}`;
                await createApproval(input.invoiceId, ctx.user.id, 1);
                await createNotification(
                    ctx.user.id,
                    "approval_requested",
                    `Approval requested for ${label}`,
                    input.comment || `Invoice ${label} submitted for approval`,
                    input.invoiceId
                );
                return { success: true };
            }),
        decide: protectedProcedure
            .input((val: unknown) => ({
                approvalId: Number((val as any).approvalId),
                invoiceId: Number((val as any).invoiceId),
                status: String((val as any).status) as "approved" | "rejected",
                comment: String((val as any).comment || ""),
            }))
            .mutation(async ({ input, ctx }) => {
                const {
                    decideApproval,
                    createNotification,
                    getInvoiceById,
                    updateInvoiceStatus,
                } = await import("./invoiceDb");
                await decideApproval(input.approvalId, input.status, input.comment);

                const invoice = await getInvoiceById(input.invoiceId);
                const label = invoice?.invoiceNumber || `#${input.invoiceId}`;
                const verb = input.status === "approved" ? "approved" : "rejected";

                await createNotification(
                    ctx.user.id,
                    input.status === "approved"
                        ? "approval_granted"
                        : "approval_rejected",
                    `Invoice ${label} ${verb}`,
                    input.comment || `Invoice ${label} has been ${verb}`,
                    input.invoiceId
                );

                // Auto-complete invoice on approval
                if (input.status === "approved") {
                    await updateInvoiceStatus(input.invoiceId, "completed");
                    // Also push to OptimusDB
                    tryPushToOptimusDb(input.invoiceId, ctx.user.id).catch(() => {});
                }

                return { success: true, status: input.status };
            }),

        history: protectedProcedure.query(async ({ ctx }) => {
            const { getApprovalsHistory } = await import("./invoiceDb");
            return getApprovalsHistory(ctx.user.id);
        }),

        exportApproved: protectedProcedure.query(async ({ ctx }) => {
            const { getApprovedInvoicesExport } = await import("./invoiceDb");
            return getApprovedInvoicesExport(ctx.user.id);
        }),

        pendingCount: protectedProcedure.query(async ({ ctx }) => {
            const { getPendingApprovalsCount } = await import("./invoiceDb");
            const count = await getPendingApprovalsCount(ctx.user.id);
            return { count };
        }),

        autoRejectDuplicate: protectedProcedure
            .input((val: unknown) => ({
                approvalId: Number((val as any).approvalId),
                invoiceId: Number((val as any).invoiceId),
            }))
            .mutation(async ({ input, ctx }) => {
                const {
                    decideApproval,
                    createNotification,
                    getInvoiceById,
                    updateInvoiceStatus,
                } = await import("./invoiceDb");
                const invoice = await getInvoiceById(input.invoiceId);
                const label = invoice?.invoiceNumber || `#${input.invoiceId}`;
                await decideApproval(
                    input.approvalId,
                    "rejected",
                    "Auto-rejected: duplicate invoice detected"
                );
                await updateInvoiceStatus(input.invoiceId, "failed");
                await createNotification(
                    ctx.user.id,
                    "approval_rejected",
                    `Duplicate invoice ${label} auto-rejected`,
                    `Invoice ${label} was automatically rejected because a duplicate already exists.`,
                    input.invoiceId
                );
                return { success: true };
            }),
    }),

    // OptimusDB Catalog Integration
    optimusDb: router({
        testConnection: protectedProcedure.mutation(async ({ ctx }) => {
            const { getUserConfiguration } = await import("./invoiceDb");
            const config = await getUserConfiguration(ctx.user.id);
            if (!config?.settingsJson) throw new Error("OptimusDB not configured");

            let settings: any = {};
            try {
                settings = JSON.parse(config.settingsJson);
            } catch {}

            if (!settings.optimusDbApiUrl)
                throw new Error(
                    "OptimusDB API URL is required. Configure it in Settings."
                );

            const { createOptimusDbClient } = await import("./optimusDbClient");
            const client = createOptimusDbClient({
                apiUrl: settings.optimusDbApiUrl,
                authToken: settings.optimusDbAuthToken,
                catalogName: settings.optimusDbCatalog || "invoices",
                nodeId: settings.optimusDbNodeId,
            });

            return client.testConnection();
        }),

        pushInvoice: protectedProcedure
            .input((val: unknown) => ({ invoiceId: Number((val as any).invoiceId) }))
            .mutation(async ({ input, ctx }) => {
                const {
                    getInvoiceById,
                    getLineItemsByInvoiceId,
                    getUserConfiguration,
                } = await import("./invoiceDb");
                const { createOptimusDbClient, buildInvoiceMetadata } = await import(
                    "./optimusDbClient"
                    );

                const invoice = await getInvoiceById(input.invoiceId);
                if (!invoice) throw new Error("Invoice not found");

                const config = await getUserConfiguration(ctx.user.id);
                if (!config?.settingsJson) throw new Error("OptimusDB not configured");

                let settings: any = {};
                try {
                    settings = JSON.parse(config.settingsJson);
                } catch {}
                if (!settings.optimusDbApiUrl)
                    throw new Error("OptimusDB API URL not set");

                const client = createOptimusDbClient({
                    apiUrl: settings.optimusDbApiUrl,
                    authToken: settings.optimusDbAuthToken,
                    catalogName: settings.optimusDbCatalog || "invoices",
                    nodeId: settings.optimusDbNodeId,
                });

                const lineItems = await getLineItemsByInvoiceId(invoice.id);
                let extractedData: any = {};
                try {
                    extractedData = JSON.parse(invoice.extractedData || "{}");
                } catch {}

                const metadata = buildInvoiceMetadata(
                    invoice,
                    extractedData,
                    lineItems,
                    {
                        name: extractedData?.supplier?.name,
                        taxId: extractedData?.supplier?.taxId,
                    }
                );

                return client.pushInvoice(metadata);
            }),

        // Push all completed invoices to OptimusDB
        pushAll: protectedProcedure.mutation(async ({ ctx }) => {
            const {
                getInvoicesByUserId,
                getLineItemsByInvoiceId,
                getUserConfiguration,
            } = await import("./invoiceDb");
            const { createOptimusDbClient, buildInvoiceMetadata } = await import(
                "./optimusDbClient"
                );

            const config = await getUserConfiguration(ctx.user.id);
            if (!config?.settingsJson) throw new Error("OptimusDB not configured");

            let settings: any = {};
            try {
                settings = JSON.parse(config.settingsJson);
            } catch {}
            if (!settings.optimusDbApiUrl)
                throw new Error("OptimusDB API URL not set");

            const client = createOptimusDbClient({
                apiUrl: settings.optimusDbApiUrl,
                authToken: settings.optimusDbAuthToken,
                catalogName: settings.optimusDbCatalog || "invoices",
                nodeId: settings.optimusDbNodeId,
            });

            const invoices = await getInvoicesByUserId(ctx.user.id);
            const completed = invoices.filter((i: any) => i.status === "completed");

            let pushed = 0,
                failed = 0;
            for (const inv of completed) {
                const lineItems = await getLineItemsByInvoiceId(inv.id);
                let extractedData: any = {};
                try {
                    extractedData = JSON.parse(inv.extractedData || "{}");
                } catch {}

                const metadata = buildInvoiceMetadata(inv, extractedData, lineItems, {
                    name: extractedData?.supplier?.name,
                    taxId: extractedData?.supplier?.taxId,
                });

                const result = await client.pushInvoice(metadata);
                if (result.success) pushed++;
                else failed++;
            }

            return { success: true, total: completed.length, pushed, failed };
        }),
    }),
});

export type AppRouter = typeof appRouter;