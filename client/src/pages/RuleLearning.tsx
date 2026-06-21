import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import {
  Brain, Zap, Search, X, Trash2, Edit2, AlertCircle, CheckCircle2,
  GitBranch, Users, TrendingUp, Filter,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "Never";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("el-GR", { day: "2-digit", month: "short", year: "numeric" });
}

const RULE_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  prefix_addition:       { label: "Prefix +",       color: "bg-blue-50 text-blue-700 border-blue-200" },
  suffix_addition:       { label: "Suffix +",       color: "bg-blue-50 text-blue-700 border-blue-200" },
  prefix_removal:        { label: "Prefix −",       color: "bg-amber-50 text-amber-700 border-amber-200" },
  suffix_removal:        { label: "Suffix −",       color: "bg-amber-50 text-amber-700 border-amber-200" },
  separator_removal:     { label: "Sep removal",    color: "bg-slate-50 text-slate-600 border-slate-200" },
  character_replacement: { label: "Char replace",   color: "bg-violet-50 text-violet-700 border-violet-200" },
  regex_pattern:         { label: "Regex",          color: "bg-rose-50 text-rose-700 border-rose-200" },
};

export default function RuleLearning() {
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [editRule, setEditRule] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  // ── Queries ──
  const { data: dbRules = [], isLoading: loadingDb, refetch: refetchDb } = trpc.knowledgeBase.rules.useQuery();
  const { data: pyRules = [], isLoading: loadingPy } = trpc.rules.list.useQuery();
  const { data: suppliers = [] } = trpc.knowledgeBase.suppliers.useQuery();
  const { data: kbStats } = trpc.knowledgeBase.stats.useQuery();

  // ── Mutations ──
  const deleteRuleMut = trpc.knowledgeBase.deleteRule.useMutation({
    onSuccess: () => { refetchDb(); setDeleteTarget(null); toast.success("Rule deleted"); },
  });
  const updateRuleMut = trpc.knowledgeBase.updateRule.useMutation({
    onSuccess: () => { refetchDb(); setEditRule(null); toast.success("Rule updated"); },
  });

  // Merge DB rules + Python-detected rules (deduplicate by pattern)
  const allRules = useMemo(() => {
    const dbPatterns = new Set((dbRules as any[]).map((r: any) => `${r.ruleType}:${r.pattern}`));
    const pyOnly = (pyRules as any[]).filter((r: any) =>
      !dbPatterns.has(`${r.ruleType || r.rule_type}:${r.pattern}`)
    ).map((r: any) => ({
      ...r,
      id: r.id || `py-${r.pattern}`,
      ruleType: r.ruleType || r.rule_type,
      confidence: r.confidence ? String(Math.round(parseFloat(r.confidence) * (parseFloat(r.confidence) <= 1 ? 100 : 1))) : "0",
      usageCount: r.usageCount || r.usage_count || 0,
      successCount: r.successCount || r.success_count || 0,
      supplierId: r.supplierId || r.supplier_id || null,
      source: "python",
    }));
    const dbMapped = (dbRules as any[]).map((r: any) => ({ ...r, source: "database" }));
    return [...dbMapped, ...pyOnly];
  }, [dbRules, pyRules]);

  const isLoading = loadingDb && loadingPy;

  // ── Filtering ──
  const filtered = useMemo(() => {
    let items = [...allRules];
    if (search) {
      const s = search.toLowerCase();
      items = items.filter(r =>
        (r.ruleType || "").toLowerCase().includes(s) ||
        (r.pattern || "").toLowerCase().includes(s) ||
        (r.examples || "").toLowerCase().includes(s)
      );
    }
    if (supplierFilter !== "all") {
      items = items.filter(r => String(r.supplierId) === supplierFilter);
    }
    return items.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  }, [allRules, search, supplierFilter]);

  // ── Stats ──
  const totalRules = allRules.length;
  const highConf = allRules.filter(r => Number(r.confidence) >= 80).length;
  const activeRules = allRules.filter(r => Number(r.usageCount || 0) > 0).length;
  const totalSuccess = allRules.reduce((sum, r) => sum + Number(r.successCount || 0), 0);
  const totalUsage = allRules.reduce((sum, r) => sum + Number(r.usageCount || 0), 0);
  const avgSuccessRate = totalUsage > 0 ? Math.round((totalSuccess / totalUsage) * 100) : 0;

  // Supplier name lookup
  const supplierName = (id: number | null) => {
    if (!id) return "All suppliers";
    const s = (suppliers as any[]).find((sup: any) => sup.id === id);
    return s?.name || `Supplier #${id}`;
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    if (deleteTarget.source === "python") {
      toast.info("Python-detected rules can't be deleted from here — they regenerate from the knowledge base files");
      setDeleteTarget(null);
      return;
    }
    deleteRuleMut.mutate({ id: deleteTarget.id });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-5xl">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Learned Rules</h1>
          <p className="text-slate-500 mt-1 text-sm">
            Transformation patterns auto-learned from your corrections
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { icon: GitBranch, label: "Total Rules", value: totalRules, color: "text-slate-800", bg: "bg-slate-50" },
            { icon: CheckCircle2, label: "High Confidence (≥80%)", value: highConf, color: "text-emerald-600", bg: "bg-emerald-50" },
            { icon: Zap, label: "Active (used ≥1x)", value: activeRules, color: "text-blue-600", bg: "bg-blue-50" },
            { icon: TrendingUp, label: "Avg Success Rate", value: `${avgSuccessRate}%`, color: "text-violet-600", bg: "bg-violet-50" },
          ].map(s => (
            <Card key={s.label} className="shadow-none border-slate-200">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">{s.label}</span>
                  <div className={`h-7 w-7 rounded-lg ${s.bg} flex items-center justify-center`}>
                    <s.icon className={`h-3.5 w-3.5 ${s.color}`} />
                  </div>
                </div>
                <p className={`text-xl font-bold ${s.color}`}>{isLoading ? "…" : s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Search + Filter */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input placeholder="Search patterns, types..." value={search}
              onChange={(e) => setSearch(e.target.value)} className="pl-8 h-9 text-xs" />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2.5 top-2.5">
                <X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-slate-400" />
            <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}
              className="text-xs h-9 px-2 pr-6 rounded-md border border-slate-200 bg-white text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20">
              <option value="all">All suppliers</option>
              {(suppliers as any[]).map((s: any) => (
                <option key={s.id} value={String(s.id)}>{s.name}</option>
              ))}
            </select>
          </div>
          <span className="text-[10px] text-slate-400 ml-auto">{filtered.length} rule{filtered.length !== 1 ? "s" : ""}</span>
        </div>

        {/* Rules List */}
        <div className="bg-white rounded-xl border border-slate-200">
          <div className="p-5">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-600 border-t-transparent" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-16">
                <div className="h-14 w-14 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <Brain className="h-7 w-7 text-slate-300" />
                </div>
                <p className="text-sm font-medium text-slate-600 mb-1">
                  {search || supplierFilter !== "all" ? "No rules match your filter" : "No rules learned yet"}
                </p>
                <p className="text-xs text-slate-400 max-w-xs mx-auto">
                  {search || supplierFilter !== "all"
                    ? "Try a different search term or clear the filter"
                    : "Process invoices and make corrections. After 3 similar corrections, rules are created automatically."}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((rule: any) => {
                  const conf = Number(rule.confidence || 0);
                  const confColor = conf >= 80 ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : conf >= 50 ? "bg-blue-50 text-blue-700 border-blue-200"
                    : "bg-slate-50 text-slate-600 border-slate-200";

                  const typeInfo = RULE_TYPE_LABELS[rule.ruleType] || { label: (rule.ruleType || "unknown").replace(/_/g, " "), color: "bg-slate-50 text-slate-600 border-slate-200" };
                  const successRate = Number(rule.usageCount || 0) > 0
                    ? Math.round((Number(rule.successCount || 0) / Number(rule.usageCount)) * 100) : 0;

                  let examples: any[] = [];
                  try { examples = JSON.parse(rule.examples || "[]"); } catch { /* */ }

                  const isDb = rule.source === "database";

                  return (
                    <div key={rule.id} className="p-4 rounded-xl border border-slate-150 hover:border-slate-300 transition-colors group">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 bg-violet-50 rounded-lg flex items-center justify-center shrink-0">
                            <Brain className="h-4 w-4 text-violet-500" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${typeInfo.color}`}>
                                {typeInfo.label}
                              </Badge>
                              {!isDb && (
                                <Badge variant="outline" className="text-[9px] px-1 py-0 text-slate-400 border-slate-200">
                                  auto-detected
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-slate-400 mt-0.5">
                              <Users className="h-3 w-3 inline mr-1" />
                              {supplierName(rule.supplierId)}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${confColor}`}>
                            {conf}%
                          </span>
                          {Number(rule.usageCount || 0) > 0 && (
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
                              <Zap className="h-3 w-3" />{rule.usageCount}
                            </span>
                          )}

                          {/* Edit/Delete - visible on hover */}
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-1">
                            {isDb && (
                              <button onClick={() => setEditRule({ ...rule })}
                                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600" title="Edit">
                                <Edit2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button onClick={() => setDeleteTarget(rule)}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500" title="Delete">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Pattern */}
                      <div className="mb-2">
                        <p className="text-[11px] text-slate-400 uppercase tracking-wide mb-1">Pattern</p>
                        <p className="font-mono text-xs bg-slate-50 border border-slate-100 px-3 py-2 rounded-lg text-slate-700">
                          {rule.pattern}
                        </p>
                      </div>

                      {/* Examples */}
                      {examples.length > 0 && (
                        <div className="mb-2">
                          <p className="text-[11px] text-slate-400 uppercase tracking-wide mb-1">Examples</p>
                          <div className="space-y-1">
                            {examples.slice(0, 3).map((ex: any, i: number) => {
                              const from = ex.from || ex.input || ex.supplier_code || "";
                              const to = ex.to || ex.output || ex.erp_code || "";
                              return (
                                <p key={i} className="font-mono text-xs bg-slate-50 border border-slate-100 px-3 py-1.5 rounded-lg">
                                  <span className="text-red-500">{from}</span>
                                  <span className="text-slate-300 mx-1.5">→</span>
                                  <span className="text-emerald-600">{to}</span>
                                </p>
                              );
                            })}
                            {examples.length > 3 && (
                              <p className="text-[10px] text-slate-400 pl-3">+{examples.length - 3} more examples</p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Footer stats */}
                      <div className="flex items-center gap-4 text-[11px] text-slate-400 pt-1 border-t border-slate-50 mt-2">
                        <span>Success: {rule.successCount || 0}/{rule.usageCount || 0}
                          {Number(rule.usageCount || 0) > 0 && ` (${successRate}%)`}
                        </span>
                        <span className="text-slate-200">|</span>
                        <span>Last used: {fmtDate(rule.lastUsed)}</span>
                        <span className="text-slate-200">|</span>
                        <span>Created: {fmtDate(rule.createdAt)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── EDIT DIALOG ── */}
      <Dialog open={!!editRule} onOpenChange={(open) => { if (!open) setEditRule(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Edit Rule</DialogTitle>
            <DialogDescription className="text-xs">
              {editRule?.ruleType?.replace(/_/g, " ")} — {supplierName(editRule?.supplierId)}
            </DialogDescription>
          </DialogHeader>
          {editRule && (
            <div className="space-y-3 pt-2">
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1 block">Pattern</label>
                <Input value={editRule.pattern || ""} className="text-xs font-mono h-9"
                  onChange={(e) => setEditRule({ ...editRule, pattern: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1 block">Confidence (%)</label>
                <Input type="number" min="0" max="100" value={editRule.confidence || ""} className="text-xs font-mono h-9"
                  onChange={(e) => setEditRule({ ...editRule, confidence: e.target.value })} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => setEditRule(null)}>
                  Cancel
                </Button>
                <Button size="sm" className="text-xs h-8 bg-primary hover:bg-primary/90"
                  disabled={updateRuleMut.isPending}
                  onClick={() => updateRuleMut.mutate({
                    id: editRule.id,
                    pattern: editRule.pattern,
                    confidence: String(editRule.confidence),
                  })}>
                  {updateRuleMut.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── DELETE CONFIRMATION ── */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-500" /> Delete rule?
            </DialogTitle>
            <DialogDescription className="text-xs">
              This will permanently remove the <span className="font-mono font-semibold">{deleteTarget?.ruleType?.replace(/_/g, " ")}</span> rule
              with pattern: <span className="font-mono">{deleteTarget?.pattern}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button size="sm" className="text-xs h-8 bg-red-600 hover:bg-red-700 text-white"
              disabled={deleteRuleMut.isPending}
              onClick={handleDelete}>
              {deleteRuleMut.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
