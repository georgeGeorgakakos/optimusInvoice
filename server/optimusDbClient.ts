/**
 * OptimusDB Client — Pushes processed invoice metadata to OptimusDB distributed catalog.
 *
 * OptimusDB is a decentralized data catalog for metadata management.
 * This client POSTs invoice records as catalog entries via the REST API.
 */

interface OptimusDbConfig {
  apiUrl: string;       // e.g. "http://localhost:8080/api"
  authToken?: string;   // Bearer token
  catalogName?: string; // Target catalog (default: "invoices")
  nodeId?: string;      // OptimusDB node identifier
}

interface InvoiceMetadata {
  invoiceId: number;
  invoiceNumber: string | null;
  documentType: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  invoiceDate: string | null;
  totalAmount: string | null;
  vatAmount: string | null;
  netAmount: string | null;
  currency: string;
  status: string;
  lineItemCount: number;
  matchedItemCount: number;
  processedAt: string;
  lineItems: Array<{
    supplierCode: string | null;
    description: string | null;
    quantity: string | null;
    unitPrice: string | null;
    netAmount: string | null;
    vatRate: string | null;
    erpCode: string | null;
    matchStatus: string | null;
    matchConfidence: string | null;
  }>;
}

export function createOptimusDbClient(config: OptimusDbConfig) {
  const { apiUrl, authToken, catalogName = "invoices", nodeId } = config;

  if (!apiUrl) throw new Error("OptimusDB API URL is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  if (nodeId) headers["X-Node-Id"] = nodeId;

  return {
    /**
     * Push a processed invoice to the OptimusDB catalog.
     */
    async pushInvoice(metadata: InvoiceMetadata): Promise<{ success: boolean; entryId?: string; error?: string }> {
      try {
        const payload = {
          catalog: catalogName,
          entryType: "invoice",
          metadata: {
            ...metadata,
            source: "optimus-invoice-automation",
            ingestedAt: new Date().toISOString(),
          },
        };

        console.log(`[OptimusDB] Pushing invoice #${metadata.invoiceId} (${metadata.invoiceNumber}) to ${apiUrl}/catalog/entries`);

        const response = await fetch(`${apiUrl}/catalog/entries`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000), // 15s timeout
        });

        if (!response.ok) {
          const errBody = await response.text().catch(() => "");
          console.error(`[OptimusDB] Push failed: ${response.status} ${response.statusText} — ${errBody}`);
          return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
        }

        const result = await response.json().catch(() => ({}));
        console.log(`[OptimusDB] Invoice #${metadata.invoiceId} pushed successfully. Entry ID: ${result.id || result.entryId || "N/A"}`);
        return { success: true, entryId: result.id || result.entryId };
      } catch (err: any) {
        console.error(`[OptimusDB] Push error:`, err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Test the connection to OptimusDB.
     */
    async testConnection(): Promise<{ success: boolean; version?: string; error?: string }> {
      try {
        const response = await fetch(`${apiUrl}/health`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
        }

        const body = await response.json().catch(() => ({}));
        return { success: true, version: body.version || body.status || "OK" };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    /**
     * Query the catalog for existing invoice entries.
     */
    async queryInvoices(filters?: { supplierName?: string; dateFrom?: string; dateTo?: string }): Promise<any[]> {
      try {
        const params = new URLSearchParams({ catalog: catalogName, entryType: "invoice" });
        if (filters?.supplierName) params.set("supplierName", filters.supplierName);
        if (filters?.dateFrom) params.set("dateFrom", filters.dateFrom);
        if (filters?.dateTo) params.set("dateTo", filters.dateTo);

        const response = await fetch(`${apiUrl}/catalog/entries?${params}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) return [];
        const body = await response.json().catch(() => ({ entries: [] }));
        return body.entries || body.data || [];
      } catch {
        return [];
      }
    },
  };
}

/**
 * Helper: Build invoice metadata from DB records for OptimusDB push.
 */
export function buildInvoiceMetadata(
  invoice: any,
  extractedData: any,
  lineItems: any[],
  supplierInfo?: { name?: string; taxId?: string }
): InvoiceMetadata {
  const matchedCount = lineItems.filter((li: any) => li.matchStatus === "matched").length;

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber || extractedData?.invoiceNumber || null,
    documentType: invoice.documentType || extractedData?.documentType || "invoice",
    supplierName: supplierInfo?.name || extractedData?.supplier?.name || null,
    supplierTaxId: supplierInfo?.taxId || extractedData?.supplier?.taxId || null,
    invoiceDate: extractedData?.date || extractedData?.invoiceDate || null,
    totalAmount: invoice.totalAmount || extractedData?.totalAmount || null,
    vatAmount: extractedData?.totalVat || extractedData?.vatAmount || null,
    netAmount: extractedData?.totalNetValue || extractedData?.netAmount || null,
    currency: extractedData?.currency || "EUR",
    status: invoice.status,
    lineItemCount: lineItems.length,
    matchedItemCount: matchedCount,
    processedAt: invoice.processedAt ? new Date(invoice.processedAt).toISOString() : new Date().toISOString(),
    lineItems: lineItems.map((li: any) => ({
      supplierCode: li.supplierCode || null,
      description: li.description || null,
      quantity: li.quantity || null,
      unitPrice: li.unitPrice || null,
      netAmount: li.netAmount || null,
      vatRate: li.vatRate || null,
      erpCode: li.erpCode || null,
      matchStatus: li.matchStatus || null,
      matchConfidence: li.matchConfidence || null,
    })),
  };
}
