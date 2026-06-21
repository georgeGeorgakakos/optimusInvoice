import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  ShieldCheck, CheckCircle2, XCircle, Clock, Loader2, FileText,
  MessageSquare, Eye, AlertCircle, Download,
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

export default function Approvals() {
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [decideDialog, setDecideDialog] = useState<{ approvalId: number; invoiceId: number; action: "approved" | "rejected" } | null>(null);
  const [comment, setComment] = useState("");
  const [exportLoading, setExportLoading] = useState(false);

  const { data: pending, isLoading, refetch } = trpc.approvals.pending.useQuery();
  const decideMut = trpc.approvals.decide.useMutation();
  const { data: notifList } = trpc.notifications.list.useQuery();

  // History = past approval-related notifications
  const history = (notifList || []).filter((n: any) =>
      ["approval_granted", "approval_rejected", "approval_requested"].includes(n.type)
  );

  const handleDecide = async () => {
    if (!decideDialog) return;
    try {
      await decideMut.mutateAsync({
        approvalId: decideDialog.approvalId,
        invoiceId: decideDialog.invoiceId,
        status: decideDialog.action,
        comment,
      });
      toast.success(decideDialog.action === "approved" ? "Invoice approved!" : "Invoice rejected");
      setDecideDialog(null);
      setComment("");
      refetch();
    } catch (err: any) {
      toast.error("Action failed", { description: err.message });
    }
  };

  // ── Export helpers ──────────────────────────────────────────────────────────

  const fetchApprovedData = async () => {
    const res = await fetch("/api/trpc/approvals.exportApproved", {
      credentials: "include",
    });
    const json = await res.json();
    return (json?.result?.data || []) as any[];
  };

  const handleExportJSON = async () => {
    setExportLoading(true);
    try {
      const data = await fetchApprovedData();
      if (!data.length) { toast.info("No approved invoices to export"); return; }

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `approved_invoices_${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${data.length} approved invoices as JSON`);
    } catch (err: any) {
      toast.error("Export failed", { description: err.message });
    } finally {
      setExportLoading(false);
    }
  };

  const handleExportCSV = async () => {
    setExportLoading(true);
    try {
      const data = await fetchApprovedData();
      if (!data.length) { toast.info("No approved invoices to export"); return; }

      const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;

      const header = [
        "Approval ID", "Approved At", "Approval Comment",
        "Invoice ID", "Invoice Number", "Document Type", "Invoice Date",
        "Currency", "Total Amount", "Processed At",
        "Supplier Name", "Supplier Code", "Supplier Tax ID", "Supplier Address",
        "Subtotal", "VAT Amount", "Payable Amount",
        "Line #", "Supplier Code (Line)", "ERP Code", "Description",
        "Qty", "Unit", "Unit Price", "Discount 1", "Discount 2", "Discount 3",
        "Net Amount", "VAT Rate", "VAT Amount", "Total with VAT",
        "Match Status", "Match Confidence",
      ];

      const rows: string[][] = [];
      for (const inv of data) {
        const base = [
          inv.approvalId, inv.approvedAt ? new Date(inv.approvedAt).toLocaleString("en-GB") : "",
          inv.approvalComment,
          inv.invoiceId, inv.invoiceNumber, inv.documentType, inv.invoiceDate,
          inv.currency, inv.totalAmount,
          inv.processedAt ? new Date(inv.processedAt).toLocaleString("en-GB") : "",
          inv.supplier?.name, inv.supplier?.code, inv.supplier?.taxId, inv.supplier?.address,
          inv.financials?.subtotal, inv.financials?.vatAmount, inv.financials?.payableAmount,
        ];

        if (inv.lineItems?.length) {
          for (const li of inv.lineItems) {
            rows.push([
              ...base,
              li.lineNumber, li.supplierCode, li.erpCode, li.description,
              li.quantity, li.unit, li.unitPrice,
              li.discount1, li.discount2, li.discount3,
              li.netAmount, li.vatRate, li.vatAmount, li.totalWithVat,
              li.matchStatus, li.matchConfidence,
            ]);
          }
        } else {
          // Invoice with no line items (CMR, dispatch note)
          rows.push([...base, "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
        }
      }

      const csv = [header.map(esc).join(","), ...rows.map(r => r.map(esc).join(","))].join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `approved_invoices_${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${data.length} approved invoices as CSV`);
    } catch (err: any) {
      toast.error("Export failed", { description: err.message });
    } finally {
      setExportLoading(false);
    }
  };

  const fmtDate = (d: string | Date) => {
    const dt = new Date(d);
    return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " +
        dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  const stepLabel = (s: number) =>
      s === 1 ? "Review" : s === 2 ? "Manager Approval" : s === 3 ? "Final Approval" : `Step ${s}`;

  return (
      <DashboardLayout>
        <div className="space-y-6 max-w-4xl">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Approvals</h1>
              <p className="text-slate-500 mt-0.5 text-sm">Review and approve invoices before they go to ERP</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                  variant="outline" size="sm"
                  className="text-xs h-8 gap-1.5"
                  onClick={handleExportCSV}
                  disabled={exportLoading}
              >
                {exportLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Export CSV
              </Button>
              <Button
                  variant="outline" size="sm"
                  className="text-xs h-8 gap-1.5"
                  onClick={handleExportJSON}
                  disabled={exportLoading}
              >
                {exportLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Export JSON
              </Button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit">
            {(["pending", "history"] as const).map(t => (
                <button key={t} onClick={() => setTab(t)}
                        className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                            tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                        }`}>
                  {t === "pending" ? "Pending" : "History"}
                  {t === "pending" && (pending?.length ?? 0) > 0 && (
                      <span className="ml-1.5 bg-amber-100 text-amber-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {pending?.length}
                </span>
                  )}
                </button>
            ))}
          </div>

          {/* Pending approvals */}
          {tab === "pending" && (
              <div className="space-y-3">
                {isLoading ? (
                    <div className="py-12 text-center">
                      <Loader2 className="h-6 w-6 text-slate-300 mx-auto animate-spin" />
                    </div>
                ) : !pending || pending.length === 0 ? (
                    <div className="py-16 text-center bg-white rounded-2xl border border-slate-200">
                      <ShieldCheck className="h-10 w-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-slate-500">No pending approvals</p>
                      <p className="text-xs text-slate-400 mt-1">Invoices submitted for approval will appear here</p>
                    </div>
                ) : (
                    pending.map((a: any) => (
                        <div key={a.approvalId} className="bg-white rounded-xl border border-slate-200 p-4 hover:border-slate-300 transition-colors">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-3 flex-1 min-w-0">
                              <div className="h-10 w-10 rounded-xl bg-amber-50 flex items-center justify-center shrink-0">
                                <Clock className="h-5 w-5 text-amber-500" />
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="text-sm font-semibold text-slate-800">
                                    {a.invoiceNumber || `Invoice #${a.invoiceId}`}
                                  </p>
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-amber-200 text-amber-600 bg-amber-50">
                                    {stepLabel(a.step)}
                                  </Badge>
                                  {a.documentType && (
                                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-slate-200 text-slate-500">
                                        {a.documentType}
                                      </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-slate-500 mt-0.5">
                                  {a.supplierName || "Unknown supplier"}
                                  {a.totalAmount && <span className="font-mono ml-2">€{a.totalAmount}</span>}
                                </p>
                                {a.comment && (
                                    <p className="text-xs text-slate-400 mt-1 italic flex items-center gap-1">
                                      <MessageSquare className="h-3 w-3" />"{a.comment}"
                                    </p>
                                )}
                                <p className="text-[10px] text-slate-300 mt-1.5">{fmtDate(a.createdAt)}</p>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <Button variant="outline" size="sm" className="text-xs h-8 gap-1"
                                      onClick={() => setLocation(`/invoices/${a.invoiceId}`)}>
                                <Eye className="h-3 w-3" /> View
                              </Button>
                              <Button size="sm" className="text-xs h-8 gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                                      onClick={() => setDecideDialog({ approvalId: a.approvalId, invoiceId: a.invoiceId, action: "approved" })}>
                                <CheckCircle2 className="h-3 w-3" /> Approve
                              </Button>
                              <Button variant="outline" size="sm" className="text-xs h-8 gap-1 text-red-600 border-red-200 hover:bg-red-50"
                                      onClick={() => setDecideDialog({ approvalId: a.approvalId, invoiceId: a.invoiceId, action: "rejected" })}>
                                <XCircle className="h-3 w-3" /> Reject
                              </Button>
                            </div>
                          </div>
                        </div>
                    ))
                )}

                {/* How approvals work */}
                {(!pending || pending.length === 0) && (
                    <div className="bg-blue-50/70 rounded-xl border border-blue-100 p-5 mt-4">
                      <p className="text-xs font-semibold text-blue-800 uppercase tracking-wide mb-3">How approval works</p>
                      <div className="space-y-2">
                        {[
                          "Invoices with unmatched items land in 'review_needed' status and generate a notification",
                          "From the invoice detail page, click 'Submit for Approval' to create an approval request",
                          "Approvers see pending items here and can approve (→ sends to ERP) or reject with a comment",
                          "All approval decisions are logged and trigger notifications",
                        ].map((tip, i) => (
                            <div key={i} className="flex items-start gap-2.5">
                              <CheckCircle2 className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
                              <span className="text-xs text-blue-800">{tip}</span>
                            </div>
                        ))}
                      </div>
                    </div>
                )}
              </div>
          )}

          {/* History tab */}
          {tab === "history" && (
              <div className="space-y-2">
                {history.length === 0 ? (
                    <div className="py-16 text-center bg-white rounded-2xl border border-slate-200">
                      <FileText className="h-10 w-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-slate-500">No approval history yet</p>
                    </div>
                ) : (
                    history.map((n: any) => {
                      const isApproved = n.type === "approval_granted";
                      const isRejected = n.type === "approval_rejected";
                      return (
                          <div key={n.id} className="bg-white rounded-xl border border-slate-100 px-4 py-3 flex items-center gap-3">
                            <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                                isApproved ? "bg-emerald-50" : isRejected ? "bg-red-50" : "bg-blue-50"
                            }`}>
                              {isApproved ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> :
                                  isRejected ? <XCircle className="h-4 w-4 text-red-500" /> :
                                      <ShieldCheck className="h-4 w-4 text-blue-500" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-slate-700">{n.title}</p>
                              {n.message && <p className="text-[10px] text-slate-400 mt-0.5">{n.message}</p>}
                            </div>
                            <span className="text-[10px] text-slate-300 shrink-0">{fmtDate(n.createdAt)}</span>
                            {n.invoiceId && (
                                <button onClick={() => setLocation(`/invoices/${n.invoiceId}`)}
                                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600 shrink-0">
                                  <Eye className="h-3.5 w-3.5" />
                                </button>
                            )}
                          </div>
                      );
                    })
                )}
              </div>
          )}
        </div>

        {/* Approve/Reject dialog */}
        <Dialog open={!!decideDialog} onOpenChange={() => { setDecideDialog(null); setComment(""); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base">
                {decideDialog?.action === "approved" ? "Approve Invoice" : "Reject Invoice"}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {decideDialog?.action === "approved"
                    ? "This will mark the invoice as completed and push it to ERP and OptimusDB."
                    : "This will reject the invoice. Add a reason below."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-500">Comment (optional)</label>
                <textarea
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                    rows={3} placeholder={decideDialog?.action === "approved" ? "Looks good..." : "Reason for rejection..."}
                    value={comment} onChange={e => setComment(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" className="text-xs" onClick={() => { setDecideDialog(null); setComment(""); }}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleDecide} disabled={decideMut.isPending}
                        className={`text-xs ${decideDialog?.action === "approved" ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-red-600 hover:bg-red-700 text-white"}`}>
                  {decideMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> :
                      decideDialog?.action === "approved" ? "Confirm Approval" : "Confirm Rejection"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </DashboardLayout>
  );
}
