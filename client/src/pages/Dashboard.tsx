import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import {
  FileText, Upload, Brain, Settings, TrendingUp, Clock, CheckCircle2,
  AlertCircle, Sparkles, ArrowUpRight, Database, BarChart3, Users, Zap,
} from "lucide-react";
import { useLocation } from "wouter";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area,
} from "recharts";
import {
  SavingsHero, KpiCard, LiveProcessingStrip, ExceptionSpotlight,
} from "@/components/DashboardWidgets";

const STATUS_COLORS: Record<string, string> = {
  completed: "#10b981", review_needed: "#f59e0b", pending: "#6366f1",
  processing: "#22d3ee", failed: "#ef4444",
};
// Brand ramp: cyan → indigo → violet, plus semantic green/amber
const PIE_COLORS = ["#6366f1", "#22d3ee", "#a855f7", "#10b981", "#f59e0b"];
const BRAND = { cyan: "#22d3ee", indigo: "#6366f1", violet: "#a855f7" };

// Reusable gradient-text class (cyan → indigo → violet brand ramp)
const GRADIENT_TEXT =
    "bg-gradient-to-r from-cyan-400 via-indigo-500 to-violet-500 bg-clip-text text-transparent";

// ── Fancy CSS: staggered entrance + shimmer skeletons ────────────────────────
// Scoped under .dash-root so it never leaks. Pure CSS, no deps. Renders once.
const DASH_STYLES = `
@keyframes dashFadeRise {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes dashShimmer {
  0%   { background-position: -468px 0; }
  100% { background-position: 468px 0; }
}
/* Respect reduced-motion preferences */
@media (prefers-reduced-motion: reduce) {
  .dash-root .dash-stagger > * { animation: none !important; opacity: 1 !important; transform: none !important; }
  .dash-root .dash-shimmer { animation: none !important; }
}
.dash-root .dash-stagger > * {
  opacity: 0;
  animation: dashFadeRise 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
.dash-root .dash-stagger > *:nth-child(1) { animation-delay: 0.00s; }
.dash-root .dash-stagger > *:nth-child(2) { animation-delay: 0.06s; }
.dash-root .dash-stagger > *:nth-child(3) { animation-delay: 0.12s; }
.dash-root .dash-stagger > *:nth-child(4) { animation-delay: 0.18s; }
.dash-root .dash-stagger > *:nth-child(5) { animation-delay: 0.24s; }
.dash-root .dash-stagger > *:nth-child(6) { animation-delay: 0.30s; }
.dash-root .dash-stagger > *:nth-child(7) { animation-delay: 0.36s; }
.dash-root .dash-shimmer {
  background: linear-gradient(90deg, #f1f5f9 0px, #e9eef5 40px, #f1f5f9 80px);
  background-size: 600px 100%;
  animation: dashShimmer 1.4s ease-in-out infinite;
  border-radius: 8px;
}
`;

// Shimmer skeleton block — premium loading state (replaces bare spinners)
function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`dash-shimmer ${className}`} />;
}

function fmtDate(d: string | Date | null) {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("el-GR", { day: "2-digit", month: "short" }) + " " + dt.toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" });
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    completed: { label: "Completed", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    review_needed: { label: "Review", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    pending: { label: "Pending", cls: "bg-slate-50 text-slate-600 border-slate-200" },
    processing: { label: "Processing", cls: "bg-blue-50 text-blue-700 border-blue-200" },
    failed: { label: "Failed", cls: "bg-red-50 text-red-600 border-red-200" },
  };
  const s = map[status] || map.pending;
  return <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${s.cls}`}>{s.label}</Badge>;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { data: stats, isLoading } = trpc.invoices.statistics.useQuery();
  const { data: analytics, isLoading: loadingAnalytics } = trpc.invoices.analytics.useQuery();
  const { data: kbStats } = trpc.knowledgeBase.stats.useQuery();
  const { data: approvalsPending } = trpc.approvals.pendingCount.useQuery();
  const pendingApprovals = Number(approvalsPending?.count || 0);

  const inv = stats?.invoiceStats;
  const match = stats?.matchStats;
  const automationRate = match?.total ? Math.round((Number(match.matched || 0) / Number(match.total)) * 100) : 0;

  // Fill missing days for daily chart
  const dailyChart = (() => {
    const raw = (analytics?.dailyVolume || []) as any[];
    // Normalize date keys — handle Date objects, strings, or timestamps
    const map = new Map<string, any>();
    for (const r of raw) {
      let key: string;
      if (r.date instanceof Date) {
        key = r.date.toISOString().split("T")[0];
      } else if (typeof r.date === "string") {
        // Could be "2026-02-21" or "2026-02-21T00:00:00.000Z"
        key = r.date.split("T")[0];
      } else {
        key = new Date(r.date).toISOString().split("T")[0];
      }
      map.set(key, r);
    }
    const days: { date: string; label: string; total: number; completed: number; failed: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const entry = map.get(key);
      days.push({
        date: key,
        label: d.toLocaleDateString("el-GR", { day: "2-digit", month: "short" }),
        total: Number(entry?.total || 0),
        completed: Number(entry?.completed || 0),
        failed: Number(entry?.failed || 0),
      });
    }
    return days;
  })();

  // Pie data for match status
  const matchPie = match ? [
    { name: "Matched", value: Number(match.matched || 0) },
    { name: "Manual", value: Number(match.manual || 0) },
    { name: "Pending", value: Number(match.pending || 0) },
    { name: "Failed", value: Number(match.failed || 0) },
  ].filter(d => d.value > 0) : [];

  // Supplier bar chart
  const supplierChart = ((analytics?.supplierBreakdown || []) as any[]).map((s: any) => ({
    name: (s.supplierName || "Unknown").substring(0, 20),
    invoices: Number(s.count),
  }));

  // 7-day trend slices for KPI sparklines + week-over-week delta
  const last7 = dailyChart.slice(-7);
  const prev7 = dailyChart.slice(-14, -7);
  const totalTrend = last7.map(d => d.total);
  const completedTrend = last7.map(d => d.completed);
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const weekDelta = (cur: number[], prev: number[]) => {
    const p = sum(prev);
    if (p === 0) return cur.length && sum(cur) > 0 ? 100 : null;
    return Math.round(((sum(cur) - p) / p) * 100);
  };
  const totalDelta = weekDelta(totalTrend, prev7.map(d => d.total));
  const completedDelta = weekDelta(completedTrend, prev7.map(d => d.completed));
  const recent = (analytics?.recentInvoices || []) as any[];
  const failedCount = Number((inv as any)?.failed || 0);

  return (
      <DashboardLayout>
        {/* Fancy entrance + shimmer styles (scoped to .dash-root, renders once) */}
        <style dangerouslySetInnerHTML={{ __html: DASH_STYLES }} />
        <div className="dash-root">
          <div className="dash-stagger space-y-5 max-w-7xl">
            {/* Hero: time & money saved + greeting */}
            <SavingsHero
                totalProcessed={Number(inv?.total || 0)}
                firstName={user?.name?.split(" ")[0]}
                pendingReview={Number(inv?.reviewNeeded || 0) + Number(inv?.pending || 0)}
                pendingApprovals={pendingApprovals}
            />

            {/* Live processing strip (only renders when something is in flight) */}
            <LiveProcessingStrip recentInvoices={recent} />

            {/* Exception spotlight: the one thing that needs a human */}
            <ExceptionSpotlight
                pendingReview={Number(inv?.reviewNeeded || 0)}
                pendingApprovals={pendingApprovals}
                failed={failedCount}
            />

            {/* KPI cards with sparklines */}
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
              <KpiCard label="Total Invoices" value={isLoading ? "…" : (inv?.total ?? 0)} icon={FileText} accent="#6366f1" trend={totalTrend} deltaPct={totalDelta} />
              <KpiCard label="Completed" value={isLoading ? "…" : (inv?.completed ?? 0)} icon={CheckCircle2} accent="#10b981" trend={completedTrend} deltaPct={completedDelta} />
              <KpiCard label="Needs Review" value={isLoading ? "…" : Number(inv?.reviewNeeded || 0) + Number(inv?.pending || 0)} icon={Clock} accent="#f59e0b" />
              <KpiCard label="Automation Rate" value={`${automationRate}%`} icon={TrendingUp} accent="#22d3ee" />
              <KpiCard label="Avg Items/Invoice" value={analytics?.avgItemsPerInvoice ?? "—"} icon={BarChart3} accent="#a855f7" />
              <KpiCard label="KB Mappings" value={kbStats?.mappings ?? "—"} icon={Database} accent="#8b5cf6" />
            </div>

            {/* Charts row */}
            <div className="grid lg:grid-cols-3 gap-5">
              {/* Daily volume area chart */}
              <Card className="lg:col-span-2 shadow-none border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Invoice Volume (Last 30 Days)</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {loadingAnalytics ? (
                      <div className="h-[200px] flex flex-col justify-end gap-2 px-2 pb-2">
                        {/* Shimmer skeleton evoking the area chart shape */}
                        <div className="flex items-end gap-1.5 h-full">
                          {[40, 65, 50, 80, 60, 90, 70, 95, 75, 88, 62, 100].map((h, i) => (
                              <Skeleton key={i} className="flex-1" style={{ height: `${h}%` } as any} />
                          ))}
                        </div>
                      </div>
                  ) : dailyChart.every(d => d.total === 0) ? (
                      <div className="flex flex-col items-center justify-center h-[200px] gap-3">
                        <div className="h-12 w-12 rounded-2xl flex items-center justify-center text-white" style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}>
                          <BarChart3 className="h-6 w-6" />
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-medium text-foreground">No volume to chart yet</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Processed invoices will trend here daily</p>
                        </div>
                      </div>
                  ) : (
                      <ResponsiveContainer width="100%" height={200}>
                        <AreaChart data={dailyChart} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                          <defs>
                            <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.22} />
                              <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="colorCompleted" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.22} />
                              <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
                          <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} allowDecimals={false} tickLine={false} axisLine={false} />
                          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
                                   labelStyle={{ fontWeight: 600 }} />
                          <Area type="monotone" dataKey="total" name="Total" stroke="#6366f1" strokeWidth={2}
                                fill="url(#colorTotal)" dot={false} isAnimationActive animationDuration={900} />
                          <Area type="monotone" dataKey="completed" name="Completed" stroke="#22d3ee" strokeWidth={2}
                                fill="url(#colorCompleted)" dot={false} isAnimationActive animationDuration={1100} />
                        </AreaChart>
                      </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              {/* Match status pie */}
              <Card className="shadow-none border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Match Status</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {matchPie.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-[200px] gap-3">
                        <div className="h-12 w-12 rounded-2xl flex items-center justify-center text-white" style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}>
                          <Zap className="h-6 w-6" />
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-medium text-foreground">Nothing matched yet</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Line-item matches appear once invoices process</p>
                        </div>
                      </div>
                  ) : (
                      <div className="flex items-center gap-4">
                        <div className="relative" style={{ width: "50%" }}>
                          <ResponsiveContainer width="100%" height={180}>
                            <PieChart>
                              <defs>
                                <linearGradient id="donutBrand" x1="0" y1="0" x2="1" y2="1">
                                  <stop offset="0%" stopColor="#22d3ee" />
                                  <stop offset="55%" stopColor="#6366f1" />
                                  <stop offset="100%" stopColor="#a855f7" />
                                </linearGradient>
                              </defs>
                              <Pie data={matchPie} cx="50%" cy="50%" innerRadius={48} outerRadius={72}
                                   paddingAngle={matchPie.length > 1 ? 3 : 0} dataKey="value" stroke="none" cornerRadius={6}
                                   isAnimationActive animationDuration={900}>
                                {matchPie.map((d, i) => (
                                    <Cell key={i} fill={d.name?.toLowerCase().includes("match") ? "url(#donutBrand)" : PIE_COLORS[i % PIE_COLORS.length]} />
                                ))}
                              </Pie>
                              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }} />
                            </PieChart>
                          </ResponsiveContainer>
                          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <span className={`text-xl font-bold tabular-nums leading-none ${GRADIENT_TEXT}`}>
                        {matchPie.reduce((s, d) => s + Number(d.value || 0), 0)}
                      </span>
                            <span className="text-[10px] text-muted-foreground mt-0.5">total</span>
                          </div>
                        </div>
                        <div className="space-y-2 flex-1">
                          {matchPie.map((d, i) => (
                              <div key={d.name} className="flex items-center gap-2 text-xs">
                                <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: d.name?.toLowerCase().includes("match") ? "linear-gradient(120deg,#22d3ee,#6366f1,#a855f7)" : PIE_COLORS[i % PIE_COLORS.length] }} />
                                <span className="text-muted-foreground flex-1">{d.name}</span>
                                <span className="font-semibold text-foreground tabular-nums">{d.value}</span>
                              </div>
                          ))}
                        </div>
                      </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Second row: Supplier breakdown + Recent Activity */}
            <div className="grid lg:grid-cols-5 gap-5">
              {/* Supplier bar chart */}
              <Card className="lg:col-span-2 shadow-none border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Top Suppliers</CardTitle>
                  <CardDescription className="text-xs">By invoice count</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  {supplierChart.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-[200px] gap-3">
                        <div className="h-12 w-12 rounded-2xl flex items-center justify-center text-white" style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}>
                          <Users className="h-6 w-6" />
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-medium text-foreground">No suppliers yet</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Your top vendors rank here by volume</p>
                        </div>
                      </div>
                  ) : (
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={supplierChart} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="barBrand" x1="0" y1="0" x2="1" y2="0">
                              <stop offset="0%" stopColor="#22d3ee" />
                              <stop offset="100%" stopColor="#6366f1" />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                          <XAxis type="number" tick={{ fontSize: 10, fill: "#94a3b8" }} allowDecimals={false} tickLine={false} axisLine={false} />
                          <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#64748b" }} width={100} tickLine={false} axisLine={false} />
                          <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }} cursor={{ fill: "rgba(99,102,241,0.06)" }} />
                          <Bar dataKey="invoices" fill="url(#barBrand)" radius={[0, 4, 4, 0]} barSize={16} isAnimationActive animationDuration={900} />
                        </BarChart>
                      </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              {/* Recent Activity feed */}
              <Card className="lg:col-span-3 shadow-none border-border">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">Recent Activity</CardTitle>
                    <Button variant="ghost" size="sm" className="text-xs h-7 text-indigo-600 hover:text-indigo-700" onClick={() => setLocation("/invoices")}>
                      View all <ArrowUpRight className="h-3 w-3 ml-1" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {loadingAnalytics ? (
                      <div className="space-y-1.5 py-1">
                        {/* Shimmer skeleton rows mirroring the activity item layout */}
                        {[0, 1, 2, 3, 4].map((i) => (
                            <div key={i} className="flex items-center gap-3 p-2.5">
                              <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
                              <div className="flex-1 space-y-1.5">
                                <Skeleton className="h-2.5 w-1/3" />
                                <Skeleton className="h-2 w-2/3" />
                              </div>
                            </div>
                        ))}
                      </div>
                  ) : !analytics?.recentInvoices?.length ? (
                      <div className="text-center py-10">
                        <div className="h-12 w-12 rounded-2xl flex items-center justify-center mx-auto mb-3 text-white" style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}>
                          <FileText className="h-6 w-6" />
                        </div>
                        <p className="text-sm font-medium text-foreground">No activity yet</p>
                        <p className="text-xs text-muted-foreground mt-1 mb-3">Upload your first invoice to get started</p>
                        <Button size="sm" onClick={() => setLocation("/invoices/upload")} className="border-0 text-white text-xs h-8 hover:brightness-110" style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}>
                          <Upload className="h-3 w-3 mr-1.5" /> Upload
                        </Button>
                      </div>
                  ) : (
                      <div className="space-y-1">
                        {(analytics.recentInvoices as any[]).map((inv: any) => (
                            <button key={inv.id} onClick={() => setLocation(`/invoices/${inv.id}`)}
                                    className="group relative w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-all duration-200 hover:bg-muted/50 hover:translate-x-0.5 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-gradient-to-b before:from-cyan-400 before:to-violet-500 before:opacity-0 before:transition-opacity hover:before:opacity-100">
                              <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                                  inv.status === "completed" ? "bg-emerald-50" :
                                      inv.status === "failed" ? "bg-red-50" : "bg-blue-50"
                              }`}>
                                {inv.status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> :
                                    inv.status === "failed" ? <AlertCircle className="h-3.5 w-3.5 text-red-500" /> :
                                        <Clock className="h-3.5 w-3.5 text-blue-500" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs font-medium text-slate-800 truncate">
                                    {inv.invoiceNumber || `Invoice #${inv.id}`}
                                  </p>
                                  <StatusBadge status={inv.status} />
                                </div>
                                <p className="text-[10px] text-slate-400 truncate">
                                  {inv.supplierName || "Unknown supplier"} · {fmtDate(inv.processedAt || inv.createdAt)}
                                  {inv.totalAmount ? ` · €${inv.totalAmount}` : ""}
                                </p>
                              </div>
                              <ArrowUpRight className="h-3 w-3 text-slate-300 group-hover:text-blue-500 shrink-0" />
                            </button>
                        ))}
                      </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Quick Actions row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { icon: Upload, label: "Upload Invoice", path: "/invoices/upload", primary: true },
                { icon: FileText, label: "View Invoices", path: "/invoices", primary: false },
                { icon: Database, label: "Knowledge Base", path: "/knowledge-base", primary: false },
                { icon: Settings, label: "Configuration", path: "/configuration", primary: false },
              ].map((action) => (
                  <button key={action.path} onClick={() => setLocation(action.path)}
                          className={`flex items-center gap-3 p-4 rounded-xl border transition-all duration-200 text-left hover:-translate-y-0.5 ${
                              action.primary
                                  ? "bg-primary border-primary text-white hover:bg-primary/90 shadow-lg shadow-primary/15 hover:shadow-xl hover:shadow-primary/25"
                                  : "bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:shadow-md"
                          }`}>
                    <action.icon className={`h-5 w-5 shrink-0 ${action.primary ? "text-blue-200" : "text-slate-400"}`} />
                    <span className="text-sm font-medium">{action.label}</span>
                  </button>
              ))}
            </div>
          </div>
        </div>
      </DashboardLayout>
  );
}
