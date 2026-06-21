/**
 * Client-side export helpers for processed invoices.
 *
 * CSV export has ZERO dependencies and always works.
 * XLSX export lazy-loads the `xlsx` (SheetJS) package — install it with
 *   npm i xlsx
 * If it isn't installed, exportInvoicesXlsx falls back to CSV automatically.
 *
 * Feed these the array returned by trpc.invoices.exportHistory.useQuery().
 */

type ExportRow = Record<string, string | number | null | undefined>;

function flattenInvoice(inv: any): ExportRow {
  const ld = (inv.lineItems?.length ?? 0) as number;
  return {
    "Invoice #": inv.invoiceNumber ?? inv.id ?? "",
    Supplier: inv.supplierName ?? "",
    "Tax ID": inv.supplierTaxId ?? "",
    Type: inv.documentType ?? "",
    Status: inv.status ?? "",
    Total: inv.totalAmount ?? "",
    "Line items": ld,
    Created: fmt(inv.createdAt),
    Processed: fmt(inv.processedAt),
  };
}

function fmt(d: string | Date | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return String(d);
  return dt.toISOString().slice(0, 19).replace("T", " ");
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function exportInvoicesCsv(invoices: any[], filename?: string) {
  const rows = (invoices ?? []).map(flattenInvoice);
  const headers = rows.length
    ? Object.keys(rows[0])
    : ["Invoice #", "Supplier", "Tax ID", "Type", "Status", "Total", "Line items", "Created", "Processed"];
  const lines = [
    headers.join(","),
    ...rows.map(r => headers.map(h => csvEscape(r[h])).join(",")),
  ];
  const blob = new Blob(["\uFEFF" + lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  triggerDownload(blob, filename ?? `optimusinvoice-export-${stamp()}.csv`);
}

export async function exportInvoicesXlsx(invoices: any[], filename?: string) {
  let XLSX: any;
  try {
    XLSX = await import("xlsx");
  } catch {
    // xlsx not installed — degrade gracefully to CSV.
    exportInvoicesCsv(invoices, filename?.replace(/\.xlsx$/, ".csv"));
    return false;
  }
  const rows = (invoices ?? []).map(flattenInvoice);
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Invoices");
  XLSX.writeFile(wb, filename ?? `optimusinvoice-export-${stamp()}.xlsx`);
  return true;
}
