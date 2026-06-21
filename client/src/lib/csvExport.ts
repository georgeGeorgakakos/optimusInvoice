/**
 * csvExport.ts
 *
 * METRO PoC §4 — 32-column invoice CSV export.
 *
 * Single source of truth for the column layout, so any page can produce
 * the same export. The previous InvoiceList.tsx export covered ~18 of
 * these fields; this expands to the full PoC schema including myDATA,
 * dispatch fields, and the supplier-side enrichment.
 *
 * Usage from a React component:
 *
 *   import { exportInvoicesToCsv } from "@/lib/csvExport";
 *   const onClick = () => {
 *     exportInvoicesToCsv(invoicesFromQuery, "invoices_2026.csv");
 *   };
 *
 * The function expects each `invoice` object to be the shape returned by
 * trpc.invoices.list (or similar). The richer fields live in the parsed
 * `extractedData` JSON column; we deserialise defensively because the
 * shape evolved over time.
 */

// ───────────────────────────────────────────────────────────────────────────
// Types — loose, defensive: trust what's there, default what isn't
// ───────────────────────────────────────────────────────────────────────────

interface IssuerObject {
  name?: string;
  vatNumber?: string;
  registrationNumber?: string;
  address?: string;
  city?: string;
  postCode?: string;
  country?: string;
  doy?: string;
}

interface RecipientObject {
  name?: string;
  vatNumber?: string;
  address?: string;
  city?: string;
  postCode?: string;
  country?: string;
}

interface ExtractedData {
  documentType?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  orderNumber?: string | null;
  // myDATA
  mark?: string | null;
  uid?: string | null;
  authenticationCode?: string | null;
  provider?: string | null;
  // Payment + dispatch
  paymentMethod?: string | null;
  dispatchDate?: string | null;
  vehicleNumber?: string | null;
  purpose?: string | null;
  // Parties
  issuer?: IssuerObject;
  recipient?: RecipientObject;
  supplierName?: string;
  supplierVatNumber?: string;
  customerName?: string;
  customerVatNumber?: string;
  // Financial
  subtotal?: number | string;
  vatAmount?: number | string;
  totalAmount?: number | string;
  payableAmount?: number | string;
  withholdingTax?: number | string;
  // Currency
  currency?: string;
}

interface InvoiceRow {
  id: number;
  invoiceNumber?: string | null;
  invoiceDate?: string | Date | null;
  documentType?: string | null;
  status?: string | null;
  processedAt?: string | Date | null;
  extractedData?: string | null; // JSON string
  // optional convenience fields that may be flattened on the row
  supplierName?: string | null;
  supplierTaxId?: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// The 32-column schema (METRO PoC §4)
// ───────────────────────────────────────────────────────────────────────────

interface CsvColumn {
  header: string;
  get: (row: InvoiceRow, ed: ExtractedData) => string;
}

const COLUMNS: CsvColumn[] = [
  { header: "Α/Α",                       get: r           => String(r.id) },
  { header: "Αριθμός Παραστατικού",      get: (r, ed)     => ed.invoiceNumber || r.invoiceNumber || "" },
  { header: "Ημερομηνία",                get: (r, ed)     => formatDate(ed.invoiceDate || r.invoiceDate) },
  { header: "Τύπος Παραστατικού",        get: (r, ed)     => ed.documentType || r.documentType || "invoice" },
  // Supplier (issuer)
  { header: "ΑΦΜ Προμηθευτή",            get: (_, ed)     => ed.issuer?.vatNumber || ed.supplierVatNumber || "" },
  { header: "Επωνυμία Προμηθευτή",       get: (r, ed)     => ed.issuer?.name || ed.supplierName || r.supplierName || "" },
  { header: "Διεύθυνση Προμηθευτή",      get: (_, ed)     => ed.issuer?.address || "" },
  { header: "Πόλη Προμηθευτή",           get: (_, ed)     => ed.issuer?.city || "" },
  { header: "ΤΚ Προμηθευτή",             get: (_, ed)     => ed.issuer?.postCode || "" },
  { header: "Χώρα Προμηθευτή",           get: (_, ed)     => ed.issuer?.country || "" },
  { header: "ΓΕΜΗ Προμηθευτή",           get: (_, ed)     => ed.issuer?.registrationNumber || "" },
  { header: "ΔΟΥ Προμηθευτή",            get: (_, ed)     => ed.issuer?.doy || "" },
  // Recipient (us)
  { header: "ΑΦΜ Πελάτη",                get: (_, ed)     => ed.recipient?.vatNumber || ed.customerVatNumber || "" },
  { header: "Επωνυμία Πελάτη",           get: (_, ed)     => ed.recipient?.name || ed.customerName || "" },
  // myDATA (Greek e-invoicing identifiers)
  { header: "ΜΑΡΚ",                      get: (_, ed)     => ed.mark || "" },
  { header: "UID",                       get: (_, ed)     => ed.uid || "" },
  { header: "Authentication Code",       get: (_, ed)     => ed.authenticationCode || "" },
  { header: "Πάροχος",                   get: (_, ed)     => ed.provider || "" },
  // Financial
  { header: "Καθαρή Αξία",               get: (_, ed)     => formatAmount(ed.subtotal) },
  { header: "ΦΠΑ",                       get: (_, ed)     => formatAmount(ed.vatAmount) },
  { header: "Συντελεστής ΦΠΑ %",         get: (_, ed)     => formatVatRate(ed) },
  { header: "Σύνολο",                    get: (_, ed)     => formatAmount(ed.totalAmount) },
  { header: "Πληρωτέο",                  get: (_, ed)     => formatAmount(ed.payableAmount ?? ed.totalAmount) },
  { header: "Παρακράτηση",               get: (_, ed)     => formatAmount(ed.withholdingTax) },
  { header: "Νόμισμα",                   get: (_, ed)     => ed.currency || "EUR" },
  // Order / payment / dispatch (combined ΤΔΑ)
  { header: "Τρόπος Πληρωμής",           get: (_, ed)     => ed.paymentMethod || "" },
  { header: "Αρ. Παραγγελίας",           get: (_, ed)     => ed.orderNumber || "" },
  { header: "Ημερομηνία Διακίνησης",     get: (_, ed)     => formatDate(ed.dispatchDate) },
  { header: "Αρ. Οχήματος",              get: (_, ed)     => ed.vehicleNumber || "" },
  { header: "Σκοπός Διακίνησης",         get: (_, ed)     => ed.purpose || "" },
  // System fields
  { header: "Status",                    get: r           => r.status || "" },
  { header: "Processed At",              get: r           => formatDate(r.processedAt) },
];

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a CSV string from a list of invoices. Uses CRLF line endings and UTF-8
 * BOM so Excel opens it correctly with Greek characters.
 */
export function buildInvoiceCsv(rows: InvoiceRow[]): string {
  const headers = COLUMNS.map(c => c.header);
  const body = rows.map(r => {
    const ed = parseExtractedData(r.extractedData);
    return COLUMNS.map(c => csvCell(c.get(r, ed))).join(",");
  });
  // BOM + CRLF — required for Excel to detect UTF-8 on Windows
  return "\uFEFF" + [headers.map(csvCell).join(","), ...body].join("\r\n");
}

/**
 * Trigger a browser download of the CSV. Call from a button onClick.
 */
export function exportInvoicesToCsv(rows: InvoiceRow[], filename = "invoices.csv"): void {
  const csv = buildInvoiceCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Free the blob URL — browsers don't auto-collect these immediately
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Export to clipboard instead of file. Useful for quick paste into Excel
 * without a download dialog.
 */
export async function copyInvoiceCsvToClipboard(rows: InvoiceRow[]): Promise<void> {
  const csv = buildInvoiceCsv(rows);
  await navigator.clipboard.writeText(csv);
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse extractedData JSON defensively. The column can be null, malformed,
 * or already an object depending on which path the row came through.
 */
function parseExtractedData(raw: string | null | undefined): ExtractedData {
  if (!raw) return {};
  if (typeof raw === "object") return raw as ExtractedData;
  try {
    return JSON.parse(raw) as ExtractedData;
  } catch {
    return {};
  }
}

/**
 * Escape a cell for CSV: wrap in quotes if it contains delimiter/quote/newline,
 * and double any internal quotes. RFC 4180.
 */
function csvCell(value: string): string {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Format a Date / ISO string / null in Greek locale (DD/MM/YYYY).
 * Falls back to the raw string if it isn't parseable.
 */
function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  if (d instanceof Date) {
    return d.toLocaleDateString("el-GR");
  }
  const parsed = new Date(d);
  if (isNaN(parsed.getTime())) return String(d);
  return parsed.toLocaleDateString("el-GR");
}

/**
 * Format a numeric amount with EU formatting (1.234,56). Accepts strings
 * (because Drizzle returns DECIMAL columns as strings) and numbers.
 */
function formatAmount(v: number | string | null | undefined): string {
  if (v == null || v === "") return "";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return "";
  return n.toLocaleString("el-GR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Derive the VAT rate to display. The extractedData may carry it directly
 * (some parsers) or only as subtotal+vat (others). We compute it from the
 * pair when needed, falling back to 24% only if the user-saved default was
 * applied during processing.
 */
function formatVatRate(ed: ExtractedData): string {
  // If subtotal & vat both present and non-zero, compute the rate
  const sub = typeof ed.subtotal === "string" ? parseFloat(ed.subtotal) : ed.subtotal;
  const vat = typeof ed.vatAmount === "string" ? parseFloat(ed.vatAmount) : ed.vatAmount;
  if (sub && vat != null && !isNaN(sub) && !isNaN(vat) && sub > 0) {
    const rate = (vat / sub) * 100;
    // Snap to common rates to absorb rounding noise (23.998 → 24)
    const common = [0, 6, 13, 17, 24];
    for (const r of common) {
      if (Math.abs(rate - r) < 0.5) return String(r);
    }
    return rate.toFixed(2);
  }
  // 0% VAT export invoices: vat == 0 explicitly
  if (vat === 0) return "0";
  return "";
}
