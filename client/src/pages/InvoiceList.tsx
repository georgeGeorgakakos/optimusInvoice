import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import {
  FileText,
  Upload,
  Clock,
  CheckCircle2,
  AlertCircle,
  XCircle,
  ArrowRight,
  Search,
  Trash2,
  Loader2,
  Truck,
  ReceiptText,
  CreditCard,
  Package,
  RefreshCw,
  Download,
  ShieldCheck,
  User,
  X,
  ListChecks,
  Filter,
} from "lucide-react";
import { useLocation } from "wouter";
import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const docTypeConfig: Record<
    string,
    {
      label: string;
      labelShort: string;
      icon: any;
      color: string;
      bg: string;
      border: string;
    }
> = {
  invoice: {
    label: "Τιμολόγιο",
    labelShort: "Invoice",
    icon: ReceiptText,
    color: "text-blue-700",
    bg: "bg-blue-50",
    border: "border-blue-200",
  },
  credit_note: {
    label: "Πιστωτικό",
    labelShort: "Credit",
    icon: CreditCard,
    color: "text-purple-700",
    bg: "bg-purple-50",
    border: "border-purple-200",
  },
  cmr: {
    label: "CMR",
    labelShort: "CMR",
    icon: Truck,
    color: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-200",
  },
  dispatch_note: {
    label: "Δελτίο Αποστολής",
    labelShort: "Dispatch",
    icon: Package,
    color: "text-emerald-700",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
  },
};

const tabs = [
  { key: "all", label: "Όλα", labelEn: "All" },
  { key: "invoice", label: "Τιμολόγια", labelEn: "Invoices" },
  { key: "credit_note", label: "Πιστωτικά", labelEn: "Credit Notes" },
  { key: "cmr", label: "CMR", labelEn: "CMR" },
  { key: "dispatch_note", label: "Δελτία Αποστολής", labelEn: "Dispatch" },
];

// Status filter options for the filter bar. "all" disables the filter.
const STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "completed", label: "Completed" },
  { key: "review_needed", label: "Review Needed" },
  { key: "queued", label: "Queued" },
  { key: "processing", label: "Processing" },
  { key: "failed", label: "Failed" },
  { key: "pending", label: "Pending" },
];

// Date-range options (client-side, based on createdAt).
const DATE_FILTERS = [
  { key: "all", label: "Any time" },
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
];

export default function InvoiceList() {
  const [, setLocation] = useLocation();
  const { data: invoices, isLoading, refetch } = trpc.invoices.list.useQuery();
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [reprocessingId, setReprocessingId] = useState<number | null>(null);
  const [submittingId, setSubmittingId] = useState<number | null>(null);
  const deleteMutation = trpc.invoices.delete.useMutation();
  const processMutation = trpc.invoices.process.useMutation();
  const submitApprovalMut = trpc.approvals.submit.useMutation();

  // ── NEW: filter bar state ──
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [showFilters, setShowFilters] = useState(false);

  // ── NEW: bulk-selection state ──
  // Set of selected invoice ids. Selection is preserved across filtering, but
  // bulk actions only operate on ids that are also currently visible.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // ── NEW: bulk-action endpoints (backend already exists from the queue work) ──
  const batchEnqueueMut = trpc.invoices.batchEnqueue.useMutation();

  const handleReprocess = async (id: number) => {
    setReprocessingId(id);
    try {
      await processMutation.mutateAsync({ invoiceId: id });
      toast.success("Invoice queued for processing");
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Reprocessing failed");
    } finally {
      setReprocessingId(null);
    }
  };

  const handleSubmitApproval = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setSubmittingId(id);
    try {
      await submitApprovalMut.mutateAsync({ invoiceId: id, comment: "" });
      toast.success("Submitted for approval");
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Submission failed");
    } finally {
      setSubmittingId(null);
    }
  };

  // Unique supplier names for the supplier filter dropdown.
  const supplierOptions = useMemo(() => {
    if (!invoices) return [];
    const set = new Set<string>();
    for (const inv of invoices as any[]) {
      if (inv.supplierName) set.add(inv.supplierName);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [invoices]);

  const filtered = useMemo(() => {
    if (!invoices) return [];
    const now = Date.now();
    const dayMs = 86400000;
    return invoices.filter((inv: any) => {
      // Tab filter (document type)
      if (activeTab !== "all") {
        const invType = inv.documentType || "invoice";
        if (invType !== activeTab) return false;
      }
      // Status filter
      if (statusFilter !== "all" && inv.status !== statusFilter) return false;
      // Supplier filter
      if (supplierFilter !== "all" && inv.supplierName !== supplierFilter)
        return false;
      // Date filter (based on createdAt)
      if (dateFilter !== "all" && inv.createdAt) {
        const created = new Date(inv.createdAt).getTime();
        if (dateFilter === "today") {
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          if (created < startOfDay.getTime()) return false;
        } else if (dateFilter === "7d") {
          if (created < now - 7 * dayMs) return false;
        } else if (dateFilter === "30d") {
          if (created < now - 30 * dayMs) return false;
        }
      }
      // Search filter (now also matches supplier + uploader name)
      if (search) {
        const s = search.toLowerCase();
        return (
            inv.pdfFileKey?.toLowerCase().includes(s) ||
            inv.invoiceNumber?.toLowerCase().includes(s) ||
            inv.status?.toLowerCase().includes(s) ||
            inv.documentType?.toLowerCase().includes(s) ||
            inv.supplierName?.toLowerCase().includes(s) ||
            inv.uploaderName?.toLowerCase().includes(s)
        );
      }
      return true;
    });
  }, [invoices, activeTab, search, statusFilter, dateFilter, supplierFilter]);

  // Tab counts (unaffected by the filter bar — they reflect doc-type totals)
  const tabCounts = useMemo(() => {
    if (!invoices) return {};
    const counts: Record<string, number> = { all: invoices.length };
    for (const inv of invoices) {
      const t = (inv as any).documentType || "invoice";
      counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }, [invoices]);

  // Are any non-default filters active? (drives the "Clear" affordance)
  const filtersActive =
      statusFilter !== "all" || dateFilter !== "all" || supplierFilter !== "all";

  const clearFilters = () => {
    setStatusFilter("all");
    setDateFilter("all");
    setSupplierFilter("all");
  };

  // ── Selection helpers ──
  const visibleIds = useMemo(
      () => filtered.map((i: any) => i.id as number),
      [filtered]
  );
  // ids that are both selected AND currently visible (what bulk actions act on)
  const selectedVisible = useMemo(
      () => visibleIds.filter(id => selected.has(id)),
      [visibleIds, selected]
  );
  const allVisibleSelected =
      visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  const toggleOne = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        // deselect all visible
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  // ── Bulk: process selected (uses existing batchEnqueue) ──
  const handleBulkProcess = async () => {
    if (selectedVisible.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await batchEnqueueMut.mutateAsync({
        invoiceIds: selectedVisible,
        batchId: undefined,
      });
      toast.success(
          `Queued ${res.queued} invoice${res.queued !== 1 ? "s" : ""} for processing`,
          { description: "Watch progress on the Processing Queue page" }
      );
      clearSelection();
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Bulk processing failed");
    } finally {
      setBulkBusy(false);
    }
  };

  // ── Bulk: delete selected (loops the existing single delete) ──
  const handleBulkDelete = async () => {
    if (selectedVisible.length === 0) return;
    setBulkBusy(true);
    let ok = 0;
    let fail = 0;
    for (const id of selectedVisible) {
      try {
        await deleteMutation.mutateAsync({ id });
        ok++;
      } catch {
        fail++;
      }
    }
    setBulkBusy(false);
    setBulkDeleteOpen(false);
    clearSelection();
    refetch();
    if (fail === 0) {
      toast.success(`Deleted ${ok} invoice${ok !== 1 ? "s" : ""}`);
    } else {
      toast.warning(`Deleted ${ok}, failed ${fail}`);
    }
  };

  const handleExportCSV = async () => {
    try {
      const data = await fetch("/api/trpc/invoices.exportHistory", {
        credentials: "include",
      })
          .then(r => r.json())
          .then(r => r?.result?.data || []);

      if (!data.length) {
        toast.info("No invoices to export");
        return;
      }

      // Flatten: one row per line item, with invoice headers repeated
      const rows: string[][] = [];
      const header = [
        "Invoice #",
        "Document Type",
        "Status",
        // Supplier
        "Supplier",
        "Supplier Tax ID",
        // myDATA
        "MARK",
        "UID",
        "Auth Code",
        "Provider",
        // Customer
        "Customer Name",
        "Customer VAT",
        "Customer Address",
        // Dispatch
        "Dispatch Date",
        "Vehicle",
        "Purpose",
        // Dates
        "Invoice Date",
        // Totals
        "Subtotal (Net)",
        "Total VAT",
        "Total Amount",
        "Payment Method",
        // Audit
        "Processed At",
        "Created At",
        // Lines
        "Line: Code",
        "Line: Description",
        "Line: Qty",
        "Line: Unit",
        "Line: Unit Price",
        "Line: Net Amount",
        "Line: VAT Rate",
        "Line: VAT Amount",
        "Line: ERP Code",
        "Line: Match Status",
        "Line: Confidence",
      ];

      for (const inv of data) {
        let extracted: any = {};
        try {
          extracted = JSON.parse(inv.extractedData || "{}");
        } catch {}

        const base = [
          inv.invoiceNumber || "",
          inv.documentType || "",
          inv.status || "",
          // Supplier
          inv.supplierName || extracted.supplierName || "",
          inv.supplierTaxId || extracted.supplierVatNumber || "",
          // myDATA
          extracted.mark || "",
          extracted.uid || "",
          extracted.authenticationCode || "",
          extracted.provider || "",
          // Customer
          extracted.customerName || extracted.recipient?.name || "",
          extracted.customerVatNumber || extracted.recipient?.vatNumber || "",
          extracted.recipient?.address || "",
          // Dispatch
          extracted.dispatchDate || "",
          extracted.vehicleNumber || "",
          extracted.purpose || "",
          // Dates
          extracted.invoiceDate || extracted.date || "",
          // Totals
          extracted.subtotal || "",
          extracted.vatAmount || "",
          inv.totalAmount || extracted.totalAmount || "",
          extracted.paymentMethod || "",
          // Audit
          inv.processedAt ? new Date(inv.processedAt).toLocaleString("en-GB") : "",
          inv.createdAt   ? new Date(inv.createdAt).toLocaleString("en-GB")   : "",
        ];

        if (inv.lineItems?.length) {
          for (const li of inv.lineItems) {
            rows.push([
              ...base,
              li.supplierCode || "",
              li.description || "",
              li.quantity || "",
              li.unit || "",
              li.unitPrice || "",
              li.netAmount || "",
              li.vatRate || "",
              li.vatAmount || "",
              li.erpCode || "",
              li.matchStatus || "",
              li.matchConfidence || "",
            ]);
          }
        } else {
          rows.push([...base, "", "", "", "", "", "", "", "", "", "", ""]);
        }
      }

      const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
      const csv = [
        header.map(esc).join(","),
        ...rows.map(r => r.map(esc).join(",")),
      ].join("\n");
      const blob = new Blob(["\uFEFF" + csv], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice_history_${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${data.length} invoices`);
    } catch (err: any) {
      toast.error("Export failed", { description: err.message });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ id: deleteTarget.id });
      toast.success("Invoice deleted");
      setDeleteTarget(null);
      refetch();
    } catch (error: any) {
      toast.error("Delete failed", { description: error.message });
    }
  };

  const statusConfig: Record<
      string,
      { icon: any; color: string; bg: string; border: string; label: string }
  > = {
    completed: {
      icon: CheckCircle2,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
      border: "border-emerald-200",
      label: "Completed",
    },
    review_needed: {
      icon: AlertCircle,
      color: "text-amber-600",
      bg: "bg-amber-50",
      border: "border-amber-200",
      label: "Review Needed",
    },
    queued: {
      icon: Clock,
      color: "text-slate-500",
      bg: "bg-slate-50",
      border: "border-slate-200",
      label: "Queued",
    },
    processing: {
      icon: Clock,
      color: "text-blue-600",
      bg: "bg-blue-50",
      border: "border-blue-200",
      label: "Processing",
    },
    failed: {
      icon: XCircle,
      color: "text-red-600",
      bg: "bg-red-50",
      border: "border-red-200",
      label: "Failed",
    },
    pending: {
      icon: Clock,
      color: "text-slate-500",
      bg: "bg-slate-50",
      border: "border-slate-200",
      label: "Pending",
    },
  };

  return (
      <DashboardLayout>
        <div className="space-y-6 max-w-5xl">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                Invoices
              </h1>
              <p className="text-slate-500 mt-1 text-sm">
                Manage and track all uploaded invoices
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                  variant="outline"
                  size="sm"
                  className={`text-xs h-9 gap-1.5 ${filtersActive ? "border-blue-300 text-blue-700 bg-blue-50" : ""}`}
                  onClick={() => setShowFilters(s => !s)}
              >
                <Filter className="h-3.5 w-3.5" /> Filters
                {filtersActive && (
                    <span className="ml-0.5 h-4 min-w-[16px] px-1 text-[9px] font-bold text-white rounded-full flex items-center justify-center bg-blue-600">
                  {[statusFilter, dateFilter, supplierFilter].filter(f => f !== "all").length}
                </span>
                )}
              </Button>
              <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-9 gap-1.5"
                  onClick={handleExportCSV}
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
              <Button
                  onClick={() => setLocation("/invoices/upload")}
                  className="bg-primary hover:bg-primary/90 text-white shadow-sm"
              >
                <Upload className="h-4 w-4 mr-2" /> Upload Invoice
              </Button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-slate-200 pb-0 -mb-1">
            {tabs.map(tab => {
              const count = tabCounts[tab.key] || 0;
              const isActive = activeTab === tab.key;
              // Hide tabs with 0 count (except All and the active tab)
              if (tab.key !== "all" && count === 0 && !isActive) return null;
              return (
                  <button
                      key={tab.key}
                      onClick={() => setActiveTab(tab.key)}
                      className={`px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
                          isActive
                              ? "border-blue-600 text-blue-700 bg-blue-50/50"
                              : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                      }`}
                  >
                    {tab.label}
                    {count > 0 && (
                        <span
                            className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                                isActive
                                    ? "bg-blue-100 text-blue-700"
                                    : "bg-slate-100 text-slate-500"
                            }`}
                        >
                    {count}
                  </span>
                    )}
                  </button>
              );
            })}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
                placeholder="Search by file, number, supplier, status, uploader..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-10 bg-white border-slate-200 h-10 text-sm"
            />
          </div>

          {/* Filter bar (collapsible) */}
          {showFilters && (
              <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Status</span>
                  <select
                      value={statusFilter}
                      onChange={e => setStatusFilter(e.target.value)}
                      className="h-8 rounded-lg border border-slate-200 bg-white text-xs px-2 text-slate-700 focus:outline-none focus:border-blue-300"
                  >
                    {STATUS_FILTERS.map(o => (
                        <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Date</span>
                  <select
                      value={dateFilter}
                      onChange={e => setDateFilter(e.target.value)}
                      className="h-8 rounded-lg border border-slate-200 bg-white text-xs px-2 text-slate-700 focus:outline-none focus:border-blue-300"
                  >
                    {DATE_FILTERS.map(o => (
                        <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Supplier</span>
                  <select
                      value={supplierFilter}
                      onChange={e => setSupplierFilter(e.target.value)}
                      className="h-8 rounded-lg border border-slate-200 bg-white text-xs px-2 text-slate-700 focus:outline-none focus:border-blue-300 max-w-[200px]"
                  >
                    <option value="all">All suppliers</option>
                    {supplierOptions.map(s => (
                        <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                {filtersActive && (
                    <button
                        onClick={clearFilters}
                        className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1 ml-auto"
                    >
                      <X className="h-3 w-3" /> Clear
                    </button>
                )}
              </div>
          )}

          {/* Bulk selection bar — appears when ≥1 visible row is selected */}
          {selectedVisible.length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 flex items-center gap-3 sticky top-2 z-20">
            <span className="text-sm font-medium text-blue-800">
              {selectedVisible.length} selected
            </span>
                <div className="h-4 w-px bg-blue-200" />
                <Button
                    size="sm"
                    className="h-8 text-xs bg-blue-600 hover:bg-blue-500 text-white gap-1.5"
                    onClick={handleBulkProcess}
                    disabled={bulkBusy}
                >
                  {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
                  Process selected
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs border-red-200 text-red-600 hover:bg-red-50 gap-1.5"
                    onClick={() => setBulkDeleteOpen(true)}
                    disabled={bulkBusy}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
                <button
                    onClick={clearSelection}
                    className="ml-auto text-xs text-blue-500 hover:text-blue-700 flex items-center gap-1"
                >
                  <X className="h-3.5 w-3.5" /> Clear
                </button>
              </div>
          )}

          {/* Invoice List */}
          {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <div className="animate-spin rounded-full h-7 w-7 border-2 border-blue-600 border-t-transparent"></div>
              </div>
          ) : !filtered || filtered.length === 0 ? (
              <div className="text-center py-20 bg-card rounded-2xl border border-border">
                <div
                    className="h-14 w-14 rounded-2xl flex items-center justify-center mx-auto mb-4 text-white"
                    style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}
                >
                  <FileText className="h-7 w-7" />
                </div>
                <p className="text-base font-medium text-foreground mb-1">
                  {search || filtersActive ? "No matching invoices" : "No invoices yet"}
                </p>
                <p className="text-sm text-muted-foreground mb-5">
                  {search || filtersActive
                      ? "Try a different search or clear filters"
                      : "Upload your first invoice to get started"}
                </p>
                {!search && !filtersActive && (
                    <Button
                        size="sm"
                        onClick={() => setLocation("/invoices/upload")}
                        className="border-0 text-white text-xs hover:brightness-110"
                        style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}
                    >
                      <Upload className="h-3.5 w-3.5 mr-1.5" /> Upload Invoice
                    </Button>
                )}
              </div>
          ) : (
              <div className="space-y-2">
                {/* Select-all header row */}
                <div className="flex items-center gap-3 px-4 py-1.5">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleAllVisible}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                    <span className="text-[11px] text-slate-400">
                  {allVisibleSelected ? "Deselect all" : "Select all"}
                      {filtered.length > 0 && ` (${filtered.length})`}
                </span>
                  </label>
                </div>

                {filtered.map((invoice: any) => {
                  const cfg = statusConfig[invoice.status] || statusConfig.pending;
                  const StatusIcon = cfg.icon;
                  const fileName =
                      invoice.pdfFileKey?.split("/").pop() ||
                      `Invoice #${invoice.id}`;
                  // Trim the timestamp prefix for display
                  const displayName = fileName.replace(/^\d{13}-/, "");
                  const isSelected = selected.has(invoice.id);

                  return (
                      <div
                          key={invoice.id}
                          className={`flex items-center gap-4 p-4 bg-white rounded-xl border transition-all group ${
                              isSelected
                                  ? "border-blue-300 ring-1 ring-blue-200 bg-blue-50/30"
                                  : "border-slate-200 hover:border-slate-300 hover:shadow-sm"
                          }`}
                      >
                        {/* Selection checkbox */}
                        <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleOne(invoice.id)}
                            onClick={e => e.stopPropagation()}
                            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer shrink-0"
                        />

                        {/* Clickable body → detail */}
                        <div
                            className="flex items-center gap-4 flex-1 min-w-0 cursor-pointer"
                            onClick={() => setLocation(`/invoices/${invoice.id}`)}
                        >
                          {/* Status icon */}
                          <div
                              className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${cfg.bg} border ${cfg.border}`}
                          >
                            <StatusIcon className={`h-4 w-4 ${cfg.color}`} />
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate">
                              {displayName}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              {invoice.invoiceNumber && (
                                  <span className="text-xs text-slate-400 font-mono">
                            #{invoice.invoiceNumber}
                          </span>
                              )}
                              {invoice.supplierName && (
                                  <span className="text-xs text-slate-500 font-medium truncate max-w-[160px]">
                            {invoice.supplierName}
                          </span>
                              )}
                              {/* Uploader attribution */}
                              {invoice.uploaderName && (
                                  <span className="text-[10px] text-slate-400 flex items-center gap-0.5">
                            <User className="h-2.5 w-2.5" />
                                    {invoice.uploaderName}
                          </span>
                              )}
                              <span className="text-xs text-slate-300">
                          {new Date(invoice.createdAt).toLocaleDateString(
                              "en-GB",
                              { day: "numeric", month: "short", year: "numeric" }
                          )}{" "}
                                <span className="text-slate-200">
                            {new Date(invoice.createdAt).toLocaleTimeString(
                                "en-GB",
                                { hour: "2-digit", minute: "2-digit" }
                            )}
                          </span>
                        </span>
                            </div>
                          </div>

                          {/* Document type badge */}
                          {(() => {
                            const dtype = (invoice as any).documentType || "invoice";
                            const dtCfg = docTypeConfig[dtype] || docTypeConfig.invoice;
                            const DtIcon = dtCfg.icon;
                            return (
                                <span
                                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${dtCfg.bg} ${dtCfg.color} border ${dtCfg.border} shrink-0 flex items-center gap-1`}
                                >
                          <DtIcon className="h-3 w-3" />
                                  {dtCfg.labelShort}
                        </span>
                            );
                          })()}

                          {/* Status badge */}
                          <span
                              className={`text-[11px] font-medium px-2.5 py-1 rounded-full ${cfg.bg} ${cfg.color} border ${cfg.border} shrink-0`}
                          >
                      {cfg.label}
                    </span>

                          {/* Amount */}
                          {invoice.totalAmount &&
                          parseFloat(invoice.totalAmount) > 0 ? (
                              <span className="text-sm font-semibold text-slate-700 tabular-nums shrink-0 w-24 text-right">
                        {invoice.currency || "EUR"}{" "}
                                {parseFloat(invoice.totalAmount).toFixed(2)}
                      </span>
                          ) : (
                              <span className="w-24 shrink-0" />
                          )}

                          <ArrowRight className="h-4 w-4 text-slate-300 group-hover:text-slate-500 transition-colors shrink-0" />
                        </div>

                        {/* Submit for Approval — only on review_needed */}
                        {invoice.status === "review_needed" && (
                            <button
                                onClick={e => handleSubmitApproval(e, invoice.id)}
                                disabled={submittingId === invoice.id}
                                className="h-7 px-2 rounded-lg flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                                title="Submit for approval"
                            >
                              {submittingId === invoice.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                  <ShieldCheck className="h-3 w-3" />
                              )}
                              Approve
                            </button>
                        )}

                        {/* Reprocess button for failed/pending invoices */}
                        {(invoice.status === "failed" ||
                            invoice.status === "pending") && (
                            <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleReprocess(invoice.id);
                                }}
                                disabled={reprocessingId === invoice.id}
                                className="h-7 w-7 rounded-lg flex items-center justify-center text-slate-300 hover:text-blue-500 hover:bg-blue-50 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                                title="Reprocess invoice"
                            >
                              <RefreshCw
                                  className={`h-3.5 w-3.5 ${reprocessingId === invoice.id ? "animate-spin" : ""}`}
                              />
                            </button>
                        )}

                        {/* Delete button */}
                        <button
                            onClick={e => {
                              e.stopPropagation();
                              setDeleteTarget(invoice);
                            }}
                            className="h-7 w-7 rounded-lg flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                            title="Delete invoice"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                  );
                })}
              </div>
          )}
        </div>

        {/* Delete Confirmation Dialog (single) */}
        <Dialog
            open={!!deleteTarget}
            onOpenChange={open => {
              if (!open) setDeleteTarget(null);
            }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-base flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-red-100 flex items-center justify-center">
                  <Trash2 className="h-4 w-4 text-red-600" />
                </div>
                Delete Invoice
              </DialogTitle>
              <DialogDescription className="text-xs pt-2">
                This will permanently delete invoice{" "}
                <span className="font-semibold">
                {deleteTarget?.invoiceNumber
                    ? `#${deleteTarget.invoiceNumber}`
                    : `#${deleteTarget?.id}`}
              </span>{" "}
                and all its line items. This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-2 justify-end mt-4">
              <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-8"
                  onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </Button>
              <Button
                  size="sm"
                  className="text-xs h-8 bg-red-600 hover:bg-red-500 text-white"
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : (
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                )}
                Delete Invoice
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Bulk Delete Confirmation Dialog */}
        <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-base flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-red-100 flex items-center justify-center">
                  <Trash2 className="h-4 w-4 text-red-600" />
                </div>
                Delete {selectedVisible.length} Invoices
              </DialogTitle>
              <DialogDescription className="text-xs pt-2">
                This will permanently delete{" "}
                <span className="font-semibold">{selectedVisible.length} invoices</span>{" "}
                and all their line items. This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-2 justify-end mt-4">
              <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-8"
                  onClick={() => setBulkDeleteOpen(false)}
                  disabled={bulkBusy}
              >
                Cancel
              </Button>
              <Button
                  size="sm"
                  className="text-xs h-8 bg-red-600 hover:bg-red-500 text-white"
                  onClick={handleBulkDelete}
                  disabled={bulkBusy}
              >
                {bulkBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : (
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                )}
                Delete {selectedVisible.length}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DashboardLayout>
  );
}
