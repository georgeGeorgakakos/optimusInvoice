import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Clock,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  ArrowRight,
  Loader2,
  Sparkles,
} from "lucide-react";

/**
 * Tier-1 dashboard widgets. All derive from data the Dashboard already fetches:
 *   stats.invoiceStats, stats.matchStats, analytics (recentInvoices, dailyVolume)
 *
 * Tune this to your real average. It's how long a human takes to key one
 * invoice by hand — the basis for the "time / money saved" hero.
 */
export const MINUTES_PER_MANUAL_INVOICE = 8;
export const COST_PER_HOUR = 25; // blended AP-clerk cost, your currency

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(n);

/* ── 1. Hero: time & money saved, with count-up animation ───────────────── */

function useCountUp(target: number, ms = 900) {
  const [val, setVal] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(target * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, ms]);
  return val;
}

export function SavingsHero({
  totalProcessed,
  firstName,
  pendingReview,
  pendingApprovals,
}: {
  totalProcessed: number;
  firstName?: string;
  pendingReview: number;
  pendingApprovals: number;
}) {
  const minutesSaved = totalProcessed * MINUTES_PER_MANUAL_INVOICE;
  const hoursSaved = minutesSaved / 60;
  const moneySaved = hoursSaved * COST_PER_HOUR;

  const animHours = useCountUp(hoursSaved);
  const animMoney = useCountUp(moneySaved);

  const greeting = (() => {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    return firstName ? `${part}, ${firstName}` : part;
  })();

  const actionLine = (() => {
    const bits: string[] = [];
    if (pendingReview > 0)
      bits.push(`${pendingReview} invoice${pendingReview > 1 ? "s" : ""} need review`);
    if (pendingApprovals > 0)
      bits.push(`${pendingApprovals} approval${pendingApprovals > 1 ? "s" : ""} waiting`);
    return bits.length ? bits.join(" · ") : "You're all caught up.";
  })();

  return (
    <div
      className="relative overflow-hidden rounded-2xl p-6 text-white"
      style={{ background: "linear-gradient(120deg,#0a0e1a 0%,#1b1b3a 55%,#2a1a4a 100%)" }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full opacity-40"
        style={{ background: "radial-gradient(circle,#6366F1,transparent 70%)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-28 left-10 h-64 w-64 rounded-full opacity-30"
        style={{ background: "radial-gradient(circle,#22D3EE,transparent 70%)" }}
      />
      <div className="relative z-10">
        <p className="text-sm text-white/60">{greeting}</p>
        <p className="text-sm text-white/80 mt-0.5">{actionLine}</p>

        <div className="mt-5 flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <div className="flex items-baseline gap-1.5">
              <span
                className="text-4xl font-bold tabular-nums"
                style={{
                  backgroundImage: "linear-gradient(120deg,#22D3EE,#A855F7)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                {Math.round(animHours).toLocaleString()}
              </span>
              <span className="text-lg text-white/70">hrs</span>
            </div>
            <p className="text-xs text-white/50 mt-1">Staff time saved</p>
          </div>
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-4xl font-bold tabular-nums text-white">
                {fmtCurrency(animMoney)}
              </span>
            </div>
            <p className="text-xs text-white/50 mt-1">Estimated cost avoided</p>
          </div>
          <div className="ml-auto text-right">
            <div className="text-2xl font-bold tabular-nums text-white">
              {totalProcessed.toLocaleString()}
            </div>
            <p className="text-xs text-white/50 mt-1">Invoices automated</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 2. KPI card with sparkline + delta ─────────────────────────────────── */

function Sparkline({ data, stroke }: { data: number[]; stroke: string }) {
  if (!data.length) return null;
  const w = 64;
  const h = 22;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1 || 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function KpiCard({
  label,
  value,
  icon: Icon,
  accent,
  trend,
  deltaPct,
}: {
  label: string;
  value: React.ReactNode;
  icon: any;
  accent: string; // hex
  trend?: number[];
  deltaPct?: number | null;
}) {
  const up = (deltaPct ?? 0) >= 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        <div
          className="h-7 w-7 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${accent}1a` }}
        >
          <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
        </div>
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className="text-xl font-bold" style={{ color: accent }}>
          {value}
        </p>
        {trend && trend.length > 1 && <Sparkline data={trend} stroke={accent} />}
      </div>
      {deltaPct != null && (
        <div
          className={`mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium ${
            up ? "text-emerald-600" : "text-rose-600"
          }`}
        >
          {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {Math.abs(deltaPct)}% vs last week
        </div>
      )}
    </div>
  );
}

/* ── 3. Live processing strip ───────────────────────────────────────────── */

export function LiveProcessingStrip({ recentInvoices }: { recentInvoices: any[] }) {
  const processing = (recentInvoices || []).filter(
    (i: any) => i.status === "processing" || i.status === "pending"
  );
  if (processing.length === 0) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-2.5">
      <Loader2 className="h-4 w-4 animate-spin text-indigo-600 shrink-0" />
      <span className="text-sm text-indigo-900">
        {processing.length} invoice{processing.length > 1 ? "s" : ""} in progress
      </span>
      <div className="flex items-center gap-2 overflow-hidden">
        {processing.slice(0, 3).map((i: any) => (
          <span
            key={i.id}
            className="text-xs font-medium text-indigo-700 bg-white/70 rounded-full px-2.5 py-0.5 whitespace-nowrap"
          >
            {i.invoiceNumber ?? `#${i.id}`}
          </span>
        ))}
        {processing.length > 3 && (
          <span className="text-xs text-indigo-500">+{processing.length - 3}</span>
        )}
      </div>
      <div className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-indigo-100">
        <div
          className="h-full animate-pulse rounded-full"
          style={{ width: "66%", backgroundImage: "linear-gradient(90deg,#22D3EE,#6366F1)" }}
        />
      </div>
    </div>
  );
}

/* ── 4. Exception spotlight: the one thing that needs a human ────────────── */

export function ExceptionSpotlight({
  pendingReview,
  pendingApprovals,
  failed,
}: {
  pendingReview: number;
  pendingApprovals: number;
  failed: number;
}) {
  const [, setLocation] = useLocation();

  const item = (() => {
    if (failed > 0)
      return {
        tone: "rose" as const,
        icon: AlertCircle,
        title: `${failed} invoice${failed > 1 ? "s" : ""} failed to process`,
        body: "Re-run extraction or check the source files.",
        cta: "Review failures",
        to: "/invoices",
      };
    if (pendingReview > 0)
      return {
        tone: "amber" as const,
        icon: Sparkles,
        title: `${pendingReview} invoice${pendingReview > 1 ? "s" : ""} need your review`,
        body: "Low-confidence fields are waiting for a quick check.",
        cta: "Open review queue",
        to: "/invoices",
      };
    if (pendingApprovals > 0)
      return {
        tone: "indigo" as const,
        icon: Clock,
        title: `${pendingApprovals} approval${pendingApprovals > 1 ? "s" : ""} waiting`,
        body: "Approve or reject to keep invoices moving to your ERP.",
        cta: "Go to approvals",
        to: "/approvals",
      };
    return null;
  })();

  if (!item) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3">
        <div className="h-8 w-8 rounded-lg bg-emerald-100 flex items-center justify-center">
          <TrendingUp className="h-4 w-4 text-emerald-600" />
        </div>
        <div>
          <p className="text-sm font-medium text-emerald-900">Nothing needs you right now</p>
          <p className="text-xs text-emerald-700/80">Every invoice is processed and clear.</p>
        </div>
      </div>
    );
  }

  const tones = {
    rose: { border: "border-rose-200", bg: "bg-rose-50/60", chip: "bg-rose-100", icon: "text-rose-600", title: "text-rose-900", body: "text-rose-700/80" },
    amber: { border: "border-amber-200", bg: "bg-amber-50/60", chip: "bg-amber-100", icon: "text-amber-600", title: "text-amber-900", body: "text-amber-700/80" },
    indigo: { border: "border-indigo-200", bg: "bg-indigo-50/60", chip: "bg-indigo-100", icon: "text-indigo-600", title: "text-indigo-900", body: "text-indigo-700/80" },
  }[item.tone];

  return (
    <div className={`flex items-center gap-3 rounded-xl border ${tones.border} ${tones.bg} px-4 py-3`}>
      <div className={`h-8 w-8 rounded-lg ${tones.chip} flex items-center justify-center shrink-0`}>
        <item.icon className={`h-4 w-4 ${tones.icon}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${tones.title} truncate`}>{item.title}</p>
        <p className={`text-xs ${tones.body} truncate`}>{item.body}</p>
      </div>
      <button
        onClick={() => setLocation(item.to)}
        className={`shrink-0 inline-flex items-center gap-1 text-xs font-medium ${tones.icon} hover:underline`}
      >
        {item.cta} <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
}
