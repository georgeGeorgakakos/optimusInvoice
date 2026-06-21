import { eq, desc, and, sql, gt } from "drizzle-orm";
import {
    invoices,
    invoiceLineItems,
    suppliers,
    products,
    productMappings,
    transformationRules,
    configuration,
    notifications,
    approvals,
    users,
    InsertInvoice,
    InsertInvoiceLineItem,
    InsertSupplier,
    InsertProduct,
    InsertProductMapping,
    InsertTransformationRule,
    InsertConfiguration,
} from "../drizzle/schema";
import { getDb } from "./db";

// ============================================================================
// INVOICES
// ============================================================================

export async function createInvoice(invoice: InsertInvoice) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const result = await db.insert(invoices).values(invoice);
    return result[0].insertId;
}

export async function getInvoiceById(id: number) {
    const db = await getDb();
    if (!db) return undefined;

    const result = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, id))
        .limit(1);
    return result[0];
}

export async function getInvoicesByUserId(userId: number) {
    const db = await getDb();
    if (!db) return [];

    return db
        .select({
            id: invoices.id,
            userId: invoices.userId,
            supplierId: invoices.supplierId,
            documentType: invoices.documentType,
            invoiceNumber: invoices.invoiceNumber,
            invoiceDate: invoices.invoiceDate,
            totalAmount: invoices.totalAmount,
            currency: invoices.currency,
            pdfUrl: invoices.pdfUrl,
            pdfFileKey: invoices.pdfFileKey,
            status: invoices.status,
            errorMessage: invoices.errorMessage,
            extractedData: invoices.extractedData,
            createdAt: invoices.createdAt,
            updatedAt: invoices.updatedAt,
            processedAt: invoices.processedAt,
            supplierName: suppliers.name,
            supplierTaxId: suppliers.taxId,
            uploaderName: users.name,
            uploaderEmail: users.email,
        })
        .from(invoices)
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .leftJoin(users, eq(invoices.userId, users.id))
        .where(eq(invoices.userId, userId))
        .orderBy(desc(invoices.createdAt));
}

export async function updateInvoiceStatus(
    id: number,
    status: "pending" | "queued" | "processing" | "completed" | "failed" | "review_needed",
    errorMessage?: string
) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db
        .update(invoices)
        .set({
            status,
            errorMessage,
            processedAt:
                status === "completed" || status === "failed" ? new Date() : undefined,
        })
        .where(eq(invoices.id, id));
}

export async function updateInvoiceExtractedData(
    id: number,
    extractedData: string
) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db.update(invoices).set({ extractedData }).where(eq(invoices.id, id));
}

// ============================================================================
// INVOICE LINE ITEMS
// ============================================================================

export async function createInvoiceLineItem(lineItem: InsertInvoiceLineItem) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const result = await db.insert(invoiceLineItems).values(lineItem);
    return result[0].insertId;
}

export async function getLineItemsByInvoiceId(invoiceId: number) {
    const db = await getDb();
    if (!db) return [];

    return db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId));
}

export async function deleteLineItemsByInvoiceId(invoiceId: number) {
    const db = await getDb();
    if (!db) return;

    await db
        .delete(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId));
}

export async function deleteInvoiceById(id: number) {
    const db = await getDb();
    if (!db) return;

    await db.delete(invoices).where(eq(invoices.id, id));
}

export async function updateInvoiceDocumentType(
    id: number,
    documentType: string
) {
    const db = await getDb();
    if (!db) return;

    await db
        .update(invoices)
        .set({ documentType: documentType as any })
        .where(eq(invoices.id, id));
}

export async function updateLineItemMatch(
    id: number,
    erpCode: string,
    matchStatus: "matched" | "pending" | "manual" | "failed",
    matchConfidence?: string
) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db
        .update(invoiceLineItems)
        .set({ erpCode, matchStatus, matchConfidence })
        .where(eq(invoiceLineItems.id, id));
}

// ============================================================================
// SUPPLIERS
// ============================================================================

export async function createSupplier(supplier: InsertSupplier) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const result = await db.insert(suppliers).values(supplier);
    return result[0].insertId;
}

export async function getSupplierByCode(code: string) {
    const db = await getDb();
    if (!db) return undefined;

    const result = await db
        .select()
        .from(suppliers)
        .where(eq(suppliers.code, code))
        .limit(1);
    return result[0];
}

export async function getAllSuppliers() {
    const db = await getDb();
    if (!db) return [];

    // Fetch base supplier records
    const baseSuppliers = await db.select().from(suppliers).orderBy(suppliers.name);

    // Enrich with issuer data from the most recent processed invoice per supplier
    const enriched = await Promise.all(baseSuppliers.map(async (sup) => {
        try {
            const latestInvoice = await db
                .select({ extractedData: invoices.extractedData })
                .from(invoices)
                .where(eq(invoices.supplierId, sup.id))
                .orderBy(sql`${invoices.processedAt} DESC`)
                .limit(1);

            let issuer: any = null;
            let invoiceCount = 0;

            if (latestInvoice.length > 0 && latestInvoice[0].extractedData) {
                try {
                    const ed = JSON.parse(latestInvoice[0].extractedData);
                    issuer = ed.issuer ?? null;
                } catch {}
            }

            // Count total invoices for this supplier
            const countResult = await db
                .select({ count: sql<number>`count(*)` })
                .from(invoices)
                .where(eq(invoices.supplierId, sup.id));
            invoiceCount = Number(countResult[0]?.count ?? 0);

            return { ...sup, issuer, invoiceCount };
        } catch {
            return { ...sup, issuer: null, invoiceCount: 0 };
        }
    }));

    return enriched;
}

// ============================================================================
// PRODUCTS
// ============================================================================

export async function createProduct(product: InsertProduct) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const result = await db.insert(products).values(product);
    return result[0].insertId;
}

export async function getProductByErpCode(erpCode: string) {
    const db = await getDb();
    if (!db) return undefined;

    const result = await db
        .select()
        .from(products)
        .where(eq(products.erpCode, erpCode))
        .limit(1);
    return result[0];
}

export async function searchProducts(query: string) {
    const db = await getDb();
    if (!db) return [];

    return db
        .select()
        .from(products)
        .where(
            sql`${products.erpCode} LIKE ${`%${query}%`} OR ${products.description} LIKE ${`%${query}%`}`
        )
        .limit(50);
}

// ============================================================================
// PRODUCT MAPPINGS
// ============================================================================

export async function createProductMapping(mapping: InsertProductMapping) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const result = await db.insert(productMappings).values(mapping);
    return result[0].insertId;
}

export async function getProductMapping(
    supplierId: number,
    supplierCode: string
) {
    const db = await getDb();
    if (!db) return undefined;

    const result = await db
        .select()
        .from(productMappings)
        .where(
            and(
                eq(productMappings.supplierId, supplierId),
                eq(productMappings.supplierCode, supplierCode)
            )
        )
        .limit(1);
    return result[0];
}

export async function getMappingsBySupplierId(supplierId: number) {
    const db = await getDb();
    if (!db) return [];

    return db
        .select()
        .from(productMappings)
        .where(eq(productMappings.supplierId, supplierId))
        .orderBy(desc(productMappings.lastUsed));
}

export async function updateMappingUsage(id: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db
        .update(productMappings)
        .set({
            usageCount: sql`${productMappings.usageCount} + 1`,
            lastUsed: new Date(),
        })
        .where(eq(productMappings.id, id));
}

// ============================================================================
// TRANSFORMATION RULES
// ============================================================================

export async function createTransformationRule(rule: InsertTransformationRule) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const result = await db.insert(transformationRules).values(rule);
    return result[0].insertId;
}

export async function getRulesBySupplierId(supplierId: number) {
    const db = await getDb();
    if (!db) return [];

    return db
        .select()
        .from(transformationRules)
        .where(eq(transformationRules.supplierId, supplierId))
        .orderBy(desc(transformationRules.confidence));
}

export async function getAllRules() {
    const db = await getDb();
    if (!db) return [];

    return db
        .select()
        .from(transformationRules)
        .orderBy(desc(transformationRules.confidence));
}

export async function updateRuleUsage(id: number, success: boolean) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const updateData: any = {
        usageCount: sql`${transformationRules.usageCount} + 1`,
        lastUsed: new Date(),
    };

    if (success) {
        updateData.successCount = sql`${transformationRules.successCount} + 1`;
    }

    await db
        .update(transformationRules)
        .set(updateData)
        .where(eq(transformationRules.id, id));
}

// ============================================================================
// CONFIGURATION
// ============================================================================

// ── KNOWLEDGE BASE: Extended mapping/rule functions ──

export async function getAllMappings() {
    const db = await getDb();
    if (!db) return [];
    await ensureErpProductColumns();

    const result = await db.execute(sql`
        SELECT pm.id, pm.supplierId, pm.supplierCode, pm.erpCode, pm.description,
               pm.price, pm.confidence, pm.usageCount, pm.createdAt, pm.updatedAt, pm.lastUsed,
               COALESCE(pm.source, 'manual') AS source,
               s.name AS supplierName, s.taxId AS supplierTaxId
        FROM productMappings pm
                 LEFT JOIN suppliers s ON pm.supplierId = s.id
        ORDER BY pm.updatedAt DESC
    `);
    return (result as any)[0] || result;
}

export async function updateProductMapping(
    id: number,
    data: {
        erpCode?: string;
        description?: string;
        price?: string;
        confidence?: string;
    }
) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db
        .update(productMappings)
        .set({ ...data, updatedAt: new Date() } as any)
        .where(eq(productMappings.id, id));
}

export async function deleteProductMapping(id: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db.delete(productMappings).where(eq(productMappings.id, id));
}

export async function deleteTransformationRule(id: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db.delete(transformationRules).where(eq(transformationRules.id, id));
}

export async function updateTransformationRule(
    id: number,
    data: { pattern?: string; confidence?: string }
) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db
        .update(transformationRules)
        .set({ ...data, updatedAt: new Date() } as any)
        .where(eq(transformationRules.id, id));
}

export async function getMappingsCount() {
    const db = await getDb();
    if (!db) return 0;
    const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(productMappings);
    return result[0]?.count ?? 0;
}

export async function getRulesCount() {
    const db = await getDb();
    if (!db) return 0;
    const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(transformationRules);
    return result[0]?.count ?? 0;
}

export async function getSuppliersCount() {
    const db = await getDb();
    if (!db) return 0;
    const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(suppliers);
    return result[0]?.count ?? 0;
}

// ── EXPORT: Full invoice history with line items ──
export async function getInvoiceExportData(userId: number) {
    const db = await getDb();
    if (!db) return [];

    const allInvoices = await db
        .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            documentType: invoices.documentType,
            status: invoices.status,
            totalAmount: invoices.totalAmount,
            extractedData: invoices.extractedData,
            createdAt: invoices.createdAt,
            processedAt: invoices.processedAt,
            supplierName: suppliers.name,
            supplierTaxId: suppliers.taxId,
        })
        .from(invoices)
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .where(eq(invoices.userId, userId))
        .orderBy(desc(invoices.createdAt));

    // Get line items for each invoice
    const results = [];
    for (const inv of allInvoices) {
        const items = await db
            .select()
            .from(invoiceLineItems)
            .where(eq(invoiceLineItems.invoiceId, inv.id));
        results.push({ ...inv, lineItems: items });
    }
    return results;
}

export async function getUserConfiguration(userId: number) {
    const db = await getDb();
    if (!db) return undefined;

    const result = await db
        .select()
        .from(configuration)
        .where(eq(configuration.userId, userId))
        .limit(1);
    return result[0];
}

export async function upsertConfiguration(config: InsertConfiguration) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const existing = await getUserConfiguration(config.userId);

    if (existing) {
        await db
            .update(configuration)
            .set(config)
            .where(eq(configuration.userId, config.userId));
    } else {
        await db.insert(configuration).values(config);
    }
}

export async function updateConnectionTest(userId: number, success: boolean) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db
        .update(configuration)
        .set({
            connectionTested: success ? 1 : 0,
            lastTestedAt: new Date(),
        })
        .where(eq(configuration.userId, userId));
}

// ============================================================================
// STATISTICS
// ============================================================================

export async function getInvoiceStatistics(userId: number) {
    const db = await getDb();
    if (!db) return null;

    const result = await db
        .select({
            total: sql<number>`COUNT(*)`,
            pending: sql<number>`SUM(CASE WHEN ${invoices.status} = 'pending' THEN 1 ELSE 0 END)`,
            processing: sql<number>`SUM(CASE WHEN ${invoices.status} = 'processing' THEN 1 ELSE 0 END)`,
            completed: sql<number>`SUM(CASE WHEN ${invoices.status} = 'completed' THEN 1 ELSE 0 END)`,
            failed: sql<number>`SUM(CASE WHEN ${invoices.status} = 'failed' THEN 1 ELSE 0 END)`,
            reviewNeeded: sql<number>`SUM(CASE WHEN ${invoices.status} = 'review_needed' THEN 1 ELSE 0 END)`,
        })
        .from(invoices)
        .where(eq(invoices.userId, userId));

    return result[0];
}

export async function getMatchStatistics(userId: number) {
    const db = await getDb();
    if (!db) return null;

    const result = await db
        .select({
            total: sql<number>`COUNT(*)`,
            matched: sql<number>`SUM(CASE WHEN ${invoiceLineItems.matchStatus} = 'matched' THEN 1 ELSE 0 END)`,
            pending: sql<number>`SUM(CASE WHEN ${invoiceLineItems.matchStatus} = 'pending' THEN 1 ELSE 0 END)`,
            manual: sql<number>`SUM(CASE WHEN ${invoiceLineItems.matchStatus} = 'manual' THEN 1 ELSE 0 END)`,
            failed: sql<number>`SUM(CASE WHEN ${invoiceLineItems.matchStatus} = 'failed' THEN 1 ELSE 0 END)`,
        })
        .from(invoiceLineItems)
        .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
        .where(eq(invoices.userId, userId));

    return result[0];
}

// ── ANALYTICS: Daily invoice volume (last 30 days) ──
export async function getDailyInvoiceVolume(userId: number) {
    const db = await getDb();
    if (!db) return [];

    const result = await db
        .select({
            date: sql<string>`DATE_FORMAT(${invoices.createdAt}, '%Y-%m-%d')`.as(
                "date"
            ),
            total: sql<number>`COUNT(*)`.as("total"),
            completed:
                sql<number>`SUM(CASE WHEN ${invoices.status} = 'completed' THEN 1 ELSE 0 END)`.as(
                    "completed"
                ),
            reviewNeeded:
                sql<number>`SUM(CASE WHEN ${invoices.status} = 'review_needed' THEN 1 ELSE 0 END)`.as(
                    "reviewNeeded"
                ),
            failed:
                sql<number>`SUM(CASE WHEN ${invoices.status} = 'failed' THEN 1 ELSE 0 END)`.as(
                    "failed"
                ),
        })
        .from(invoices)
        .where(
            and(
                eq(invoices.userId, userId),
                sql`${invoices.createdAt} >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
            )
        )
        .groupBy(sql`DATE_FORMAT(${invoices.createdAt}, '%Y-%m-%d')`)
        .orderBy(sql`DATE_FORMAT(${invoices.createdAt}, '%Y-%m-%d')`);

    return result;
}

// ── ANALYTICS: Supplier breakdown (top 10 by invoice count) ──
export async function getSupplierBreakdown(userId: number) {
    const db = await getDb();
    if (!db) return [];

    const result = await db
        .select({
            supplierId: invoices.supplierId,
            supplierName: suppliers.name,
            count: sql<number>`COUNT(*)`.as("count"),
            totalItems:
                sql<number>`(SELECT COUNT(*) FROM invoiceLineItems WHERE invoiceLineItems.invoiceId = ${invoices.id})`.as(
                    "totalItems"
                ),
        })
        .from(invoices)
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .where(
            and(eq(invoices.userId, userId), sql`${invoices.supplierId} IS NOT NULL`)
        )
        .groupBy(invoices.supplierId, suppliers.name)
        .orderBy(sql`count DESC`)
        .limit(10);

    return result;
}

// ── ANALYTICS: Recent invoices for activity feed ──
export async function getRecentInvoices(userId: number, limit = 10) {
    const db = await getDb();
    if (!db) return [];

    return db
        .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            status: invoices.status,
            documentType: invoices.documentType,
            totalAmount: invoices.totalAmount,
            createdAt: invoices.createdAt,
            processedAt: invoices.processedAt,
            supplierName: suppliers.name,
            uploaderName: users.name,
        })
        .from(invoices)
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .leftJoin(users, eq(invoices.userId, users.id))
        .where(eq(invoices.userId, userId))
        .orderBy(desc(invoices.createdAt))
        .limit(limit);
}

// ── ANALYTICS: Line items per invoice (for avg calculation) ──
export async function getLineItemCounts(userId: number) {
    const db = await getDb();
    if (!db) return [];

    return db
        .select({
            invoiceId: invoiceLineItems.invoiceId,
            itemCount: sql<number>`COUNT(*)`.as("itemCount"),
            matchedCount:
                sql<number>`SUM(CASE WHEN ${invoiceLineItems.matchStatus} = 'matched' THEN 1 ELSE 0 END)`.as(
                    "matchedCount"
                ),
        })
        .from(invoiceLineItems)
        .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
        .where(eq(invoices.userId, userId))
        .groupBy(invoiceLineItems.invoiceId);
}

// ════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════

export async function ensureNotificationsTable() {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`CREATE TABLE IF NOT EXISTS notifications (
                                                                      id INT AUTO_INCREMENT PRIMARY KEY,
                                                                      userId INT NOT NULL,
                                                                      type VARCHAR(50) NOT NULL,
        title VARCHAR(256) NOT NULL,
        message TEXT,
        invoiceId INT,
        \`read\` INT DEFAULT 0 NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS approvals (
                                                                  id INT AUTO_INCREMENT PRIMARY KEY,
                                                                  invoiceId INT NOT NULL,
                                                                  step INT DEFAULT 1 NOT NULL,
                                                                  status ENUM('pending','approved','rejected') DEFAULT 'pending' NOT NULL,
        requestedById INT NOT NULL,
        assignedToId INT,
        comment TEXT,
        decidedAt TIMESTAMP NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )`);
}

export async function createNotification(
    userId: number,
    type: string,
    title: string,
    message?: string,
    invoiceId?: number
) {
    const db = await getDb();
    if (!db) return;
    await ensureNotificationsTable();
    await db
        .insert(notifications)
        .values({ userId, type, title, message, invoiceId });
}

export async function getNotifications(userId: number, limit = 30) {
    const db = await getDb();
    if (!db) return [];
    await ensureNotificationsTable();
    return db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(limit);
}

export async function getUnreadCount(userId: number) {
    const db = await getDb();
    if (!db) return 0;
    await ensureNotificationsTable();
    const result = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), eq(notifications.read, 0)));
    return result[0]?.count ?? 0;
}

export async function markNotificationRead(id: number) {
    const db = await getDb();
    if (!db) return;
    await db
        .update(notifications)
        .set({ read: 1 })
        .where(eq(notifications.id, id));
}

export async function markAllNotificationsRead(userId: number) {
    const db = await getDb();
    if (!db) return;
    await db
        .update(notifications)
        .set({ read: 1 })
        .where(eq(notifications.userId, userId));
}

// ════════════════════════════════════════════════════════════════════════
// APPROVALS
// ════════════════════════════════════════════════════════════════════════

export async function createApproval(
    invoiceId: number,
    requestedById: number,
    step = 1,
    assignedToId?: number
) {
    const db = await getDb();
    if (!db) return;
    await ensureNotificationsTable();
    await db
        .insert(approvals)
        .values({
            invoiceId,
            step,
            requestedById,
            assignedToId,
            status: "pending",
        });
}

export async function getApprovalsByInvoice(invoiceId: number) {
    const db = await getDb();
    if (!db) return [];
    await ensureNotificationsTable();
    return db
        .select()
        .from(approvals)
        .where(eq(approvals.invoiceId, invoiceId))
        .orderBy(approvals.step);
}

export async function getPendingApprovals(userId: number) {
    const db = await getDb();
    if (!db) return [];
    await ensureNotificationsTable();
    // Pending approvals assigned to this user or unassigned
    const rows = await db
        .select({
            approvalId: approvals.id,
            invoiceId: approvals.invoiceId,
            step: approvals.step,
            status: approvals.status,
            requestedById: approvals.requestedById,
            comment: approvals.comment,
            createdAt: approvals.createdAt,
            invoiceNumber: invoices.invoiceNumber,
            documentType: invoices.documentType,
            totalAmount: invoices.totalAmount,
            supplierId: invoices.supplierId,
            supplierName: suppliers.name,
        })
        .from(approvals)
        .innerJoin(invoices, eq(approvals.invoiceId, invoices.id))
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .where(
            and(
                eq(approvals.status, "pending"),
                sql`(${approvals.assignedToId} = ${userId} OR ${approvals.assignedToId} IS NULL)`
            )
        )
        .orderBy(desc(approvals.createdAt));

    // Attach duplicate flag to each pending approval
    const withDuplicateInfo = await Promise.all(
        rows.map(async row => {
            const dupCheck = await checkInvoiceDuplicate(row.invoiceId);
            return {
                ...row,
                isDuplicate: dupCheck.isDuplicate,
                duplicateInvoiceId: dupCheck.duplicateInvoiceId,
            };
        })
    );

    return withDuplicateInfo;
}

export async function decideApproval(
    approvalId: number,
    status: "approved" | "rejected",
    comment?: string
) {
    const db = await getDb();
    if (!db) return;
    await db
        .update(approvals)
        .set({ status, comment, decidedAt: new Date() })
        .where(eq(approvals.id, approvalId));
}

/** Check if an invoice is a duplicate (same invoice number + supplier already completed/approved) */
export async function checkInvoiceDuplicate(
    invoiceId: number
): Promise<{
    isDuplicate: boolean;
    duplicateInvoiceId?: number;
    duplicateInvoiceNumber?: string;
}> {
    const db = await getDb();
    if (!db) return { isDuplicate: false };

    const invoice = await getInvoiceById(invoiceId);
    if (!invoice?.invoiceNumber || !invoice.supplierId)
        return { isDuplicate: false };

    const existing = await db
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
        .from(invoices)
        .where(
            and(
                eq(invoices.invoiceNumber, invoice.invoiceNumber),
                eq(invoices.supplierId, invoice.supplierId),
                sql`${invoices.id} != ${invoiceId}`,
                sql`${invoices.status} IN ('completed', 'review_needed', 'processing')`
            )
        )
        .limit(1);

    if (existing.length > 0) {
        return {
            isDuplicate: true,
            duplicateInvoiceId: existing[0].id,
            duplicateInvoiceNumber: existing[0].invoiceNumber || undefined,
        };
    }
    return { isDuplicate: false };
}

/** Get approval history (decided approvals) for a user with full invoice details */
export async function getApprovalsHistory(userId: number) {
    const db = await getDb();
    if (!db) return [];
    await ensureNotificationsTable();

    return db
        .select({
            approvalId: approvals.id,
            invoiceId: approvals.invoiceId,
            step: approvals.step,
            status: approvals.status,
            comment: approvals.comment,
            decidedAt: approvals.decidedAt,
            createdAt: approvals.createdAt,
            invoiceNumber: invoices.invoiceNumber,
            documentType: invoices.documentType,
            totalAmount: invoices.totalAmount,
            extractedData: invoices.extractedData,
            supplierName: suppliers.name,
        })
        .from(approvals)
        .innerJoin(invoices, eq(approvals.invoiceId, invoices.id))
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .where(
            and(
                sql`${approvals.status} IN ('approved', 'rejected')`,
                eq(invoices.userId, userId)
            )
        )
        .orderBy(desc(approvals.decidedAt));
}

/** Fast count of pending approvals for sidebar badge */
export async function getPendingApprovalsCount(
    userId: number
): Promise<number> {
    const db = await getDb();
    if (!db) return 0;
    await ensureNotificationsTable();
    const result = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(approvals)
        .innerJoin(invoices, eq(approvals.invoiceId, invoices.id))
        .where(
            and(
                eq(approvals.status, "pending"),
                sql`(${approvals.assignedToId} = ${userId} OR ${approvals.assignedToId} IS NULL)`
            )
        );
    return Number(result[0]?.count ?? 0);
}

/** Get a single invoice with its line items (for JSON export) */
export async function getInvoiceWithLineItems(invoiceId: number) {
    const db = await getDb();
    if (!db) return null;

    const result = await db
        .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            documentType: invoices.documentType,
            status: invoices.status,
            totalAmount: invoices.totalAmount,
            currency: invoices.currency,
            extractedData: invoices.extractedData,
            createdAt: invoices.createdAt,
            processedAt: invoices.processedAt,
            supplierName: suppliers.name,
            supplierTaxId: suppliers.taxId,
            supplierAddress: suppliers.address,
        })
        .from(invoices)
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .where(eq(invoices.id, invoiceId))
        .limit(1);

    if (!result[0]) return null;

    const items = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId));

    return { ...result[0], lineItems: items };
}

// ════════════════════════════════════════════════════════════════════════
// ERP DATA MODEL EDITOR
// ════════════════════════════════════════════════════════════════════════

/** Ensure extra columns exist on the products table (unit, vatRate, active, source). */
export async function ensureErpProductColumns() {
    const db = await getDb();
    if (!db) return;
    const cols = [
        ["unit", "VARCHAR(32) DEFAULT 'ΤΕΜ'"],
        ["vatRate", "VARCHAR(16) DEFAULT '24'"],
        ["active", "INT DEFAULT 1"],
        ["source", "VARCHAR(32) DEFAULT 'manual'"], // manual, csv_import, erp_sync
    ];
    for (const [name, def] of cols) {
        await db
            .execute(
                sql.raw(
                    `ALTER TABLE products ADD COLUMN IF NOT EXISTS \`${name}\` ${def}`
                )
            )
            .catch(() => {});
    }
    // Also ensure productMappings has source column
    await db
        .execute(
            sql.raw(
                `ALTER TABLE productMappings ADD COLUMN IF NOT EXISTS \`source\` VARCHAR(32) DEFAULT 'manual'`
            )
        )
        .catch(() => {});
}

/** Get all ERP products with pagination, search, category filter. */
export async function getAllErpProducts(
    opts: {
        search?: string;
        category?: string;
        page?: number;
        pageSize?: number;
        activeOnly?: boolean;
    } = {}
) {
    const db = await getDb();
    if (!db) return { rows: [], total: 0 };
    await ensureErpProductColumns();

    const { search, category, page = 1, pageSize = 50, activeOnly } = opts;
    const conditions: any[] = [];
    if (search) {
        conditions.push(
            sql`(${products.erpCode} LIKE ${`%${search}%`} OR ${products.description} LIKE ${`%${search}%`})`
        );
    }
    if (category && category !== "all") {
        conditions.push(eq(products.category, category));
    }
    if (activeOnly) {
        conditions.push(sql`active = 1`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countResult] = await Promise.all([
        db
            .select()
            .from(products)
            .where(whereClause)
            .orderBy(products.erpCode)
            .limit(pageSize)
            .offset((page - 1) * pageSize),
        db
            .select({ count: sql<number>`COUNT(*)` })
            .from(products)
            .where(whereClause),
    ]);

    return { rows, total: countResult[0]?.count ?? 0 };
}

/** Get product categories. */
export async function getProductCategories() {
    const db = await getDb();
    if (!db) return [];
    const result = await db
        .selectDistinct({ category: products.category })
        .from(products)
        .where(sql`${products.category} IS NOT NULL AND ${products.category} != ''`)
        .orderBy(products.category);
    return result.map(r => r.category).filter(Boolean);
}

/** Upsert a single product. */
export async function upsertErpProduct(data: {
    erpCode: string;
    description?: string;
    price?: string;
    category?: string;
    unit?: string;
    vatRate?: string;
    active?: boolean;
    source?: string;
}) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    await ensureErpProductColumns();

    const existing = await getProductByErpCode(data.erpCode);
    if (existing) {
        await db.execute(sql`UPDATE products SET
                                                 description = ${data.description ?? existing.description},
                                                 price = ${data.price ?? existing.price},
                                                 category = ${data.category ?? existing.category},
                                                 unit = ${data.unit ?? "ΤΕΜ"},
                                                 vatRate = ${data.vatRate ?? "24"},
                                                 active = ${data.active !== false ? 1 : 0},
                                                 source = ${data.source ?? "manual"},
                                                 updatedAt = NOW()
                             WHERE id = ${existing.id}`);
        return { id: existing.id, created: false };
    } else {
        const result =
            await db.execute(sql`INSERT INTO products (erpCode, description, price, category, unit, vatRate, active, source)
                                 VALUES (${data.erpCode}, ${data.description ?? null}, ${data.price ?? null}, ${data.category ?? null},
                                         ${data.unit ?? "ΤΕΜ"}, ${data.vatRate ?? "24"}, ${data.active !== false ? 1 : 0}, ${data.source ?? "manual"})`);
        return { id: (result as any)[0]?.insertId, created: true };
    }
}

/** Delete an ERP product by ID. */
export async function deleteErpProduct(id: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    await db.delete(products).where(eq(products.id, id));
}

/** Bulk import products. Returns { created, updated, errors }. */
export async function bulkImportProducts(
    items: Array<{
        erpCode: string;
        description?: string;
        price?: string;
        category?: string;
        unit?: string;
        vatRate?: string;
    }>,
    source = "csv_import"
) {
    let created = 0,
        updated = 0,
        errors = 0;
    for (const item of items) {
        try {
            const result = await upsertErpProduct({ ...item, source });
            if (result.created) created++;
            else updated++;
        } catch {
            errors++;
        }
    }
    return { created, updated, errors, total: items.length };
}

/** Get ERP Data Model stats. */
export async function getErpModelStats() {
    const db = await getDb();
    if (!db)
        return { totalProducts: 0, totalMappings: 0, categories: 0, unmapped: 0 };
    await ensureErpProductColumns();

    const [prodCount, mapCount, catCount, unmappedResult] = await Promise.all([
        db
            .select({ c: sql<number>`COUNT(*)` })
            .from(products)
            .where(sql`active = 1`),
        db.select({ c: sql<number>`COUNT(*)` }).from(productMappings),
        db
            .select({ c: sql<number>`COUNT(DISTINCT category)` })
            .from(products)
            .where(sql`category IS NOT NULL AND category != ''`),
        // Unmapped = line items with matchStatus='pending' from the last 30 days, distinct supplierCodes
        db
            .select({ c: sql<number>`COUNT(DISTINCT supplierCode)` })
            .from(invoiceLineItems)
            .where(
                and(
                    eq(invoiceLineItems.matchStatus, "pending"),
                    sql`${invoiceLineItems.createdAt} >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
                )
            ),
    ]);

    return {
        totalProducts: prodCount[0]?.c ?? 0,
        totalMappings: mapCount[0]?.c ?? 0,
        categories: catCount[0]?.c ?? 0,
        unmapped: unmappedResult[0]?.c ?? 0,
    };
}

/** Get unmapped supplier items (supplier codes that appeared on invoices but have no mapping). */
export async function getUnmappedItems(limit = 50) {
    const db = await getDb();
    if (!db) return [];

    return db.execute(sql`
        SELECT li.supplierCode, li.description, COUNT(*) AS occurrences,
               MAX(li.createdAt) AS lastSeen, s.name AS supplierName
        FROM invoiceLineItems li
                 INNER JOIN invoices inv ON li.invoiceId = inv.id
                 LEFT JOIN suppliers s ON inv.supplierId = s.id
                 LEFT JOIN productMappings pm ON pm.supplierCode = li.supplierCode AND pm.supplierId = inv.supplierId
        WHERE li.matchStatus = 'pending' AND pm.id IS NULL AND li.supplierCode IS NOT NULL AND li.supplierCode != ''
        GROUP BY li.supplierCode, li.description, s.name
        ORDER BY occurrences DESC, lastSeen DESC
            LIMIT ${limit}
    `);
}

/** Get mapping count per ERP product. */
export async function getMappingCountByErpCode() {
    const db = await getDb();
    if (!db) return [];
    return db
        .select({
            erpCode: productMappings.erpCode,
            count: sql<number>`COUNT(*)`,
        })
        .from(productMappings)
        .groupBy(productMappings.erpCode);
}

/** Get auto-match rate (% of line items matched automatically in the last 30 days). */
export async function getAutoMatchRate() {
    const db = await getDb();
    if (!db) return 0;
    const result = await db.execute(sql`
        SELECT
            SUM(CASE WHEN matchStatus = 'matched' THEN 1 ELSE 0 END) AS matched,
            COUNT(*) AS total
        FROM invoiceLineItems
        WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);
    const row = (result as any)[0]?.[0];
    if (!row || !row.total || row.total === 0) return 0;
    return Math.round((row.matched / row.total) * 100);
}

/**
 * Export all approved invoices with full line item data.
 * Returns one record per invoice, with lineItems[] nested.
 * Used by the Approvals page export button.
 */
export async function getApprovedInvoicesExport(userId: number) {
    const db = await getDb();
    if (!db) return [];

    // Fetch all approved invoices for this user
    const approvedInvoices = await db
        .select({
            approvalId:      approvals.id,
            approvedAt:      approvals.decidedAt,
            approvalComment: approvals.comment,
            invoiceId:       invoices.id,
            invoiceNumber:   invoices.invoiceNumber,
            documentType:    invoices.documentType,
            invoiceDate:     invoices.invoiceDate,
            totalAmount:     invoices.totalAmount,
            currency:        invoices.currency,
            status:          invoices.status,
            extractedData:   invoices.extractedData,
            pdfUrl:          invoices.pdfUrl,
            processedAt:     invoices.processedAt,
            createdAt:       invoices.createdAt,
            supplierName:    suppliers.name,
            supplierCode:    suppliers.code,
            supplierTaxId:   suppliers.taxId,
            supplierAddress: suppliers.address,
        })
        .from(approvals)
        .innerJoin(invoices, eq(approvals.invoiceId, invoices.id))
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .where(
            and(
                eq(approvals.status, "approved"),
                eq(invoices.userId, userId)
            )
        )
        .orderBy(desc(approvals.decidedAt));

    // Attach line items to each invoice
    const results = [];
    for (const inv of approvedInvoices) {
        const items = await db
            .select()
            .from(invoiceLineItems)
            .where(eq(invoiceLineItems.invoiceId, inv.invoiceId));

        let extractedData: any = {};
        try { extractedData = JSON.parse(inv.extractedData || "{}"); } catch {}

        results.push({
            // Approval metadata
            approvalId:      inv.approvalId,
            approvedAt:      inv.approvedAt,
            approvalComment: inv.approvalComment,
            // Invoice header
            invoiceId:       inv.invoiceId,
            invoiceNumber:   inv.invoiceNumber,
            documentType:    inv.documentType,
            invoiceDate:     extractedData.invoiceDate || extractedData.date || inv.invoiceDate,
            totalAmount:     inv.totalAmount,
            currency:        inv.currency || "EUR",
            status:          inv.status,
            processedAt:     inv.processedAt,
            createdAt:       inv.createdAt,
            pdfUrl:          inv.pdfUrl,
            // Supplier
            supplier: {
                name:    inv.supplierName,
                code:    inv.supplierCode,
                taxId:   inv.supplierTaxId,
                address: inv.supplierAddress,
                vatNumber: extractedData.supplierVatNumber,
            },
            // Financial summary from extraction
            financials: {
                subtotal:      extractedData.subtotal,
                vatAmount:     extractedData.vatAmount,
                totalAmount:   inv.totalAmount,
                payableAmount: extractedData.payableAmount,
                withholdingTax: extractedData.withholdingTax,
            },
            // Line items (matched + unmatched)
            lineItems: items.map(li => ({
                lineNumber:     li.lineNumber,
                supplierCode:   li.supplierCode,
                erpCode:        li.erpCode,
                description:    li.description,
                quantity:       li.quantity,
                unit:           li.unit,
                unitPrice:      li.unitPrice,
                discount1:      li.discount1,
                discount2:      li.discount2,
                discount3:      li.discount3,
                netAmount:      li.netAmount,
                vatRate:        li.vatRate,
                vatAmount:      li.vatAmount,
                totalWithVat:   li.totalWithVat,
                matchStatus:    li.matchStatus,
                matchConfidence: li.matchConfidence,
            })),
        });
    }

    return results;
}

// ════════════════════════════════════════════════════════════════════════
// PROCESSING QUEUE  (append-only block — added for the persistent queue feature)
// ════════════════════════════════════════════════════════════════════════
//
// These functions back the MySQL-as-queue design. They rely on the queue columns
// added to the `invoices` table in drizzle/schema.ts (queuedAt, startedAt,
// progress, engine, retryCount, batchId, priority) and the 'queued' status enum
// value. Run `pnpm db:push` after updating the schema so these columns exist.
//
// Atomic claim uses MySQL 8.0 `FOR UPDATE SKIP LOCKED` inside a transaction so
// multiple worker loops (future GPU/concurrency) never grab the same invoice.

/**
 * Place an invoice into the processing queue.
 * Sets status='queued', stamps queuedAt, clears any prior error, and (optionally)
 * tags it with a batchId. Leaves retryCount as-is (use requeueInvoice(reset=true)
 * to also reset attempts).
 */
export async function enqueueInvoice(invoiceId: number, batchId?: string) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    await db
        .update(invoices)
        .set({
            status: "queued",
            queuedAt: new Date(),
            startedAt: null,
            progress: "Queued",
            errorMessage: null,
            ...(batchId ? { batchId } : {}),
        } as any)
        .where(eq(invoices.id, invoiceId));
}

/**
 * Atomically claim the next queued invoice for processing.
 * Uses FOR UPDATE SKIP LOCKED so concurrent workers never collide. Orders by
 * priority asc, then queuedAt asc (FIFO within a priority). On claim, flips the
 * row to 'processing', stamps startedAt, and increments retryCount.
 * Returns { id, userId } or null if the queue is empty.
 */
export async function claimNextQueuedInvoice(): Promise<{ id: number; userId: number } | null> {
    const db = await getDb();
    if (!db) return null;

    let claimed: { id: number; userId: number } | null = null;

    await db.transaction(async (tx: any) => {
        // Select-and-lock the next queued row, skipping rows locked by other workers.
        const rows: any = await tx.execute(sql`
            SELECT id, userId
            FROM invoices
            WHERE status = 'queued'
            ORDER BY priority ASC, queuedAt ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `);

        // mysql2 returns [rows, fields]; drizzle's execute may return rows directly.
        // Normalise defensively.
        const list = Array.isArray(rows)
            ? (Array.isArray(rows[0]) ? rows[0] : rows)
            : (rows?.rows ?? []);
        const row = list && list.length > 0 ? list[0] : null;
        if (!row) return; // queue empty

        const id = Number(row.id);
        const userId = Number(row.userId);

        await tx.execute(sql`
            UPDATE invoices
            SET status = 'processing',
                startedAt = NOW(),
                retryCount = retryCount + 1,
                progress = 'Starting'
            WHERE id = ${id}
        `);

        claimed = { id, userId };
    });

    return claimed;
}

/** Persist a live progress string for the queue UI (best-effort, non-throwing on no-db). */
export async function setInvoiceProgress(invoiceId: number, progress: string) {
    const db = await getDb();
    if (!db) return;
    await db
        .update(invoices)
        .set({ progress: progress.slice(0, 256) } as any)
        .where(eq(invoices.id, invoiceId));
}

/** Record which extraction engine ran (shown in the queue/detail UI). */
export async function setInvoiceEngine(invoiceId: number, engine: string) {
    const db = await getDb();
    if (!db) return;
    await db
        .update(invoices)
        .set({ engine: engine.slice(0, 64) } as any)
        .where(eq(invoices.id, invoiceId));
}

/** Final-fail an invoice: status='failed', store error, stamp processedAt. */
export async function markInvoiceFailed(invoiceId: number, errorMessage: string) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    await db
        .update(invoices)
        .set({
            status: "failed",
            errorMessage: errorMessage?.slice(0, 2000) ?? "Unknown error",
            progress: null,
            processedAt: new Date(),
        } as any)
        .where(eq(invoices.id, invoiceId));
}

/**
 * Re-queue an invoice for another attempt.
 * @param reset when true, also zeroes retryCount (used by the manual "Retry"
 *              button so a previously-exhausted invoice gets a fresh budget).
 *              When false (worker auto-retry) retryCount is preserved so the cap
 *              still applies.
 */
export async function requeueInvoice(invoiceId: number, reset = false) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    await db
        .update(invoices)
        .set({
            status: "queued",
            queuedAt: new Date(),
            startedAt: null,
            progress: "Re-queued",
            errorMessage: null,
            ...(reset ? { retryCount: 0 } : {}),
        } as any)
        .where(eq(invoices.id, invoiceId));
}

/**
 * Re-queue an invoice WITHOUT counting a retry (used for transient "VLM warming
 * up" defers). Two differences from requeueInvoice:
 *   1. Refreshes queuedAt to NOW → the row goes to the BACK of the FIFO
 *      (claimNextQueuedInvoice orders by queuedAt ASC), so other invoices get a
 *      turn while vlm finishes loading.
 *   2. DECREMENTS retryCount by 1 (floored at 0) to neutralise the increment
 *      that claimNextQueuedInvoice applied on claim — so repeated warm-up
 *      deferrals never accumulate toward WORKER_MAX_RETRIES.
 */
export async function requeueInvoiceNoPenalty(invoiceId: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    await db.execute(sql`
        UPDATE invoices
        SET status = 'queued',
            queuedAt = NOW(),
            startedAt = NULL,
            progress = 'Waiting for VLM service…',
            errorMessage = NULL,
            retryCount = GREATEST(retryCount - 1, 0)
        WHERE id = ${invoiceId}
    `);
}

/**
 * Cancel a still-queued invoice (back to 'pending'). Returns true if a row was
 * actually moved (i.e. it was still 'queued'); false if it had already been
 * claimed (status='processing') or wasn't queued — those can't be cancelled here.
 */
export async function cancelQueuedInvoice(invoiceId: number): Promise<boolean> {
    const db = await getDb();
    if (!db) return false;
    const res: any = await db.execute(sql`
        UPDATE invoices
        SET status = 'pending', queuedAt = NULL, progress = NULL, batchId = NULL
        WHERE id = ${invoiceId} AND status = 'queued'
    `);
    // mysql2 returns affectedRows on the result header.
    const header = Array.isArray(res) ? res[0] : res;
    const affected = Number(header?.affectedRows ?? header?.rowsAffected ?? 0);
    return affected > 0;
}

/**
 * Startup recovery: rescue invoices stranded at 'processing' (server crash/restart
 * or a browser-killed request under the old inline model). Those under the retry
 * cap are re-queued; those over it are failed. Returns counts.
 */
export async function recoverOrphanedProcessing(
    maxRetries = 3
): Promise<{ requeued: number; failed: number }> {
    const db = await getDb();
    if (!db) return { requeued: 0, failed: 0 };

    // Re-queue those still within the retry budget.
    const reqRes: any = await db.execute(sql`
        UPDATE invoices
        SET status = 'queued', startedAt = NULL, progress = 'Recovered after restart', errorMessage = NULL
        WHERE status = 'processing' AND retryCount < ${maxRetries}
    `);
    const reqHeader = Array.isArray(reqRes) ? reqRes[0] : reqRes;
    const requeued = Number(reqHeader?.affectedRows ?? reqHeader?.rowsAffected ?? 0);

    // Fail those that have exhausted retries.
    const failRes: any = await db.execute(sql`
        UPDATE invoices
        SET status = 'failed', progress = NULL,
            errorMessage = 'Processing interrupted (exhausted retries after restart)',
            processedAt = NOW()
        WHERE status = 'processing' AND retryCount >= ${maxRetries}
    `);
    const failHeader = Array.isArray(failRes) ? failRes[0] : failRes;
    const failed = Number(failHeader?.affectedRows ?? failHeader?.rowsAffected ?? 0);

    return { requeued, failed };
}

/**
 * Snapshot of the queue for one user, for the ProcessingQueue page + sidebar badge.
 * Returns:
 *   counts   — { queued, processing, completed, failed, review_needed, pending }
 *   active   — queued + processing rows (with supplierName, progress, engine, times)
 *   recent   — last ~15 finished rows (completed/failed/review_needed)
 *   batches  — per-batchId progress { batchId, total, done, failed }
 */
export async function getQueueStatus(userId: number) {
    const db = await getDb();
    if (!db) {
        return { counts: {}, active: [], recent: [], batches: [] };
    }

    // ── Counts by status ──
    const countRows = await db
        .select({
            status: invoices.status,
            count: sql<number>`COUNT(*)`,
        })
        .from(invoices)
        .where(eq(invoices.userId, userId))
        .groupBy(invoices.status);

    const counts: Record<string, number> = {};
    for (const r of countRows as any[]) counts[r.status] = Number(r.count);

    // ── Active (queued + processing) ──
    const active = await db
        .select({
            id: invoices.id,
            status: invoices.status,
            invoiceNumber: invoices.invoiceNumber,
            pdfFileKey: invoices.pdfFileKey,
            progress: invoices.progress,
            engine: invoices.engine,
            retryCount: invoices.retryCount,
            queuedAt: invoices.queuedAt,
            startedAt: invoices.startedAt,
            batchId: invoices.batchId,
            supplierName: suppliers.name,
        })
        .from(invoices)
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .where(
            and(
                eq(invoices.userId, userId),
                sql`${invoices.status} IN ('queued','processing')`
            )
        )
        .orderBy(
            sql`FIELD(${invoices.status}, 'processing','queued')`,
            invoices.priority,
            invoices.queuedAt
        );

    // ── Recently finished ──
    const recent = await db
        .select({
            id: invoices.id,
            status: invoices.status,
            invoiceNumber: invoices.invoiceNumber,
            pdfFileKey: invoices.pdfFileKey,
            engine: invoices.engine,
            errorMessage: invoices.errorMessage,
            startedAt: invoices.startedAt,
            processedAt: invoices.processedAt,
            supplierName: suppliers.name,
        })
        .from(invoices)
        .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
        .where(
            and(
                eq(invoices.userId, userId),
                sql`${invoices.status} IN ('completed','failed','review_needed')`
            )
        )
        .orderBy(desc(invoices.processedAt))
        .limit(15);

    // ── Per-batch progress ──
    const batchRows = await db
        .select({
            batchId: invoices.batchId,
            total: sql<number>`COUNT(*)`,
            done: sql<number>`SUM(CASE WHEN ${invoices.status} IN ('completed','review_needed') THEN 1 ELSE 0 END)`,
            failed: sql<number>`SUM(CASE WHEN ${invoices.status} = 'failed' THEN 1 ELSE 0 END)`,
        })
        .from(invoices)
        .where(
            and(eq(invoices.userId, userId), sql`${invoices.batchId} IS NOT NULL`)
        )
        .groupBy(invoices.batchId)
        // Only batches that still have unfinished work, newest-ish first.
        .orderBy(desc(sql`MAX(${invoices.queuedAt})`));

    const batches = (batchRows as any[])
        .map(b => ({
            batchId: b.batchId,
            total: Number(b.total),
            done: Number(b.done),
            failed: Number(b.failed),
        }))
        .filter(b => b.done + b.failed < b.total); // hide fully-finished batches

    return { counts, active, recent, batches };
}