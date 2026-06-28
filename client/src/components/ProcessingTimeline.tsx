import { useMemo } from "react";
import {
  Check,
  Loader2,
  Minus,
  XCircle,
  Cpu,
  ScanText,
  FileSearch,
  Save,
  Download,
  Inbox,
  Route,
} from "lucide-react";

/**
 * One structured pipeline step, mirrors server/invoiceDb.ts ProcessingStep.
 */
export interface ProcessingStep {
  stage: string;
  engine?: string;
  path?: "a" | "b";
  status: "running" | "done" | "skipped" | "error";
  reasoning?: string;
  at: string;
}

const STAGE_ICON: Record<string, any> = {
  "Queue claim": Inbox,
  "Download PDF": Download,
  "Engine routing": Route,
  "OCR / reader": ScanText,
  "Vision → JSON": Cpu,
  "Semantic extract": FileSearch,
  "Match & save": Save,
};

function StatusDot({ status }: { status: ProcessingStep["status"] }) {
  if (status === "done")
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-emerald-500 bg-white text-emerald-600">
        <Check className="h-3.5 w-3.5" />
      </span>
    );
  if (status === "running")
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-blue-500 bg-white text-blue-600">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </span>
    );
  if (status === "skipped")
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-slate-300 bg-white text-slate-400">
        <Minus className="h-3.5 w-3.5" />
      </span>
    );
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-red-500 bg-white text-red-600">
      <XCircle className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * Live processing timeline for the Invoice Details page.
 *
 * Reads invoice.processingSteps (a JSON string of ProcessingStep[]) and renders
 * each stage with its engine, status, and the reasoning behind any routing
 * decision. Shows which of the two extraction paths a run took:
 *   Path A — OCR/reader → Qwen2.5-3B semantic → JSON
 *   Path B — vision model → JSON directly (OCR step skipped)
 *
 * The parent already polls getById every 2s while status is queued/processing,
 * so this updates live with no extra wiring.
 */
export default function ProcessingTimeline({
  stepsJson,
  status,
}: {
  stepsJson?: string | null;
  status?: string;
}) {
  const steps = useMemo<ProcessingStep[]>(() => {
    if (!stepsJson) return [];
    try {
      const parsed = JSON.parse(stepsJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [stepsJson]);

  if (steps.length === 0) {
    if (status === "queued" || status === "processing") {
      return (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Waiting for the worker to start…
        </div>
      );
    }
    return null;
  }

  const path = steps.find((s) => s.path)?.path;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-medium text-slate-700">Processing timeline</span>
        {path && (
          <span
            className={
              "rounded-md px-2 py-0.5 text-xs font-medium " +
              (path === "a"
                ? "bg-blue-50 text-blue-700"
                : "bg-violet-50 text-violet-700")
            }
          >
            {path === "a" ? "Path A · OCR → semantic" : "Path B · vision → JSON"}
          </span>
        )}
      </div>

      <ol className="relative">
        {steps.map((s, i) => {
          const Icon = STAGE_ICON[s.stage];
          const isLast = i === steps.length - 1;
          const dim = s.status === "skipped";
          return (
            <li key={s.stage + i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <StatusDot status={s.status} />
                {!isLast && (
                  <span
                    className={
                      "w-0.5 flex-1 " +
                      (s.status === "done"
                        ? "bg-emerald-500"
                        : s.status === "skipped"
                          ? "bg-slate-200"
                          : "bg-slate-200")
                    }
                    style={{ minHeight: 16 }}
                  />
                )}
              </div>
              <div className={"pb-4 " + (dim ? "opacity-50" : "")}>
                <div className="flex items-center gap-2">
                  {Icon && <Icon className="h-4 w-4 text-slate-400" />}
                  <span className="text-sm font-medium text-slate-800">{s.stage}</span>
                  {s.engine && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                      {s.engine}
                    </span>
                  )}
                </div>
                {s.reasoning && (
                  <p className="mt-1 border-l-2 border-blue-200 bg-slate-50 px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-slate-600">
                    {s.reasoning}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
