import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import {
  ArrowUpDown, Database, Download, Edit2, FileUp, GitBranch, Link2, Search,
  Trash2, Users, X, Check, AlertCircle,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Globe, Mail, Phone, CreditCard, Landmark, Hash, MapPin, Briefcase, User,
  FileText, Building,
} from "lucide-react";

// ── Helpers ──
function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function KnowledgeBase() {
  const [tab, setTab] = useState("mappings");
  const [search, setSearch] = useState("");
  const [editMapping, setEditMapping] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ type: "mapping" | "rule"; id: number; label: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [sortField, setSortField] = useState<string>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Queries ──
  const { data: mappings = [], isLoading: loadingMappings, refetch: refetchMappings } = trpc.knowledgeBase.mappings.useQuery();
  const { data: rules = [], isLoading: loadingRules, refetch: refetchRules } = trpc.knowledgeBase.rules.useQuery();
  const { data: suppliers = [], isLoading: loadingSuppliers } = trpc.knowledgeBase.suppliers.useQuery();
  const { data: stats } = trpc.knowledgeBase.stats.useQuery();

  // ── Mutations ──
  const updateMappingMut = trpc.knowledgeBase.updateMapping.useMutation({ onSuccess: () => { refetchMappings(); setEditMapping(null); toast.success("Mapping updated"); } });
  const deleteMappingMut = trpc.knowledgeBase.deleteMapping.useMutation({ onSuccess: () => { refetchMappings(); setDeleteTarget(null); toast.success("Mapping deleted"); } });
  const deleteRuleMut = trpc.knowledgeBase.deleteRule.useMutation({ onSuccess: () => { refetchRules(); setDeleteTarget(null); toast.success("Rule deleted"); } });
  const importMut = trpc.knowledgeBase.importMappings.useMutation({ onSuccess: (r) => { refetchMappings(); setImportOpen(false); toast.success(`Imported ${r.imported} mappings`); } });

  // ── Filtering ──
  const filteredMappings = useMemo(() => {
    let items = [...mappings] as any[];
    if (search) {
      const s = search.toLowerCase();
      items = items.filter((m: any) =>
          (m.supplierCode || "").toLowerCase().includes(s) ||
          (m.erpCode || "").toLowerCase().includes(s) ||
          (m.description || "").toLowerCase().includes(s) ||
          (m.supplierName || "").toLowerCase().includes(s)
      );
    }
    items.sort((a: any, b: any) => {
      const av = a[sortField] ?? "";
      const bv = b[sortField] ?? "";
      if (sortDir === "asc") return av > bv ? 1 : -1;
      return av < bv ? 1 : -1;
    });
    return items;
  }, [mappings, search, sortField, sortDir]);

  const filteredRules = useMemo(() => {
    if (!search) return rules as any[];
    const s = search.toLowerCase();
    return (rules as any[]).filter((r: any) =>
        (r.ruleType || "").toLowerCase().includes(s) ||
        (r.pattern || "").toLowerCase().includes(s) ||
        (r.examples || "").toLowerCase().includes(s)
    );
  }, [rules, search]);

  const filteredSuppliers = useMemo(() => {
    if (!search) return suppliers as any[];
    const s = search.toLowerCase();
    return (suppliers as any[]).filter((sup: any) =>
        (sup.name || "").toLowerCase().includes(s) ||
        (sup.code || "").toLowerCase().includes(s) ||
        (sup.taxId || "").toLowerCase().includes(s)
    );
  }, [suppliers, search]);

  const toggleSort = (field: string) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  };

  // ── Export CSV ──
  const exportCSV = () => {
    const rows = filteredMappings.map((m: any) => [
      m.supplierCode, m.erpCode, (m.description || "").replace(/"/g, '""'),
      m.supplierName || "", m.confidence, m.usageCount, fmtDate(m.lastUsed),
    ]);
    const header = "Supplier Code,ERP Code,Description,Supplier,Confidence,Uses,Last Used";
    const csv = [header, ...rows.map(r => r.map((c: any) => `"${c}"`).join(","))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "knowledge_base_mappings.csv"; a.click();
    URL.revokeObjectURL(url);
    toast.success("Exported CSV");
  };

  // ── Import CSV ──
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        const lines = text.split("\n").filter(l => l.trim());
        // Skip header
        const data = lines.slice(1).map(line => {
          const cols = line.split(",").map(c => c.replace(/^"|"$/g, "").trim());
          return { supplierCode: cols[0], erpCode: cols[1], description: cols[2], supplierName: cols[3] };
        }).filter(m => m.supplierCode && m.erpCode);
        if (data.length === 0) { toast.error("No valid mappings found in CSV"); return; }
        importMut.mutate({ mappings: data });
      } catch { toast.error("Failed to parse CSV file"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    if (deleteTarget.type === "mapping") deleteMappingMut.mutate({ id: deleteTarget.id });
    else deleteRuleMut.mutate({ id: deleteTarget.id });
  };

  const SortBtn = ({ field, children }: { field: string; children: React.ReactNode }) => (
      <button onClick={() => toggleSort(field)} className="flex items-center gap-1 hover:text-slate-900 transition-colors">
        {children}
        <ArrowUpDown className={`h-3 w-3 ${sortField === field ? "text-blue-600" : "text-slate-300"}`} />
      </button>
  );

  return (
      <DashboardLayout>
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Knowledge Base</h1>
              <p className="text-sm text-slate-500 mt-0.5">Supplier-product mappings, learned transformation rules, and supplier directory</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5" onClick={exportCSV}>
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
              <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5" onClick={() => setImportOpen(true)}>
                <FileUp className="h-3.5 w-3.5" /> Import
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { icon: Link2, label: "Product Mappings", value: stats?.mappings ?? "—", color: "blue" },
              { icon: GitBranch, label: "Transformation Rules", value: stats?.rules ?? "—", color: "emerald" },
              { icon: Users, label: "Known Suppliers", value: stats?.suppliers ?? "—", color: "violet" },
            ].map(s => (
                <Card key={s.label} className="shadow-none border-slate-200">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${
                        s.color === "blue" ? "bg-blue-50 text-blue-600" :
                            s.color === "emerald" ? "bg-emerald-50 text-emerald-600" :
                                "bg-violet-50 text-violet-600"
                    }`}>
                      <s.icon className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-slate-900 leading-none">{s.value}</p>
                      <p className="text-xs text-slate-500 mt-1">{s.label}</p>
                    </div>
                  </CardContent>
                </Card>
            ))}
          </div>

          {/* Search + Tabs */}
          <Card className="shadow-none border-slate-200">
            <CardHeader className="pb-0 px-4 pt-4">
              <div className="flex items-center justify-between gap-4">
                <div className="relative flex-1 max-w-sm">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                  <Input
                      placeholder="Search codes, descriptions, suppliers..."
                      value={search} onChange={(e) => setSearch(e.target.value)}
                      className="pl-8 h-9 text-xs"
                  />
                  {search && (
                      <button onClick={() => setSearch("")} className="absolute right-2.5 top-2.5">
                        <X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600" />
                      </button>
                  )}
                </div>
                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList className="h-8">
                    <TabsTrigger value="mappings" className="text-xs px-3 h-7">
                      <Link2 className="h-3 w-3 mr-1.5" />Mappings ({filteredMappings.length})
                    </TabsTrigger>
                    <TabsTrigger value="rules" className="text-xs px-3 h-7">
                      <GitBranch className="h-3 w-3 mr-1.5" />Rules ({filteredRules.length})
                    </TabsTrigger>
                    <TabsTrigger value="suppliers" className="text-xs px-3 h-7">
                      <Users className="h-3 w-3 mr-1.5" />Suppliers ({filteredSuppliers.length})
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </CardHeader>
            <CardContent className="p-0 pt-3">
              {/* ── MAPPINGS TAB ── */}
              {tab === "mappings" && (
                  <div className="overflow-x-auto">
                    {loadingMappings ? (
                        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent" /></div>
                    ) : filteredMappings.length === 0 ? (
                        <div className="flex flex-col items-center py-16 text-slate-400">
                          <Database className="h-8 w-8 mb-2" />
                          <p className="text-sm font-medium">No mappings found</p>
                          <p className="text-xs mt-1">{search ? "Try a different search term" : "Mappings are created when you confirm product matches on invoices"}</p>
                        </div>
                    ) : (
                        <Table>
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="text-xs w-[140px]"><SortBtn field="supplierCode">Supplier Code</SortBtn></TableHead>
                              <TableHead className="text-xs w-[140px]"><SortBtn field="erpCode">ERP Code</SortBtn></TableHead>
                              <TableHead className="text-xs">Description</TableHead>
                              <TableHead className="text-xs w-[160px]"><SortBtn field="supplierName">Supplier</SortBtn></TableHead>
                              <TableHead className="text-xs w-[70px] text-center">Confidence</TableHead>
                              <TableHead className="text-xs w-[50px] text-center"><SortBtn field="usageCount">Uses</SortBtn></TableHead>
                              <TableHead className="text-xs w-[90px]"><SortBtn field="lastUsed">Last Used</SortBtn></TableHead>
                              <TableHead className="text-xs w-[70px]" />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {filteredMappings.slice(0, 200).map((m: any) => (
                                <TableRow key={m.id} className="group">
                                  <TableCell className="font-mono text-xs font-semibold text-slate-800">{m.supplierCode}</TableCell>
                                  <TableCell className="font-mono text-xs font-bold text-blue-700">{m.erpCode}</TableCell>
                                  <TableCell className="text-xs text-slate-600 max-w-[250px] truncate">{m.description || "—"}</TableCell>
                                  <TableCell className="text-xs text-slate-500 truncate">{m.supplierName || "—"}</TableCell>
                                  <TableCell className="text-center">
                                    <Badge variant="outline" className={`text-[10px] px-1.5 ${
                                        Number(m.confidence) >= 90 ? "border-emerald-200 text-emerald-700 bg-emerald-50" :
                                            Number(m.confidence) >= 70 ? "border-blue-200 text-blue-700 bg-blue-50" :
                                                "border-amber-200 text-amber-700 bg-amber-50"
                                    }`}>{m.confidence}%</Badge>
                                  </TableCell>
                                  <TableCell className="text-xs text-center text-slate-500">{m.usageCount}</TableCell>
                                  <TableCell className="text-xs text-slate-400">{fmtDate(m.lastUsed)}</TableCell>
                                  <TableCell>
                                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <button onClick={() => setEditMapping({ ...m })} className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-blue-600"><Edit2 className="h-3.5 w-3.5" /></button>
                                      <button onClick={() => setDeleteTarget({ type: "mapping", id: m.id, label: `${m.supplierCode} → ${m.erpCode}` })} className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                    )}
                    {filteredMappings.length > 200 && (
                        <p className="text-xs text-slate-400 text-center py-2">Showing 200 of {filteredMappings.length} — refine your search</p>
                    )}
                  </div>
              )}

              {/* ── RULES TAB ── */}
              {tab === "rules" && (
                  <div className="overflow-x-auto">
                    {loadingRules ? (
                        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-500 border-t-transparent" /></div>
                    ) : filteredRules.length === 0 ? (
                        <div className="flex flex-col items-center py-16 text-slate-400">
                          <GitBranch className="h-8 w-8 mb-2" />
                          <p className="text-sm font-medium">No transformation rules</p>
                          <p className="text-xs mt-1">Rules are auto-created after 3+ consistent corrections for the same pattern</p>
                        </div>
                    ) : (
                        <Table>
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="text-xs w-[160px]">Rule Type</TableHead>
                              <TableHead className="text-xs">Pattern</TableHead>
                              <TableHead className="text-xs w-[80px] text-center">Confidence</TableHead>
                              <TableHead className="text-xs w-[80px] text-center">Success</TableHead>
                              <TableHead className="text-xs w-[50px] text-center">Uses</TableHead>
                              <TableHead className="text-xs w-[90px]">Last Used</TableHead>
                              <TableHead className="text-xs w-[50px]" />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {filteredRules.map((r: any) => {
                              const successRate = r.usageCount > 0 ? Math.round((r.successCount / r.usageCount) * 100) : 0;
                              let examples: string[] = [];
                              try { examples = JSON.parse(r.examples || "[]"); } catch { /* */ }
                              return (
                                  <TableRow key={r.id} className="group">
                                    <TableCell>
                                      <Badge variant="outline" className="text-[10px] font-medium">
                                        {(r.ruleType || "").replace(/_/g, " ")}
                                      </Badge>
                                    </TableCell>
                                    <TableCell>
                                      <p className="font-mono text-xs text-slate-800">{r.pattern}</p>
                                      {examples.length > 0 && (
                                          <p className="text-[10px] text-slate-400 mt-0.5 truncate max-w-[300px]">
                                            e.g. {examples.slice(0, 2).map((ex: any) =>
                                              typeof ex === "object" ? `${ex.from || ex.input} → ${ex.to || ex.output}` : String(ex)
                                          ).join(", ")}
                                          </p>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-center">
                                      <Badge variant="outline" className={`text-[10px] px-1.5 ${
                                          Number(r.confidence) >= 80 ? "border-emerald-200 text-emerald-700 bg-emerald-50" :
                                              Number(r.confidence) >= 50 ? "border-blue-200 text-blue-700 bg-blue-50" :
                                                  "border-amber-200 text-amber-700 bg-amber-50"
                                      }`}>{r.confidence}%</Badge>
                                    </TableCell>
                                    <TableCell className="text-xs text-center text-slate-500">
                                      {r.successCount}/{r.usageCount} ({successRate}%)
                                    </TableCell>
                                    <TableCell className="text-xs text-center text-slate-500">{r.usageCount}</TableCell>
                                    <TableCell className="text-xs text-slate-400">{fmtDate(r.lastUsed)}</TableCell>
                                    <TableCell>
                                      <button onClick={() => setDeleteTarget({ type: "rule", id: r.id, label: `${r.ruleType}: ${r.pattern}` })}
                                              className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </TableCell>
                                  </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                    )}
                  </div>
              )}

              {/* ── SUPPLIERS TAB ── */}
              {tab === "suppliers" && (
                  <div className="p-4">
                    {loadingSuppliers ? (
                        <div className="flex justify-center py-16">
                          <div className="animate-spin rounded-full h-6 w-6 border-2 border-violet-500 border-t-transparent" />
                        </div>
                    ) : filteredSuppliers.length === 0 ? (
                        <div className="flex flex-col items-center py-16 text-slate-400">
                          <Users className="h-8 w-8 mb-2" />
                          <p className="text-sm font-medium">No suppliers yet</p>
                          <p className="text-xs mt-1">Suppliers are created automatically when invoices are processed</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                          {filteredSuppliers.map((s: any) => {
                            const iss = s.issuer || {};
                            const name    = iss.name    || s.name    || "Unknown";
                            const vat     = iss.vatNumber|| s.taxId   || null;
                            const address = iss.address  || s.address || null;
                            const city    = iss.city     || null;
                            const country = iss.country  || null;
                            const postCode= iss.postCode || null;
                            const phone   = iss.phone    || null;
                            const email   = iss.email    || null;
                            const iban    = iss.iban     || null;
                            const swift   = iss.swift    || null;
                            const bank    = iss.bank     || null;
                            const regNo   = iss.registrationNumber || null;
                            const doy     = iss.doy      || null;
                            const manager = iss.manager  || null;
                            const prof    = iss.profession|| null;
                            const website = iss.website  || null;

                            return (
                                <div key={s.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden hover:border-violet-300 transition-colors">
                                  {/* Card header */}
                                  <div className="px-4 py-3 bg-gradient-to-r from-slate-50 to-white border-b border-slate-100 flex items-start justify-between gap-3">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-bold text-slate-900 truncate">{name}</p>
                                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                        {vat && (
                                            <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                                    ΑΦΜ {vat}
                                  </span>
                                        )}
                                        {regNo && (
                                            <span className="text-[10px] font-mono text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200">
                                    Reg {regNo}
                                  </span>
                                        )}
                                      </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-1 shrink-0">
                                      {country && (
                                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 font-semibold border border-violet-200">
                                  {country}
                                </span>
                                      )}
                                      <span className="text-[9px] text-slate-400 font-mono">
                                {s.invoiceCount ?? 0} invoice{s.invoiceCount !== 1 ? "s" : ""}
                              </span>
                                    </div>
                                  </div>

                                  {/* Card body — field grid */}
                                  <div className="px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-2">

                                    {/* Address */}
                                    {(address || city) && (
                                        <div className="col-span-2 flex items-start gap-2">
                                          <MapPin className="h-3 w-3 text-slate-400 mt-0.5 shrink-0" />
                                          <div>
                                            {address && <p className="text-xs text-slate-700">{address}</p>}
                                            {(city || postCode) && (
                                                <p className="text-xs text-slate-500">
                                                  {[postCode, city].filter(Boolean).join(" ")}
                                                </p>
                                            )}
                                          </div>
                                        </div>
                                    )}

                                    {/* DOY */}
                                    {doy && (
                                        <div className="flex items-center gap-2">
                                          <Building className="h-3 w-3 text-slate-400 shrink-0" />
                                          <div>
                                            <p className="text-[9px] text-slate-400 uppercase font-semibold">ΔΟΥ</p>
                                            <p className="text-xs text-slate-700">{doy}</p>
                                          </div>
                                        </div>
                                    )}

                                    {/* Profession */}
                                    {prof && (
                                        <div className="flex items-center gap-2">
                                          <Briefcase className="h-3 w-3 text-slate-400 shrink-0" />
                                          <div>
                                            <p className="text-[9px] text-slate-400 uppercase font-semibold">Activity</p>
                                            <p className="text-xs text-slate-700 truncate max-w-[130px]">{prof}</p>
                                          </div>
                                        </div>
                                    )}

                                    {/* Manager */}
                                    {manager && (
                                        <div className="flex items-center gap-2">
                                          <User className="h-3 w-3 text-slate-400 shrink-0" />
                                          <div>
                                            <p className="text-[9px] text-slate-400 uppercase font-semibold">Manager</p>
                                            <p className="text-xs text-slate-700">{manager}</p>
                                          </div>
                                        </div>
                                    )}

                                    {/* Phone */}
                                    {phone && (
                                        <div className="flex items-center gap-2">
                                          <Phone className="h-3 w-3 text-slate-400 shrink-0" />
                                          <div>
                                            <p className="text-[9px] text-slate-400 uppercase font-semibold">Phone</p>
                                            <p className="text-xs text-slate-700">{phone}</p>
                                          </div>
                                        </div>
                                    )}

                                    {/* Email */}
                                    {email && (
                                        <div className="flex items-center gap-2">
                                          <Mail className="h-3 w-3 text-slate-400 shrink-0" />
                                          <div>
                                            <p className="text-[9px] text-slate-400 uppercase font-semibold">Email</p>
                                            <p className="text-xs text-slate-600 truncate max-w-[130px]">{email}</p>
                                          </div>
                                        </div>
                                    )}

                                    {/* Website */}
                                    {website && (
                                        <div className="flex items-center gap-2">
                                          <Globe className="h-3 w-3 text-slate-400 shrink-0" />
                                          <div>
                                            <p className="text-[9px] text-slate-400 uppercase font-semibold">Website</p>
                                            <p className="text-xs text-slate-600">{website}</p>
                                          </div>
                                        </div>
                                    )}

                                    {/* IBAN */}
                                    {iban && (
                                        <div className="col-span-2 flex items-center gap-2">
                                          <CreditCard className="h-3 w-3 text-slate-400 shrink-0" />
                                          <div>
                                            <p className="text-[9px] text-slate-400 uppercase font-semibold">IBAN</p>
                                            <p className="text-[11px] font-mono text-slate-700 tracking-wider">{iban}</p>
                                          </div>
                                        </div>
                                    )}

                                    {/* SWIFT + Bank */}
                                    {(swift || bank) && (
                                        <div className="col-span-2 flex items-center gap-2">
                                          <Landmark className="h-3 w-3 text-slate-400 shrink-0" />
                                          <div>
                                            <p className="text-[9px] text-slate-400 uppercase font-semibold">Bank</p>
                                            <p className="text-xs text-slate-700">
                                              {bank || ""}
                                              {swift && <span className="ml-2 font-mono text-[10px] text-slate-500 bg-slate-100 px-1 rounded">{swift}</span>}
                                            </p>
                                          </div>
                                        </div>
                                    )}

                                  </div>

                                  {/* Card footer */}
                                  <div className="px-4 py-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                            <span className="text-[10px] text-slate-400">
                              Added {fmtDate(s.createdAt)}
                            </span>
                                    <span className="text-[10px] font-mono text-slate-400">
                              {s.code}
                            </span>
                                  </div>
                                </div>
                            );
                          })}
                        </div>
                    )}
                  </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── EDIT MAPPING DIALOG ── */}
        <Dialog open={!!editMapping} onOpenChange={(open) => { if (!open) setEditMapping(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base">Edit Mapping</DialogTitle>
              <DialogDescription className="text-xs">
                {editMapping?.supplierCode} → {editMapping?.erpCode}
              </DialogDescription>
            </DialogHeader>
            {editMapping && (
                <div className="space-y-3 pt-2">
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">ERP Code</label>
                    <Input value={editMapping.erpCode} className="text-xs font-mono h-9"
                           onChange={(e) => setEditMapping({ ...editMapping, erpCode: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">Description</label>
                    <Input value={editMapping.description || ""} className="text-xs h-9"
                           onChange={(e) => setEditMapping({ ...editMapping, description: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">Price</label>
                    <Input value={editMapping.price || ""} className="text-xs font-mono h-9"
                           onChange={(e) => setEditMapping({ ...editMapping, price: e.target.value })} />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => setEditMapping(null)}>Cancel</Button>
                    <Button size="sm" className="text-xs h-8 bg-primary hover:bg-primary/90"
                            disabled={updateMappingMut.isPending}
                            onClick={() => updateMappingMut.mutate({ id: editMapping.id, erpCode: editMapping.erpCode, description: editMapping.description, price: editMapping.price })}>
                      {updateMappingMut.isPending ? "Saving..." : "Save Changes"}
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
                <AlertCircle className="h-4 w-4 text-red-500" /> Delete {deleteTarget?.type}?
              </DialogTitle>
              <DialogDescription className="text-xs">
                This will permanently remove: <span className="font-mono font-semibold">{deleteTarget?.label}</span>
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button size="sm" className="text-xs h-8 bg-red-600 hover:bg-red-700 text-white"
                      disabled={deleteMappingMut.isPending || deleteRuleMut.isPending}
                      onClick={handleDelete}>
                Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* ── IMPORT DIALOG ── */}
        <Dialog open={importOpen} onOpenChange={setImportOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base">Import Mappings</DialogTitle>
              <DialogDescription className="text-xs">
                Upload a CSV file with columns: Supplier Code, ERP Code, Description, Supplier Name
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 pt-2">
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-8 text-center hover:border-blue-300 transition-colors cursor-pointer"
                   onClick={() => fileRef.current?.click()}>
                <FileUp className="h-8 w-8 mx-auto text-slate-300 mb-2" />
                <p className="text-sm font-medium text-slate-600">Click to select CSV file</p>
                <p className="text-xs text-slate-400 mt-1">Format: supplier_code, erp_code, description, supplier_name</p>
              </div>
              <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleImportFile} />
              {importMut.isPending && (
                  <div className="flex items-center gap-2 text-xs text-blue-600">
                    <div className="animate-spin rounded-full h-3 w-3 border-2 border-blue-500 border-t-transparent" />
                    Importing...
                  </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </DashboardLayout>
  );
}
