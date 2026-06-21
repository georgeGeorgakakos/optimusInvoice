import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
  Upload, FileText, CheckCircle2, Loader2, Sparkles, Brain, Zap, Clock,
  FileUp, Search, Cpu, Link2, X, AlertCircle, Pause, Play, Eye, Layers,
  ReceiptText, Truck, CreditCard, Package, Globe, Terminal, ChevronDown, ChevronUp,
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

// How many file UPLOADS (the base64 POST) to run at once. This is NOT processing
// concurrency — the server worker owns that. It just avoids holding many large
// base64 payloads in memory simultaneously.
const MAX_UPLOAD_PARALLEL = 3;

// ─── Status model ───
// Client-local phases:  queued → uploading → (handed to server)
// Server-driven phases: serverQueued → processing → done | failed
// We keep one flat union the UI switches on.
type QueueStatus =
    | "queued"        // sitting in the local list, not yet uploaded
    | "uploading"     // base64 POST in flight
    | "serverQueued"  // uploaded; sitting in the server queue waiting for a worker
    | "processing"    // a worker is extracting it
    | "done"          // finished (completed | review_needed)
    | "failed"        // upload failed or worker failed
    | "cancelled";

interface QueueResult {
  documentType?: string;
  itemCount?: number;
  matchedCount?: number;
  invoiceStatus?: string;  // "completed" | "review_needed"
  supplierName?: string;
  invoiceNumber?: string;
  totalAmount?: string;
  optimusDbPushed?: boolean;
}

interface QueueDebug {
  vlmEngine?: string;
  rawText?: string;
  parsedFields?: Record<string, any>;
  lineItems?: any[];
}

interface QueueItem {
  id: string;
  file: File;
  status: QueueStatus;
  invoiceId?: number;
  error?: string;
  elapsed: number;
  progress?: string;   // live progress string from the worker
  engine?: string;     // extraction engine reported by the worker
  result?: QueueResult;
  debug?: QueueDebug;
  detailLoaded?: boolean; // have we already lazy-fetched getById for this finished item?
}

// ─── Helpers ───
const fmtSize = (b: number) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const fmtTime = (s: number) => { const m = Math.floor(s / 60); return m > 0 ? `${m}m ${s % 60}s` : `${s}s`; };

const TERMINAL: QueueStatus[] = ["done", "failed", "cancelled"];
const isTerminal = (s: QueueStatus) => TERMINAL.includes(s);
const isActive = (s: QueueStatus) => s === "uploading" || s === "serverQueued" || s === "processing";

const DOC_TYPE_ICONS: Record<string, any> = {
  invoice: FileText, credit_note: CreditCard, receipt_of_goods: Package,
  dispatch_note: Truck, cmr: Truck, proforma: ReceiptText,
};
const DOC_TYPE_LABELS: Record<string, string> = {
  invoice: "Invoice", credit_note: "Credit Note", receipt_of_goods: "Receipt",
  dispatch_note: "Dispatch", cmr: "CMR", proforma: "Proforma",
};

// ─── Live progress bar for active items (real server progress, no fake %) ───
function MiniProgress({ item }: { item: QueueItem }) {
  const label =
      item.status === "uploading" ? "Uploading PDF" :
          item.status === "serverQueued" ? (item.progress || "Waiting in queue…") :
              (item.progress || "Processing…");

  return (
      <div className="space-y-1.5 mt-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium text-blue-600 flex items-center gap-1.5">
            {label}
            {item.engine && <span className="text-blue-300">· {item.engine}</span>}
          </span>
          <span className="text-[10px] font-mono text-slate-400">
            {item.status === "serverQueued" ? "queued" : "working"}
          </span>
        </div>
        {/* Indeterminate sheen — we no longer fake a percentage. */}
        <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden relative">
          <div
              className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-violet-500"
              style={{ animation: "optimusUploadIndeterminate 1.4s ease-in-out infinite" }}
          />
        </div>
        <style>{`
          @keyframes optimusUploadIndeterminate {
            0%   { transform: translateX(-100%); }
            100% { transform: translateX(400%); }
          }
        `}</style>
      </div>
  );
}

// ─── Result summary after completion ───
function ResultSummary({ result }: { result: QueueResult }) {
  const DocIcon = DOC_TYPE_ICONS[result.documentType || ""] || FileText;
  const docLabel = DOC_TYPE_LABELS[result.documentType || ""] || result.documentType || "Document";
  const isReview = result.invoiceStatus === "review_needed";

  return (
      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-1 border-slate-200 text-slate-500">
          <DocIcon className="h-2.5 w-2.5" />{docLabel}
        </Badge>
        {result.supplierName && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-slate-200 text-slate-500 max-w-[140px] truncate">
              {result.supplierName}
            </Badge>
        )}
        {result.invoiceNumber && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono border-slate-200 text-slate-500">
              #{result.invoiceNumber}
            </Badge>
        )}
        {(result.itemCount ?? 0) > 0 && (
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${
                result.matchedCount === result.itemCount
                    ? "border-emerald-200 text-emerald-600 bg-emerald-50"
                    : "border-amber-200 text-amber-600 bg-amber-50"
            }`}>
              {result.matchedCount ?? 0}/{result.itemCount} matched
            </Badge>
        )}
        {result.totalAmount && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono border-slate-200 text-slate-600">
              €{result.totalAmount}
            </Badge>
        )}
        {isReview && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-amber-200 text-amber-600 bg-amber-50">
              Needs review
            </Badge>
        )}
        {result.optimusDbPushed && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-teal-200 text-teal-600 bg-teal-50 gap-0.5">
              <Globe className="h-2.5 w-2.5" />Cataloged
            </Badge>
        )}
      </div>
  );
}

// ─── Queue row ───
function QueueRow({ item, onRemove, onView }: {
  item: QueueItem; onRemove: () => void; onView: () => void;
}) {
  const [showDebug, setShowDebug] = useState(false);
  const active = isActive(item.status);

  const statusMap: Record<QueueStatus, { icon: any; color: string; label: string }> = {
    queued:       { icon: Clock,        color: "text-slate-400",   label: "Queued" },
    uploading:    { icon: Loader2,      color: "text-blue-500",    label: "Uploading" },
    serverQueued: { icon: Clock,        color: "text-slate-500",   label: "In queue" },
    processing:   { icon: Loader2,      color: "text-blue-500",    label: "Processing" },
    done:         { icon: CheckCircle2, color: "text-emerald-500", label: "Done" },
    failed:       { icon: AlertCircle,  color: "text-red-500",     label: "Failed" },
    cancelled:    { icon: X,            color: "text-slate-400",   label: "Cancelled" },
  };
  const s = statusMap[item.status];
  const Icon = s.icon;
  const spinning = item.status === "uploading" || item.status === "processing";

  const hasDebug = !!(item.debug?.vlmEngine || item.debug?.rawText || item.debug?.lineItems?.length);

  return (
      <div className={`rounded-xl border transition-all ${
          active ? "bg-blue-50/50 border-blue-200 shadow-sm" : "bg-white border-slate-100 hover:border-slate-200"
      }`}>
        <div className="px-4 py-3">
          <div className="flex items-center gap-3">
            <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${
                item.status === "done" ? "bg-emerald-50" : item.status === "failed" ? "bg-red-50" : "bg-slate-50"
            }`}>
              <FileText className={`h-4 w-4 ${item.status === "done" ? "text-emerald-500" : item.status === "failed" ? "text-red-400" : "text-slate-400"}`} />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-slate-800 truncate">{item.file.name}</p>
                <span className="text-[10px] text-slate-300">{fmtSize(item.file.size)}</span>
              </div>
              {item.error && <p className="text-[10px] text-red-400 mt-0.5 truncate">{item.error}</p>}
              {item.status === "done" && item.result && <ResultSummary result={item.result} />}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {active && item.elapsed > 0 && (
                  <span className="text-[10px] font-mono text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded">
                {fmtTime(item.elapsed)}
              </span>
              )}
              {isTerminal(item.status) && item.elapsed > 0 && (item.status === "done" || item.status === "failed") && (
                  <span className="text-[10px] text-slate-300">{fmtTime(item.elapsed)}</span>
              )}
              <div className="flex items-center gap-1">
                <Icon className={`h-3.5 w-3.5 ${s.color} ${spinning ? "animate-spin" : ""}`} />
                <span className={`text-[10px] font-medium ${s.color}`}>{s.label}</span>
              </div>
            </div>

            <div className="flex gap-1 shrink-0">
              {hasDebug && (
                  <button
                      onClick={() => setShowDebug(v => !v)}
                      className="p-1.5 rounded-lg hover:bg-slate-800 bg-slate-900 text-green-400"
                      title="Toggle extraction debug"
                  >
                    <Terminal className="h-3.5 w-3.5" />
                  </button>
              )}
              {item.status === "done" && item.invoiceId && (
                  <button onClick={onView} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600" title="View">
                    <Eye className="h-3.5 w-3.5" />
                  </button>
              )}
              {(item.status === "queued" || isTerminal(item.status)) && (
                  <button onClick={onRemove} className="p-1.5 rounded-lg hover:bg-red-50 text-slate-300 hover:text-red-500" title="Remove">
                    <X className="h-3.5 w-3.5" />
                  </button>
              )}
            </div>
          </div>

          {active && <MiniProgress item={item} />}

          {active && item.elapsed > 30 && (
              <p className="text-[10px] text-center text-blue-400 italic mt-1">
                {item.elapsed > 90 ? "Still working — complex documents take longer..." :
                    item.elapsed > 45 ? "OCR on scanned documents can take 1-2 min..." :
                        "Processing in the background — you can leave this page..."}
              </p>
          )}
        </div>

        {/* ── Extraction debug panel ── */}
        {hasDebug && showDebug && (
            <div className="border-t border-slate-100 bg-slate-900 rounded-b-xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-950">
                <Terminal className="h-3 w-3 text-green-400" />
                <span className="text-[10px] font-mono text-slate-300">Extraction Debug</span>
                {item.debug?.vlmEngine && (
                    <span className="bg-green-900 text-green-300 px-1.5 py-0.5 rounded text-[9px] font-mono">
                {item.debug.vlmEngine.toUpperCase()}
              </span>
                )}
              </div>

              <div className="divide-y divide-slate-800">
                {item.debug?.parsedFields && (
                    <div className="px-3 py-2">
                      <p className="text-[9px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Parsed fields</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
                        {[
                          ["Invoice #",  item.debug.parsedFields.invoiceNumber],
                          ["Date",       item.debug.parsedFields.invoiceDate],
                          ["Supplier",   item.debug.parsedFields.supplierName],
                          ["VAT No.",    item.debug.parsedFields.supplierVatNumber],
                          ["Subtotal",   item.debug.parsedFields.subtotal],
                          ["VAT",        item.debug.parsedFields.vatAmount],
                          ["Total",      item.debug.parsedFields.totalAmount],
                          ["Doc type",   item.debug.parsedFields.documentType],
                          ["Confidence", item.debug.parsedFields.classificationConfidence != null
                              ? item.debug.parsedFields.classificationConfidence + "%" : undefined],
                        ].map(([label, val]) => val != null && String(val) !== "" && (
                            <div key={String(label)} className="flex gap-1.5">
                              <span className="text-slate-500 shrink-0 text-[10px]">{label}:</span>
                              <span className="text-slate-200 truncate text-[10px]">{String(val)}</span>
                            </div>
                        ))}
                      </div>
                    </div>
                )}

                {item.debug?.lineItems && item.debug.lineItems.length > 0 && (
                    <div className="px-3 py-2">
                      <p className="text-[9px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                        Line items ({item.debug.lineItems.length})
                      </p>
                      <table className="w-full text-[10px] font-mono">
                        <thead>
                        <tr className="text-slate-500">
                          <th className="text-left pb-1 pr-2">#</th>
                          <th className="text-left pb-1 pr-2">Description</th>
                          <th className="text-right pb-1 pr-2">Qty</th>
                          <th className="text-right pb-1 pr-2">Price</th>
                          <th className="text-right pb-1">Total</th>
                        </tr>
                        </thead>
                        <tbody>
                        {item.debug.lineItems.map((li: any, i: number) => (
                            <tr key={i} className={`border-t border-slate-800 ${
                                li.matchStatus === "matched" ? "text-emerald-400" :
                                    li.matchStatus === "failed"  ? "text-red-400" : "text-slate-300"
                            }`}>
                              <td className="py-0.5 pr-2">{li.lineNumber ?? i + 1}</td>
                              <td className="py-0.5 pr-2 max-w-[160px] truncate">{li.description}</td>
                              <td className="py-0.5 pr-2 text-right">{li.quantity}</td>
                              <td className="py-0.5 pr-2 text-right">{li.unitPrice}</td>
                              <td className="py-0.5 text-right">{li.netAmount ?? li.totalPrice}</td>
                            </tr>
                        ))}
                        </tbody>
                      </table>
                    </div>
                )}

                {item.debug?.rawText && (
                    <div className="px-3 py-2">
                      <p className="text-[9px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                        Raw OCR text ({item.debug.rawText.length} chars)
                      </p>
                      <pre className="text-[10px] text-slate-400 whitespace-pre-wrap font-mono max-h-32 overflow-y-auto leading-4">
                  {item.debug.rawText}
                </pre>
                    </div>
                )}
              </div>
            </div>
        )}
      </div>
  );
}

// ═══════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════
export default function InvoiceUpload() {
  const [, setLocation] = useLocation();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const uploadingIdsRef = useRef<Set<string>>(new Set());
  const cancelledRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const uploadMutation = trpc.invoices.upload.useMutation();
  const utils = trpc.useUtils();

  const activeItems = queue.filter(q => isActive(q.status));
  const queuedCount = queue.filter(q => q.status === "queued").length;
  const doneCount = queue.filter(q => q.status === "done").length;
  const failedCount = queue.filter(q => q.status === "failed").length;
  const hasQueue = queue.length > 0;

  // Any item that has been uploaded and is waiting on / being handled by the server.
  const serverTrackedItems = queue.filter(
      q => q.invoiceId != null && (q.status === "serverQueued" || q.status === "processing")
  );
  const anyServerWork = serverTrackedItems.length > 0;

  // ── Poll the SERVER queue while we have uploaded items in flight ──
  // queueStatus returns { active[], recent[] }. We reconcile our items against it
  // by invoiceId to drive real status/progress/engine and detect completion.
  const queueStatusQuery = trpc.invoices.queueStatus.useQuery(undefined, {
    enabled: anyServerWork,
    refetchInterval: anyServerWork ? 2000 : false,
  });

  useEffect(() => {
    const data = queueStatusQuery.data as any;
    if (!data) return;
    const activeById = new Map<number, any>();
    for (const r of (data.active || [])) activeById.set(Number(r.id), r);
    const recentById = new Map<number, any>();
    for (const r of (data.recent || [])) recentById.set(Number(r.id), r);

    setQueue(prev => prev.map(item => {
      if (item.invoiceId == null) return item;
      if (isTerminal(item.status)) return item;

      const act = activeById.get(item.invoiceId);
      if (act) {
        // still queued or processing on the server
        const st: QueueStatus = act.status === "processing" ? "processing" : "serverQueued";
        return {
          ...item,
          status: st,
          progress: act.progress ?? item.progress,
          engine: act.engine ?? item.engine,
        };
      }
      const rec = recentById.get(item.invoiceId);
      if (rec) {
        // finished (completed | review_needed | failed)
        if (rec.status === "failed") {
          return { ...item, status: "failed", error: rec.errorMessage || "Processing failed", progress: undefined };
        }
        // completed or review_needed → done; detail will be lazy-loaded below
        return {
          ...item,
          status: "done",
          engine: rec.engine ?? item.engine,
          progress: undefined,
          result: item.result ?? { invoiceStatus: rec.status },
        };
      }
      // Not in active or recent yet — keep current (likely just-uploaded, next poll catches it)
      return item;
    }));
  }, [queueStatusQuery.data]);

  // ── Lazy-load full detail (extractedData + line items) for freshly-finished items ──
  // The queue snapshot is lean; fetch getById once per done item to populate the rich
  // ResultSummary + debug panel without bloating the poll.
  useEffect(() => {
    const toLoad = queue.filter(q => q.status === "done" && q.invoiceId != null && !q.detailLoaded);
    if (toLoad.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const item of toLoad) {
        try {
          const data: any = await utils.invoices.getById.fetch({ id: item.invoiceId! });
          if (cancelled || !data) continue;
          const inv = data.invoice;
          const lineItems = data.lineItems || [];
          let extracted: any = {};
          try { extracted = JSON.parse(inv?.extractedData || "{}"); } catch {}

          const matchedCount = lineItems.filter(
              (li: any) => li.matchStatus === "matched" || li.matchStatus === "manual"
          ).length;

          const result: QueueResult = {
            documentType: extracted.documentType || inv?.documentType,
            supplierName: extracted.issuer?.name || extracted.supplierName,
            invoiceNumber: extracted.invoiceNumber || extracted.documentNumber || inv?.invoiceNumber,
            totalAmount: inv?.totalAmount || extracted.totalAmount,
            itemCount: lineItems.length || (extracted.items?.length ?? 0),
            matchedCount,
            invoiceStatus: inv?.status,
          };
          const debug: QueueDebug = {
            vlmEngine: extracted._vlm_engine,
            rawText: extracted._vlm_raw_text || extracted.rawTextPreview,
            parsedFields: Object.keys(extracted).length ? extracted : undefined,
            lineItems,
          };

          setQueue(prev => prev.map(q =>
              q.id === item.id ? { ...q, result, debug, detailLoaded: true } : q
          ));
        } catch {
          // mark loaded anyway so we don't retry forever
          setQueue(prev => prev.map(q => q.id === item.id ? { ...q, detailLoaded: true } : q));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [queue, utils]);

  // ── Tick elapsed timers for active items ──
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (activeItems.length > 0) {
      const activeIds = new Set(activeItems.map(a => a.id));
      timerRef.current = setInterval(() => {
        setQueue(prev => prev.map(q =>
            activeIds.has(q.id) ? { ...q, elapsed: q.elapsed + 1 } : q
        ));
      }, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [activeItems.map(a => a.id).join(",")]);

  // ── Launch UPLOADS (up to MAX_UPLOAD_PARALLEL). Processing is the server's job. ──
  useEffect(() => {
    if (paused) return;
    const running = uploadingIdsRef.current.size;
    const available = MAX_UPLOAD_PARALLEL - running;
    if (available <= 0) return;

    const nextItems = queue
        .filter(q => q.status === "queued" && !uploadingIdsRef.current.has(q.id))
        .slice(0, available);

    for (const item of nextItems) {
      uploadingIdsRef.current.add(item.id);
      uploadFile(item.id);
    }
  }, [queue, paused]);

  // ── Prevent accidental navigation while uploads are still in flight ──
  // (Once uploaded, work survives on the server, so we only guard the upload phase.)
  const uploadsInFlight = queue.some(q => q.status === "uploading") || queuedCount > 0;
  useEffect(() => {
    (window as any).__batchProcessing = uploadsInFlight;
    if (!uploadsInFlight) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Some invoices haven't finished uploading. Leave anyway?";
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      (window as any).__batchProcessing = false;
    };
  }, [uploadsInFlight]);

  // ── Upload one file. After upload, the server has auto-enqueued it; we hand off
  //    to the poller (status → serverQueued) and DO NOT call process(). ──
  const uploadFile = async (itemId: string) => {
    const item = queue.find(q => q.id === itemId);
    if (!item) { uploadingIdsRef.current.delete(itemId); return; }

    setQueue(prev => prev.map(q => q.id === itemId ? { ...q, status: "uploading" as QueueStatus, elapsed: 0 } : q));

    try {
      if (cancelledRef.current.has(itemId)) throw new Error("Cancelled");

      const fileData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(item.file);
      });

      if (cancelledRef.current.has(itemId)) throw new Error("Cancelled");
      const uploadResult = await uploadMutation.mutateAsync({ fileData, fileName: item.file.name });

      // Uploaded + auto-enqueued server-side. Hand off to the poller.
      setQueue(prev => prev.map(q => q.id === itemId
          ? { ...q, status: "serverQueued" as QueueStatus, invoiceId: uploadResult.invoiceId as number, progress: "Waiting in queue…" }
          : q
      ));
    } catch (err: any) {
      const isCancelled = cancelledRef.current.has(itemId) || err.message === "Cancelled";
      setQueue(prev => prev.map(q =>
          q.id === itemId
              ? { ...q, status: (isCancelled ? "cancelled" : "failed") as QueueStatus, error: isCancelled ? undefined : (err.message || "Upload failed") }
              : q
      ));
      if (!isCancelled) {
        toast.error(`Failed: ${item.file.name}`, { description: err.message });
      }
    } finally {
      cancelledRef.current.delete(itemId);
      uploadingIdsRef.current.delete(itemId);
    }
  };

  // ── Add files to queue ──
  const addFiles = useCallback((files: File[]) => {
    const pdfs = files.filter(f => f.type === "application/pdf" || f.name.endsWith(".pdf"));
    if (pdfs.length === 0) { toast.error("Please select PDF files"); return; }
    if (pdfs.length < files.length) toast.info(`${files.length - pdfs.length} non-PDF file(s) skipped`);

    const newItems: QueueItem[] = pdfs.map(file => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      status: "queued",
      elapsed: 0,
    }));

    setQueue(prev => [...prev, ...newItems]);
    toast.success(`${pdfs.length} invoice${pdfs.length > 1 ? "s" : ""} added to queue`);
  }, []);

  // ── Drag & drop ──
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(e.type === "dragenter" || e.type === "dragover");
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(false);
    addFiles(Array.from(e.dataTransfer.files));
  }, [addFiles]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = "";
  };

  const removeItem = (id: string) => {
    const item = queue.find(q => q.id === id);
    if (item && item.status === "uploading") {
      cancelledRef.current.add(id);
    }
    setQueue(prev => prev.filter(q => q.id !== id));
    uploadingIdsRef.current.delete(id);
  };

  const clearDone = () => setQueue(prev => prev.filter(q => !isTerminal(q.status)));

  // ── Batch summary stats ──
  const totalItems = queue.filter(q => q.status === "done" && q.result?.itemCount)
      .reduce((sum, q) => sum + (q.result?.itemCount || 0), 0);
  const totalMatched = queue.filter(q => q.status === "done" && q.result?.matchedCount !== undefined)
      .reduce((sum, q) => sum + (q.result?.matchedCount || 0), 0);
  const needsReviewCount = queue.filter(q => q.status === "done" && q.result?.invoiceStatus === "review_needed").length;

  // "All work done" = nothing local queued, nothing uploading, nothing tracked on server.
  const allFinished = activeItems.length === 0 && queuedCount === 0;

  return (
      <DashboardLayout>
        <div className="space-y-6 max-w-4xl">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Upload Invoices</h1>
              <p className="text-slate-500 mt-0.5 text-sm">
                Drop one or multiple PDF invoices — they’re queued and processed in the background
              </p>
            </div>
            {hasQueue && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5"
                          onClick={() => setLocation("/queue")}>
                    <Layers className="h-3 w-3" /> Open Queue
                  </Button>
                  {queuedCount > 0 && (
                      <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5"
                              onClick={() => setPaused(p => !p)}>
                        {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                        {paused ? "Resume uploads" : "Pause uploads"}
                      </Button>
                  )}
                  {(doneCount > 0 || failedCount > 0) && (
                      <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5" onClick={clearDone}>
                        <X className="h-3 w-3" /> Clear finished
                      </Button>
                  )}
                </div>
            )}
          </div>

          {/* Drop zone */}
          <div
              className={`relative rounded-2xl border-2 border-dashed transition-all duration-300 bg-white cursor-pointer
            ${dragActive ? "border-blue-500 bg-blue-50/50 scale-[1.005]" : "border-slate-200 hover:border-blue-400 hover:bg-slate-50/50"}
            ${hasQueue ? "p-6" : "p-12"}
          `}
              onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
              onClick={() => document.getElementById("fileInput")?.click()}
          >
            <input id="fileInput" type="file" accept="application/pdf" multiple className="hidden" onChange={handleFileSelect} />
            <div className="flex flex-col items-center justify-center gap-3">
              <div className={`rounded-2xl bg-slate-100 flex items-center justify-center ${hasQueue ? "h-10 w-10" : "h-14 w-14"}`}>
                <Upload className={`text-slate-400 ${hasQueue ? "h-5 w-5" : "h-6 w-6"}`} />
              </div>
              <div className="text-center">
                <p className={`font-semibold text-slate-700 ${hasQueue ? "text-sm" : "text-base"}`}>
                  {hasQueue ? "Drop more PDFs here" : "Drop your invoice PDFs here"}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {hasQueue ? "or click to add more" : "Supports multiple files · click to browse"}
                </p>
              </div>
              {!hasQueue && (
                  <div className="flex items-center gap-2 mt-1">
                    <Button variant="outline" size="sm" className="text-xs border-slate-200 text-slate-600 gap-1.5">
                      <FileUp className="h-3.5 w-3.5" /> Select files
                    </Button>
                    <Badge variant="outline" className="text-[10px] text-slate-400 border-slate-200 gap-1">
                      <Layers className="h-3 w-3" /> Processed in background
                    </Badge>
                  </div>
              )}
            </div>
          </div>

          {/* Queue */}
          {hasQueue && (
              <div className="space-y-4">
                {/* Stats bar */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm font-semibold text-slate-800">Upload Queue</h2>
                    {queuedCount > 0 && (
                        <Badge variant="outline" className="text-[10px] text-slate-500 border-slate-200">
                          <Clock className="h-2.5 w-2.5 mr-1" />{queuedCount} to upload
                        </Badge>
                    )}
                    {activeItems.length > 0 && (
                        <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-200 bg-blue-50">
                          <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />{activeItems.length} active
                        </Badge>
                    )}
                    {doneCount > 0 && (
                        <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-200 bg-emerald-50">
                          <CheckCircle2 className="h-2.5 w-2.5 mr-1" />{doneCount} done
                        </Badge>
                    )}
                    {failedCount > 0 && (
                        <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 bg-red-50">
                          <AlertCircle className="h-2.5 w-2.5 mr-1" />{failedCount} failed
                        </Badge>
                    )}
                    {paused && (
                        <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 bg-amber-50">
                          <Pause className="h-2.5 w-2.5 mr-1" />Uploads paused
                        </Badge>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-400">
                {doneCount}/{queue.filter(q => q.status !== "cancelled").length} completed
              </span>
                </div>

                {/* Overall progress */}
                {queue.length > 1 && (
                    <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-500"
                           style={{ width: `${(doneCount / Math.max(queue.filter(q => q.status !== "cancelled").length, 1)) * 100}%` }} />
                    </div>
                )}

                {/* Queue items */}
                <div className="space-y-2">
                  {queue.map(item => (
                      <QueueRow
                          key={item.id}
                          item={item}
                          onRemove={() => removeItem(item.id)}
                          onView={() => item.invoiceId && setLocation(`/invoices/${item.invoiceId}`)}
                      />
                  ))}
                </div>

                {/* Batch complete summary */}
                {allFinished && doneCount > 0 && (
                    <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-3">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-emerald-900">
                            Batch complete — {doneCount} invoice{doneCount > 1 ? "s" : ""} processed
                            {failedCount > 0 && <span className="text-red-600 font-normal"> ({failedCount} failed)</span>}
                          </p>
                        </div>
                        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs h-8 shrink-0"
                                onClick={() => setLocation("/invoices")}>
                          View Invoices
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-3 pl-8">
                        {totalItems > 0 && (
                            <span className="text-xs text-emerald-700">
                      <span className="font-semibold">{totalItems}</span> line items extracted
                    </span>
                        )}
                        {totalItems > 0 && (
                            <span className="text-xs text-emerald-700">
                      <span className="font-semibold">{totalMatched}/{totalItems}</span> auto-matched ({totalItems > 0 ? Math.round(totalMatched / totalItems * 100) : 0}%)
                    </span>
                        )}
                        {needsReviewCount > 0 && (
                            <span className="text-xs text-amber-700">
                      <span className="font-semibold">{needsReviewCount}</span> need review
                    </span>
                        )}
                      </div>
                    </div>
                )}
              </div>
          )}

          {/* Info cards — show when queue is empty */}
          {!hasQueue && (
              <>
                <div className="bg-white rounded-2xl border border-slate-200 p-6">
                  <h3 className="text-sm font-semibold text-slate-800 mb-5">What happens after upload</h3>
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { icon: FileText, title: "Data Extraction", desc: "Supplier info, line items, and totals are extracted from the PDF", color: "blue" },
                      { icon: Sparkles, title: "Product Matching", desc: "AI matches supplier codes to your ERP codes with confidence scores", color: "amber" },
                      { icon: Brain, title: "Review & Confirm", desc: "High-confidence matches are auto-accepted, review the rest", color: "emerald" },
                      { icon: Zap, title: "ERP + Catalog", desc: "Push confirmed invoices to your ERP and OptimusDB catalog", color: "violet" },
                    ].map((step, i) => (
                        <div key={i} className="flex gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                          <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                              step.color === "blue" ? "bg-blue-50 text-blue-500" :
                                  step.color === "amber" ? "bg-amber-50 text-amber-500" :
                                      step.color === "emerald" ? "bg-emerald-50 text-emerald-500" :
                                          "bg-violet-50 text-violet-500"
                          }`}>
                            <step.icon className="h-4 w-4" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-slate-700">{step.title}</p>
                            <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{step.desc}</p>
                          </div>
                        </div>
                    ))}
                  </div>
                </div>

                <div className="bg-blue-50/70 rounded-2xl border border-blue-100 p-5">
                  <p className="text-xs font-semibold text-blue-800 uppercase tracking-wide mb-3">Tips for best results</p>
                  <div className="space-y-2">
                    {[
                      "Drop multiple PDFs at once — they’re queued and processed in the background",
                      "Use clear, high-quality PDF invoices",
                      "The system learns from corrections and improves over time",
                      "After 3 similar corrections, transformation rules are auto-created",
                    ].map((tip, i) => (
                        <div key={i} className="flex items-start gap-2.5">
                          <CheckCircle2 className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
                          <span className="text-sm text-blue-800">{tip}</span>
                        </div>
                    ))}
                  </div>
                </div>
              </>
          )}
        </div>
      </DashboardLayout>
  );
}
