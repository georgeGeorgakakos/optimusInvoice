import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb } from "./db";
import {
  // Invoice operations
  createInvoice,
  getInvoiceById,
  updateInvoiceStatus,
  deleteInvoiceById,
  // Line item operations — actual API uses `createInvoiceLineItem`
  createInvoiceLineItem,
  getLineItemsByInvoiceId,
  deleteLineItemsByInvoiceId,
  // Supplier operations (needed because FK refs)
  createSupplier,
  // Product mapping — actual API uses `getProductMapping` not `getProductMappingBySupplierCode`
  createProductMapping,
  getProductMapping,
  // Transformation rules — actual API uses `getRulesBySupplierId`
  createTransformationRule,
  getRulesBySupplierId,
  updateRuleUsage,
} from "./invoiceDb";

/**
 * Integration tests for invoice DB operations.
 *
 * Notes:
 *  - All create-* functions return the new row's `insertId` (number), not the
 *    full row object. To assert on row contents we re-read via the get-* fn.
 *  - The `invoices`, `invoiceLineItems`, `productMappings`, and
 *    `transformationRules` tables store numeric fields as `varchar(32)` —
 *    quantity, unitPrice, confidence, etc. are all string-typed in the schema.
 *    `confidence` specifically uses the 0–100 scale ("95", "100"), NOT decimal.
 *  - Tests create their own supplier per-suite to keep foreign keys valid and
 *    clean up after themselves to avoid state leakage between runs.
 */

const TEST_USER_ID = 1;

// Track IDs created during this test run so afterAll can clean them up.
const createdInvoiceIds: number[] = [];
let testSupplierId: number;

describe("Invoice Database Operations", () => {
  beforeAll(async () => {
    const db = await getDb();
    if (!db) {
      throw new Error("Database connection required for tests");
    }

    // Create a single supplier used by tests that need a valid supplierId FK.
    // Code includes a timestamp so re-runs don't collide on the unique(code).
    testSupplierId = await createSupplier({
      code: `TEST-SUP-${Date.now()}`,
      name: "Test Supplier",
      taxId: "EL000000000",
    });
  });

  afterAll(async () => {
    // Best-effort cleanup of invoices (and their line items) created here.
    for (const id of createdInvoiceIds) {
      try {
        await deleteLineItemsByInvoiceId(id);
        await deleteInvoiceById(id);
      } catch {
        // Already gone or DB unreachable — fine for test cleanup.
      }
    }
  });

  describe("Invoice Operations", () => {
    it("creates and retrieves an invoice", async () => {
      const insertId = await createInvoice({
        userId: TEST_USER_ID,
        supplierId: null,
        invoiceNumber: "TEST-001",
        invoiceDate: new Date("2026-01-01"),
        totalAmount: "1000.00",
        currency: "EUR",
        pdfUrl: "https://example.com/invoice.pdf",
        pdfFileKey: "invoices/test-001.pdf",
        status: "pending",
      });

      // createInvoice returns the new row's insertId (number), not the row.
      expect(typeof insertId).toBe("number");
      expect(insertId).toBeGreaterThan(0);
      createdInvoiceIds.push(insertId);

      const retrieved = await getInvoiceById(insertId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.invoiceNumber).toBe("TEST-001");
      expect(retrieved?.status).toBe("pending");
      expect(retrieved?.totalAmount).toBe("1000.00");
      expect(retrieved?.currency).toBe("EUR");
    });

    it("updates invoice status", async () => {
      const insertId = await createInvoice({
        userId: TEST_USER_ID,
        pdfFileKey: "invoices/test-002.pdf",
        status: "pending",
      });
      createdInvoiceIds.push(insertId);

      await updateInvoiceStatus(insertId, "processing");

      const updated = await getInvoiceById(insertId);
      expect(updated?.status).toBe("processing");
      // processedAt is only set for terminal states (completed | failed),
      // so it must still be null after a "processing" transition.
      expect(updated?.processedAt).toBeNull();
    });

    it("marks processedAt when status becomes completed", async () => {
      const insertId = await createInvoice({
        userId: TEST_USER_ID,
        pdfFileKey: "invoices/test-002b.pdf",
        status: "processing",
      });
      createdInvoiceIds.push(insertId);

      await updateInvoiceStatus(insertId, "completed");

      const updated = await getInvoiceById(insertId);
      expect(updated?.status).toBe("completed");
      expect(updated?.processedAt).not.toBeNull();
    });
  });

  describe("Line Item Operations", () => {
    it("creates and retrieves line items", async () => {
      const invoiceId = await createInvoice({
        userId: TEST_USER_ID,
        pdfFileKey: "invoices/test-003.pdf",
        status: "pending",
      });
      createdInvoiceIds.push(invoiceId);

      // Real function name is createInvoiceLineItem. Numeric fields are stored
      // as varchar(32) in the schema, so we pass strings here.
      const lineItemId = await createInvoiceLineItem({
        invoiceId,
        supplierCode: "PROD-001",
        description: "Test Product",
        quantity: "10",
        unitPrice: "50.00",
        netAmount: "500.00",
        vatRate: "24",
        matchStatus: "pending",
      });

      expect(typeof lineItemId).toBe("number");
      expect(lineItemId).toBeGreaterThan(0);

      const items = await getLineItemsByInvoiceId(invoiceId);
      expect(items.length).toBe(1);
      expect(items[0]?.supplierCode).toBe("PROD-001");
      expect(items[0]?.description).toBe("Test Product");
      expect(items[0]?.quantity).toBe("10");
      expect(items[0]?.matchStatus).toBe("pending");
    });

    it("returns empty array for invoice with no line items", async () => {
      const invoiceId = await createInvoice({
        userId: TEST_USER_ID,
        pdfFileKey: "invoices/test-003b.pdf",
        status: "pending",
      });
      createdInvoiceIds.push(invoiceId);

      const items = await getLineItemsByInvoiceId(invoiceId);
      expect(items).toEqual([]);
    });
  });

  describe("Product Mapping Operations", () => {
    it("creates and retrieves product mappings", async () => {
      // Use a unique supplierCode per run so we don't collide with stale data.
      const code = `SUP-PROD-${Date.now()}`;

      // confidence is stored as a varchar on the 0–100 scale (NOT a decimal
      // 0.0–1.0). The schema default is "100".
      const mappingId = await createProductMapping({
        supplierId: testSupplierId,
        supplierCode: code,
        erpCode: "ERP-PROD-001",
        confidence: "95",
      });

      expect(typeof mappingId).toBe("number");
      expect(mappingId).toBeGreaterThan(0);

      // Real function name is getProductMapping (not getProductMappingBySupplierCode).
      const retrieved = await getProductMapping(testSupplierId, code);
      expect(retrieved).toBeDefined();
      expect(retrieved?.erpCode).toBe("ERP-PROD-001");
      expect(retrieved?.supplierCode).toBe(code);
      expect(retrieved?.confidence).toBe("95");
    });

    it("returns undefined for non-existent mapping", async () => {
      const result = await getProductMapping(testSupplierId, "DOES-NOT-EXIST");
      expect(result).toBeUndefined();
    });
  });

  describe("Transformation Rule Operations", () => {
    it("creates and retrieves transformation rules", async () => {
      const ruleId = await createTransformationRule({
        supplierId: testSupplierId,
        ruleType: "prefix_addition",
        pattern: "Add prefix '317-'",
        // confidence is varchar on 0–100 scale, NOT 0.0–1.0 decimal
        confidence: "100",
        examples: JSON.stringify([
          { from: "74245", to: "317-74245" },
          { from: "74333", to: "317-74333" },
        ]),
      });

      expect(typeof ruleId).toBe("number");
      expect(ruleId).toBeGreaterThan(0);

      // Real function name is getRulesBySupplierId.
      const rules = await getRulesBySupplierId(testSupplierId);
      const created = rules.find(r => r.id === ruleId);

      expect(created).toBeDefined();
      expect(created?.ruleType).toBe("prefix_addition");
      expect(created?.pattern).toBe("Add prefix '317-'");
      expect(created?.confidence).toBe("100");
    });

    it("updates rule usage statistics", async () => {
      const ruleId = await createTransformationRule({
        supplierId: testSupplierId,
        ruleType: "suffix_removal",
        pattern: "Remove '-A' suffix",
        confidence: "80",
      });

      // First successful usage
      await updateRuleUsage(ruleId, true);
      let rules = await getRulesBySupplierId(testSupplierId);
      let updated = rules.find(r => r.id === ruleId);

      expect(updated).toBeDefined();
      expect(updated?.usageCount).toBe(1);
      expect(updated?.successCount).toBe(1);
      expect(updated?.lastUsed).not.toBeNull();

      // Second usage — this time unsuccessful: usageCount goes up, successCount does not
      await updateRuleUsage(ruleId, false);
      rules = await getRulesBySupplierId(testSupplierId);
      updated = rules.find(r => r.id === ruleId);

      expect(updated?.usageCount).toBe(2);
      expect(updated?.successCount).toBe(1);
    });
  });
});