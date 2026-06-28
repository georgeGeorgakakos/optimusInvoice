import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Suppliers table - stores supplier information from invoices
 */
export const suppliers = mysqlTable("suppliers", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: text("name").notNull(),
  taxId: varchar("taxId", { length: 64 }),
  address: text("address"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Supplier = typeof suppliers.$inferSelect;
export type InsertSupplier = typeof suppliers.$inferInsert;

/**
 * Products table - stores ERP product information
 */
export const products = mysqlTable("products", {
  id: int("id").autoincrement().primaryKey(),
  erpCode: varchar("erpCode", { length: 128 }).notNull().unique(),
  description: text("description"),
  price: varchar("price", { length: 32 }),
  category: varchar("category", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

/**
 * Invoices table - stores uploaded invoice information
 *
 * QUEUE EXTENSION (processing queue feature):
 *   The columns below the original set power the persistent processing queue.
 *   Instead of processing inline (blocking the HTTP request, lost on browser
 *   close), invoices are enqueued (status='queued') and a background worker
 *   picks them up. The new columns let the UI show live progress and let a
 *   returning user see where each invoice stands without re-starting anything.
 *
 *   status flow:  pending ──enqueue──▶ queued ──worker claims──▶ processing
 *                 ──▶ completed | review_needed | failed
 *   (pending is kept for backward-compat: freshly uploaded, not yet enqueued.)
 */
export const invoices = mysqlTable("invoices", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  supplierId: int("supplierId"),
  documentType: mysqlEnum("documentType", ["invoice", "credit_note", "cmr", "dispatch_note"]).default("invoice").notNull(),
  invoiceNumber: varchar("invoiceNumber", { length: 128 }),
  invoiceDate: timestamp("invoiceDate"),
  totalAmount: varchar("totalAmount", { length: 32 }),
  currency: varchar("currency", { length: 8 }).default("EUR"),
  pdfUrl: text("pdfUrl"),
  pdfFileKey: varchar("pdfFileKey", { length: 512 }),
  // 'queued' added to the enum so an invoice can sit in the queue waiting for the
  // worker, distinct from 'pending' (uploaded but not yet submitted to the queue)
  // and 'processing' (a worker is actively extracting it right now).
  status: mysqlEnum("status", ["pending", "queued", "processing", "completed", "failed", "review_needed"]).default("pending").notNull(),
  errorMessage: text("errorMessage"),
  extractedData: text("extractedData"), // JSON string of extracted invoice data
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  processedAt: timestamp("processedAt"),

  // ── Processing-queue columns ────────────────────────────────────────────
  // When the invoice entered the queue (status set to 'queued'). Used to order
  // the queue FIFO and to show "queued 5 min ago" in the UI.
  queuedAt: timestamp("queuedAt"),
  // When a worker claimed it and began extraction (status -> 'processing').
  // Used to compute elapsed processing time and detect stuck/orphaned jobs.
  startedAt: timestamp("startedAt"),
  // Human-readable progress string the worker updates as it goes, e.g.
  // "Downloading PDF", "OCR page 2/5", "Matching line items". The UI shows it
  // verbatim so the user sees live movement instead of a frozen spinner.
  progress: varchar("progress", { length: 256 }),
  // Which extraction engine actually ran (surya | qwen_vl_local | gemma_vl_local).
  // Recorded so the queue/detail UI can show what produced the result.
  engine: varchar("engine", { length: 64 }),
  // How many times this invoice has been (re)tried by the worker. Lets the
  // worker auto-retry transient failures up to a cap, and the UI show attempts.
  retryCount: int("retryCount").default(0).notNull(),
  // Groups invoices uploaded together as one batch (a UUID-ish string). The UI
  // shows per-batch progress ("Batch: 7/20 done"). Null for single uploads.
  batchId: varchar("batchId", { length: 64 }),
  // Lower number = higher priority for the worker claim order. Default 100.
  // Reserved for future "process this one first" UX; FIFO within same priority.
  priority: int("priority").default(100).notNull(),
  // ── Live processing timeline ───────────────────────────────────────────────
  // JSON array of structured pipeline steps the worker appends as it runs, e.g.
  //   [{ stage, engine, path, status, reasoning, at }]
  // Drives the ProcessingTimeline component on the Invoice Details page so the
  // user sees each stage, which engine ran, and WHY a route was chosen — live.
  // Distinct from `progress` (a single human-readable line); this is the full trace.
  processingSteps: text("processingSteps"),
});

export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = typeof invoices.$inferInsert;

/**
 * Invoice line items - stores individual products from invoices
 */
export const invoiceLineItems = mysqlTable("invoiceLineItems", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoiceId").notNull(),
  lineNumber: int("lineNumber"),
  supplierCode: varchar("supplierCode", { length: 128 }),
  erpCode: varchar("erpCode", { length: 128 }),
  description: text("description"),
  quantity: varchar("quantity", { length: 32 }),
  unit: varchar("unit", { length: 32 }),
  unitPrice: varchar("unitPrice", { length: 32 }),
  discount1: varchar("discount1", { length: 32 }),
  discount2: varchar("discount2", { length: 32 }),
  discount3: varchar("discount3", { length: 32 }),
  netAmount: varchar("netAmount", { length: 32 }),
  vatRate: varchar("vatRate", { length: 32 }),
  vatAmount: varchar("vatAmount", { length: 32 }),
  totalWithVat: varchar("totalWithVat", { length: 32 }),
  matchStatus: mysqlEnum("matchStatus", ["matched", "pending", "manual", "failed"]).default("pending").notNull(),
  matchConfidence: varchar("matchConfidence", { length: 8 }), // 0-100
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type InsertInvoiceLineItem = typeof invoiceLineItems.$inferInsert;

/**
 * Product mappings - stores supplier code to ERP code mappings
 */
export const productMappings = mysqlTable("productMappings", {
  id: int("id").autoincrement().primaryKey(),
  supplierId: int("supplierId").notNull(),
  supplierCode: varchar("supplierCode", { length: 128 }).notNull(),
  erpCode: varchar("erpCode", { length: 128 }).notNull(),
  description: text("description"),
  price: varchar("price", { length: 32 }),
  confidence: varchar("confidence", { length: 8 }).default("100"), // 0-100
  usageCount: int("usageCount").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastUsed: timestamp("lastUsed"),
});

export type ProductMapping = typeof productMappings.$inferSelect;
export type InsertProductMapping = typeof productMappings.$inferInsert;

/**
 * Transformation rules - stores learned code transformation patterns
 */
export const transformationRules = mysqlTable("transformationRules", {
  id: int("id").autoincrement().primaryKey(),
  supplierId: int("supplierId").notNull(),
  ruleType: mysqlEnum("ruleType", [
    "prefix_addition",
    "suffix_addition",
    "prefix_removal",
    "suffix_removal",
    "separator_removal",
    "character_replacement",
    "regex_pattern"
  ]).notNull(),
  pattern: varchar("pattern", { length: 256 }).notNull(),
  confidence: varchar("confidence", { length: 8 }).default("0").notNull(), // 0-100
  usageCount: int("usageCount").default(0).notNull(),
  successCount: int("successCount").default(0).notNull(),
  examples: text("examples"), // JSON array of example transformations
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastUsed: timestamp("lastUsed"),
});

export type TransformationRule = typeof transformationRules.$inferSelect;
export type InsertTransformationRule = typeof transformationRules.$inferInsert;

/**
 * Configuration - stores Softone API and system settings
 */
export const configuration = mysqlTable("configuration", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  // ERP type selection
  erpType: varchar("erpType", { length: 32 }).default("softone"),
  // Softone fields
  softoneApiUrl: varchar("softoneApiUrl", { length: 512 }),
  softoneUsername: varchar("softoneUsername", { length: 128 }),
  softonePassword: text("softonePassword"), // Should be encrypted
  softoneClientId: varchar("softoneClientId", { length: 128 }),
  softoneAppId: varchar("softoneAppId", { length: 128 }),
  softoneCompany: varchar("softoneCompany", { length: 128 }),
  softoneBranch: varchar("softoneBranch", { length: 128 }),
  softoneModule: varchar("softoneModule", { length: 128 }),
  softoneRefId: varchar("softoneRefId", { length: 128 }),
  fiscalYear: varchar("fiscalYear", { length: 8 }).default("2026"),
  connectionTested: int("connectionTested").default(0).notNull(), // boolean
  lastTestedAt: timestamp("lastTestedAt"),
  // Extensible JSON settings for ERP connectors, extraction, ML, notifications
  settingsJson: text("settingsJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Configuration = typeof configuration.$inferSelect;
export type InsertConfiguration = typeof configuration.$inferInsert;

/**
 * Notifications — bell notifications for review, approvals, errors
 */
export const notifications = mysqlTable("notifications", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("userId").notNull(),
  type: varchar("type", { length: 50 }).notNull(), // review_needed, approval_requested, approval_granted, approval_rejected, processing_complete, processing_failed
  title: varchar("title", { length: 256 }).notNull(),
  message: text("message"),
  invoiceId: int("invoiceId"),
  read: int("read").default(0).notNull(), // boolean
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Notification = typeof notifications.$inferSelect;

/**
 * Approvals — multi-step approval chain for invoices
 */
export const approvals = mysqlTable("approvals", {
  id: int("id").primaryKey().autoincrement(),
  invoiceId: int("invoiceId").notNull(),
  step: int("step").default(1).notNull(), // 1=review, 2=approve, 3=final
  status: mysqlEnum("status", ["pending", "approved", "rejected"]).default("pending").notNull(),
  requestedById: int("requestedById").notNull(),
  assignedToId: int("assignedToId"), // null = any user can act
  comment: text("comment"),
  decidedAt: timestamp("decidedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Approval = typeof approvals.$inferSelect;