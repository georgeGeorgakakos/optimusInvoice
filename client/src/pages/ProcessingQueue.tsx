/**
 * ProcessingQueue.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Live view of the invoice processing queue.
 *
 * WHY THIS PAGE EXISTS
 *   Invoice extraction runs in the background worker (queueWorker.ts), decoupled
 *   from the browser. This page lets a user watch progress — and crucially, LEAVE
 *   and COME BACK later to see where things stand without restarting anything.
 *   It polls invoices.queueStatus on an interval (no held-open request), so it's
 *   safe to navigate away from; the worker keeps going regardless.
 *
 * STYLE
 *   Mirrors InvoiceList.tsx — DashboardLayout shell, trpc hooks, lucide icons,
 *   tailwind, sonner toasts — so it feels native to the app.
 */

import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
    Clock,
    Loader2,
    CheckCircle2,
    AlertCircle,
    XCircle,
    RefreshCw,
    Ban,
    Layers,
    Cpu,
    ArrowRight,
    ListChecks,
} from "lucide-react";
import { useLocation } from "wouter";
import { useMemo } from "react";
import { toast } from "sonner";

// ── Status visual config (aligned with InvoiceList.tsx) ──────────────────────
const statusConfig: Record<
    string,
    { icon: any; color: string; bg: string; border: string; label: string }
> = {
    queued:       { icon: Clock,        color: "text-slate-500",   bg: "bg-slate-50",   border: "border-slate-200",   label: "Queued" },
    processing:   { icon: Loader2,      color: "text-blue-600",    bg: "bg-blue-50",    border: "border-blue-200",    label: "Processing" },
    completed:    { icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-50", border: "border-emerald-200", label: "Completed" },
    review_needed:{ icon: AlertCircle,  color: "text-amber-600",   bg: "bg-amber-50",   border: "border-amber-200",   label: "Review Needed" },
    failed:       { icon: XCircle,      color: "text-red-600",     bg: "bg-red-50",     border: "border-red-200",     label: "Failed" },
    pending:      { icon: Clock,        color: "text-slate-500",   bg: "bg-slate-50",   border: "border-slate-200",   label: "Pending" },
};

// Format an elapsed duration from a start time to now (or to `end`).
function elapsed(from?: string | Date | null, to?: string | Date | null): string {
    if (!from) return "";
    const start = new Date(from).getTime();
    const end = to ? new Date(to).getTime() : Date.now();
    let s = Math.max(0, Math.floor((end - start) / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function displayName(pdfFileKey?: string | null, id?: number, invoiceNumber?: string | null): string {
    if (invoiceNumber) return `#${invoiceNumber}`;
    const fn = pdfFileKey?.split("/").pop() || `Invoice #${id}`;
    return fn.replace(/^\d{13}-/, ""); // strip timestamp prefix like InvoiceList
}

export default function ProcessingQueue() {
    const [, setLocation] = useLocation();

    // Poll the queue every 3s. Because this is just a query (not a held-open
    // request), navigating away simply stops the polling — the worker is unaffected.
    const { data, isLoading, refetch } = trpc.invoices.queueStatus.useQuery(
        undefined,
        { refetchInterval: 3000 }
    );

    const retryMut = trpc.invoices.retry.useMutation();
    const cancelMut = trpc.invoices.cancelQueued.useMutation();

    const counts = (data?.counts ?? {}) as Record<string, number>;
    const active = (data?.active ?? []) as any[];
    const recent = (data?.recent ?? []) as any[];
    const batches = (data?.batches ?? []) as any[];

    const activeCount = (Number(counts.queued) || 0) + (Number(counts.processing) || 0);

    const handleRetry = async (id: number) => {
        try {
            await retryMut.mutateAsync({ invoiceId: id });
            toast.success("Invoice re-queued for processing");
            refetch();
        } catch (err: any) {
            toast.error(err.message || "Retry failed");
        }
    };

    const handleCancel = async (id: number) => {
        try {
            const res = await cancelMut.mutateAsync({ invoiceId: id });
            if ((res as any)?.cancelled) {
                toast.success("Removed from queue");
            } else {
                toast.info("Could not cancel (already processing?)");
            }
            refetch();
        } catch (err: any) {
            toast.error(err.message || "Cancel failed");
        }
    };

    // Summary stat cards
    const stats = useMemo(
        () => [
            { key: "processing", label: "Processing", value: Number(counts.processing) || 0, color: "text-blue-600", bg: "bg-blue-50", icon: Loader2 },
            { key: "queued",     label: "Queued",     value: Number(counts.queued) || 0,     color: "text-slate-600", bg: "bg-slate-50", icon: Clock },
            { key: "completed",  label: "Completed",  value: Number(counts.completed) || 0,  color: "text-emerald-600", bg: "bg-emerald-50", icon: CheckCircle2 },
            { key: "failed",     label: "Failed",     value: Number(counts.failed) || 0,     color: "text-red-600", bg: "bg-red-50", icon: XCircle },
        ],
        [counts]
    );

    return (
        <DashboardLayout>
            <div className="space-y-6 max-w-5xl">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
                            <ListChecks className="h-6 w-6 text-blue-600" />
                            Processing Queue
                        </h1>
                        <p className="text-slate-500 mt-1 text-sm">
                            Invoices are processed in the background — you can leave this page and come back anytime.
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-9 gap-1.5"
                        onClick={() => refetch()}
                    >
                        <RefreshCw className="h-3.5 w-3.5" /> Refresh
                    </Button>
                </div>

                {/* Summary cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {stats.map(s => {
                        const Icon = s.icon;
                        return (
                            <div key={s.key} className={`p-4 rounded-xl border border-slate-200 ${s.bg}`}>
                                <div className="flex items-center gap-2">
                                    <Icon className={`h-4 w-4 ${s.color} ${s.key === "processing" && s.value > 0 ? "animate-spin" : ""}`} />
                                    <span className="text-xs font-medium text-slate-500">{s.label}</span>
                                </div>
                                <p className={`text-2xl font-bold mt-1 tabular-nums ${s.color}`}>{s.value}</p>
                            </div>
                        );
                    })}
                </div>

                {/* Per-batch progress */}
                {batches.length > 0 && (
                    <div className="space-y-2">
                        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                            <Layers className="h-4 w-4 text-slate-400" /> Batches
                        </h2>
                        {batches.map((b: any) => {
                            const total = Number(b.total) || 0;
                            const done = Number(b.done) || 0;
                            const failed = Number(b.failed) || 0;
                            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                            return (
                                <div key={b.batchId} className="p-3 rounded-xl border border-slate-200 bg-white">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-xs font-mono text-slate-400">{b.batchId}</span>
                                        <span className="text-xs font-medium text-slate-600">
                      {done}/{total} done{failed > 0 ? ` · ${failed} failed` : ""}
                    </span>
                                    </div>
                                    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                                        <div
                                            className="h-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-purple-500 transition-all"
                                            style={{ width: `${pct}%` }}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Active queue (queued + processing) */}
                <div className="space-y-2">
                    <h2 className="text-sm font-semibold text-slate-700">
                        Active {activeCount > 0 && <span className="text-slate-400">({activeCount})</span>}
                    </h2>

                    {isLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="animate-spin rounded-full h-7 w-7 border-2 border-blue-600 border-t-transparent" />
                        </div>
                    ) : active.length === 0 ? (
                        <div className="text-center py-12 bg-card rounded-2xl border border-border">
                            <div
                                className="h-12 w-12 rounded-2xl flex items-center justify-center mx-auto mb-3 text-white"
                                style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}
                            >
                                <CheckCircle2 className="h-6 w-6" />
                            </div>
                            <p className="text-sm font-medium text-foreground">Queue is empty</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Upload invoices and they’ll appear here while they process.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {active.map((inv: any) => {
                                const cfg = statusConfig[inv.status] || statusConfig.queued;
                                const StatusIcon = cfg.icon;
                                const spinning = inv.status === "processing";
                                return (
                                    <div
                                        key={inv.id}
                                        className="flex items-center gap-4 p-4 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition-all"
                                    >
                                        <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${cfg.bg} border ${cfg.border}`}>
                                            <StatusIcon className={`h-4 w-4 ${cfg.color} ${spinning ? "animate-spin" : ""}`} />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-slate-800 truncate">
                                                {displayName(inv.pdfFileKey, inv.id, inv.invoiceNumber)}
                                            </p>
                                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                {inv.supplierName && (
                                                    <span className="text-xs text-slate-500 font-medium truncate max-w-[160px]">
                            {inv.supplierName}
                          </span>
                                                )}
                                                {/* Live progress string from the worker */}
                                                {inv.progress && (
                                                    <span className="text-xs text-blue-600">{inv.progress}</span>
                                                )}
                                                {inv.engine && (
                                                    <span className="text-[10px] text-slate-400 flex items-center gap-0.5">
                            <Cpu className="h-3 w-3" /> {inv.engine}
                          </span>
                                                )}
                                                {inv.retryCount > 1 && (
                                                    <span className="text-[10px] text-amber-500">attempt {inv.retryCount}</span>
                                                )}
                                            </div>
                                        </div>

                                        {/* Elapsed / waiting time */}
                                        <span className="text-xs text-slate-400 tabular-nums shrink-0">
                      {inv.status === "processing"
                          ? elapsed(inv.startedAt)
                          : `waiting ${elapsed(inv.queuedAt)}`}
                    </span>

                                        {/* Status badge */}
                                        <span className={`text-[11px] font-medium px-2.5 py-1 rounded-full ${cfg.bg} ${cfg.color} border ${cfg.border} shrink-0`}>
                      {cfg.label}
                    </span>

                                        {/* Cancel — only when queued (not yet processing) */}
                                        {inv.status === "queued" && (
                                            <button
                                                onClick={() => handleCancel(inv.id)}
                                                className="h-7 w-7 rounded-lg flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all shrink-0"
                                                title="Remove from queue"
                                            >
                                                <Ban className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Recently finished */}
                {recent.length > 0 && (
                    <div className="space-y-2">
                        <h2 className="text-sm font-semibold text-slate-700">Recently finished</h2>
                        <div className="space-y-2">
                            {recent.map((inv: any) => {
                                const cfg = statusConfig[inv.status] || statusConfig.completed;
                                const StatusIcon = cfg.icon;
                                return (
                                    <div
                                        key={inv.id}
                                        className="flex items-center gap-4 p-3 bg-white rounded-xl border border-slate-200 hover:border-slate-300 hover:shadow-sm cursor-pointer transition-all group"
                                        onClick={() => setLocation(`/invoices/${inv.id}`)}
                                    >
                                        <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${cfg.bg} border ${cfg.border}`}>
                                            <StatusIcon className={`h-4 w-4 ${cfg.color}`} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-slate-800 truncate">
                                                {displayName(inv.pdfFileKey, inv.id, inv.invoiceNumber)}
                                            </p>
                                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                {inv.supplierName && (
                                                    <span className="text-xs text-slate-500 truncate max-w-[160px]">{inv.supplierName}</span>
                                                )}
                                                {inv.status === "failed" && inv.errorMessage && (
                                                    <span className="text-xs text-red-500 truncate max-w-[260px]" title={inv.errorMessage}>
                            {inv.errorMessage}
                          </span>
                                                )}
                                                {inv.startedAt && inv.processedAt && (
                                                    <span className="text-[10px] text-slate-400">took {elapsed(inv.startedAt, inv.processedAt)}</span>
                                                )}
                                            </div>
                                        </div>
                                        <span className={`text-[11px] font-medium px-2.5 py-1 rounded-full ${cfg.bg} ${cfg.color} border ${cfg.border} shrink-0`}>
                      {cfg.label}
                    </span>

                                        {/* Retry — only for failed */}
                                        {inv.status === "failed" && (
                                            <button
                                                onClick={e => { e.stopPropagation(); handleRetry(inv.id); }}
                                                className="h-7 px-2 rounded-lg flex items-center gap-1 text-[10px] font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 transition-all shrink-0"
                                                title="Retry processing"
                                            >
                                                <RefreshCw className="h-3 w-3" /> Retry
                                            </button>
                                        )}

                                        <ArrowRight className="h-4 w-4 text-slate-300 group-hover:text-slate-500 transition-colors shrink-0" />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </DashboardLayout>
    );
}
