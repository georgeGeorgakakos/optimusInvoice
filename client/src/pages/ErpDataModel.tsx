import { useState, useMemo, useCallback, useRef } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  Database, Search, Plus, Upload, Download, RefreshCw, Sparkles,
  Trash2, Edit3, Link2, ArrowRight, X, CheckCircle2, AlertCircle,
  Loader2, Building2, Tag, Eye, Settings, Filter,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════
type Tab = "products" | "mappings" | "settings";

// ═══════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════
export default function ErpDataModel() {
  const [activeTab, setActiveTab] = useState<Tab>("products");

  return (
    <DashboardLayout>
      <div className="space-y-5 max-w-[1100px]">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 via-indigo-500 to-violet-500 flex items-center justify-center shrink-0">
            <Database className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">ERP Data Model Editor</h1>
            <p className="text-xs text-slate-500">Manage your product catalog, supplier mappings, and auto-match settings</p>
          </div>
        </div>

        {/* Stats */}
        <StatsBar />

        {/* Tabs */}
        <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit">
          {([
            { key: "products" as Tab, label: "ERP Products", icon: Database },
            { key: "mappings" as Tab, label: "Supplier Mappings", icon: Link2 },
            { key: "settings" as Tab, label: "Match Settings", icon: Settings },
          ]).map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === t.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}>
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === "products" && <ProductsTab />}
        {activeTab === "mappings" && <MappingsTab />}
        {activeTab === "settings" && <SettingsTab />}
      </div>
    </DashboardLayout>
  );
}

// ═══════════════════════════════════════════════════════════
// STATS BAR
// ═══════════════════════════════════════════════════════════
function StatsBar() {
  const { data: stats } = trpc.erpModel.stats.useQuery();
  const cards = [
    { label: "ERP Products", value: stats?.totalProducts ?? "—", color: "bg-blue-50 text-blue-600" },
    { label: "Supplier Mappings", value: stats?.totalMappings ?? "—", color: "bg-violet-50 text-violet-600" },
    { label: "Auto-Match Rate", value: stats?.autoMatchRate != null ? `${stats.autoMatchRate}%` : "—", color: "bg-emerald-50 text-emerald-600" },
    { label: "Unmapped Items", value: stats?.unmapped ?? "—", color: "bg-amber-50 text-amber-600" },
  ];
  return (
    <div className="grid grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <div key={i} className="bg-white rounded-xl border border-slate-200 px-4 py-3">
          <div className="text-xl font-bold text-slate-900">{c.value}</div>
          <div className="text-[11px] font-medium text-slate-500 mt-0.5">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB: ERP PRODUCTS
// ═══════════════════════════════════════════════════════════
function ProductsTab() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [editProduct, setEditProduct] = useState<any>(null);
  const [showImport, setShowImport] = useState(false);

  const { data, isLoading, refetch } = trpc.erpModel.products.useQuery({ search: search || undefined, category: category !== "all" ? category : undefined, page, pageSize: 30 });
  const { data: categories } = trpc.erpModel.categories.useQuery();
  const { data: mappingCounts } = trpc.erpModel.mappingCounts.useQuery();
  const deleteMut = trpc.erpModel.deleteProduct.useMutation();

  const mcMap = useMemo(() => {
    const m = new Map<string, number>();
    (mappingCounts || []).forEach((mc: any) => m.set(mc.erpCode, Number(mc.count)));
    return m;
  }, [mappingCounts]);

  const products = data?.rows || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / 30));

  const handleDelete = async (id: number, code: string) => {
    if (!confirm(`Delete product ${code}?`)) return;
    await deleteMut.mutateAsync({ id });
    toast.success("Product deleted");
    refetch();
  };

  return (
    <>
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 p-3 border-b border-slate-100">
          <div className="relative flex-1 max-w-[320px]">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input placeholder="Search ERP code or description..."
              value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-xs outline-none focus:ring-2 focus:ring-blue-500/30" />
          </div>
          <select value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}
            className="px-3 py-2 rounded-lg border border-slate-200 text-xs text-slate-600 bg-white">
            <option value="all">All Categories</option>
            {(categories || []).map((c: any) => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5" onClick={() => setShowImport(true)}>
            <Upload className="h-3.5 w-3.5" />Import CSV
          </Button>
          <Button size="sm" className="text-xs h-8 gap-1.5 bg-primary hover:bg-primary/90 text-white" onClick={() => { setEditProduct(null); setShowAdd(true); }}>
            <Plus className="h-3.5 w-3.5" />Add Product
          </Button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50/80">
                {["ERP Code", "Description", "Category", "Unit", "VAT", "Price (€)", "Mappings", "Status", ""].map((h, i) => (
                  <th key={i} className="px-3.5 py-2.5 text-left font-semibold text-slate-500 text-[10px] uppercase tracking-wide border-b border-slate-100">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9} className="py-12 text-center"><Loader2 className="h-5 w-5 animate-spin text-slate-300 mx-auto" /></td></tr>
              ) : products.length === 0 ? (
                <tr><td colSpan={9} className="py-12 text-center text-slate-400 text-sm">No products found</td></tr>
              ) : (
                products.map((p: any) => {
                  const mc = mcMap.get(p.erpCode) || 0;
                  const isActive = p.active !== 0;
                  return (
                    <tr key={p.id} className="border-b border-slate-50 hover:bg-blue-50/30 transition-colors">
                      <td className="px-3.5 py-3">
                        <code className="text-xs font-semibold text-slate-800 bg-slate-100 px-2 py-0.5 rounded">{p.erpCode}</code>
                      </td>
                      <td className="px-3.5 py-3 text-slate-600 max-w-[240px] truncate">{p.description || "—"}</td>
                      <td className="px-3.5 py-3">
                        {p.category ? (
                          <span className="text-[10px] font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">{p.category}</span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3.5 py-3 text-slate-400">{p.unit || "ΤΕΜ"}</td>
                      <td className="px-3.5 py-3 text-slate-400">{p.vatRate || "24"}%</td>
                      <td className="px-3.5 py-3 font-mono text-slate-600">{p.price || "—"}</td>
                      <td className="px-3.5 py-3">
                        {mc > 0 ? (
                          <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                            {mc} supplier{mc > 1 ? "s" : ""}
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3.5 py-3">
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                          isActive ? "text-emerald-600 bg-emerald-50" : "text-slate-400 bg-slate-50"
                        }`}>{isActive ? "Active" : "Inactive"}</span>
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex gap-1">
                          <button onClick={() => { setEditProduct(p); setShowAdd(true); }}
                            className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"><Edit3 className="h-3.5 w-3.5" /></button>
                          <button onClick={() => handleDelete(p.id, p.erpCode)}
                            className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100">
          <span className="text-[11px] text-slate-400">Showing {products.length} of {total} products</span>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" className="text-[10px] h-7 px-2" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
            <span className="text-[10px] text-slate-500 flex items-center px-2">{page} / {totalPages}</span>
            <Button variant="outline" size="sm" className="text-[10px] h-7 px-2" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      </div>

      {/* Add/Edit Dialog */}
      <ProductDialog open={showAdd} onClose={() => { setShowAdd(false); setEditProduct(null); }} product={editProduct} onSaved={refetch} />

      {/* Import CSV Dialog */}
      <ImportDialog open={showImport} onClose={() => setShowImport(false)} onImported={refetch} />
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// PRODUCT ADD/EDIT DIALOG
// ═══════════════════════════════════════════════════════════
function ProductDialog({ open, onClose, product, onSaved }: { open: boolean; onClose: () => void; product: any; onSaved: () => void }) {
  const [form, setForm] = useState({ erpCode: "", description: "", price: "", category: "", unit: "ΤΕΜ", vatRate: "24", active: true });
  const upsertMut = trpc.erpModel.upsertProduct.useMutation();

  // Sync form when product changes
  const prevId = useRef<number | null>(null);
  if (open && product && product.id !== prevId.current) {
    prevId.current = product.id;
    setForm({ erpCode: product.erpCode || "", description: product.description || "", price: product.price || "", category: product.category || "", unit: product.unit || "ΤΕΜ", vatRate: product.vatRate || "24", active: product.active !== 0 });
  } else if (open && !product && prevId.current !== null) {
    prevId.current = null;
    setForm({ erpCode: "", description: "", price: "", category: "", unit: "ΤΕΜ", vatRate: "24", active: true });
  }

  const handleSave = async () => {
    if (!form.erpCode.trim()) { toast.error("ERP Code is required"); return; }
    try {
      const result = await upsertMut.mutateAsync(form);
      toast.success(result.created ? "Product created" : "Product updated");
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error("Failed", { description: err.message });
    }
  };

  const f = (key: keyof typeof form, label: string, opts?: { type?: string; placeholder?: string }) => (
    <div>
      <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">{label}</label>
      <input value={String(form[key])} onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
        type={opts?.type || "text"} placeholder={opts?.placeholder}
        className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 text-xs outline-none focus:ring-2 focus:ring-blue-500/30" />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">{product ? "Edit Product" : "Add ERP Product"}</DialogTitle>
          <DialogDescription className="text-xs">
            {product ? "Update product details in the ERP catalog." : "Add a new product to the ERP catalog."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {f("erpCode", "ERP Code *", { placeholder: "ΗΛ-001-50W" })}
          {f("category", "Category", { placeholder: "Φωτισμός" })}
          <div className="col-span-2">{f("description", "Description", { placeholder: "ΠΡΟΒΟΛΕΑΣ LED 50W 4500lm" })}</div>
          {f("price", "Price (€)", { placeholder: "8.900,00" })}
          {f("unit", "Unit", { placeholder: "ΤΕΜ" })}
          {f("vatRate", "VAT Rate %", { placeholder: "24" })}
          <div className="flex items-center gap-2 col-span-2">
            <input type="checkbox" checked={form.active as any} onChange={e => setForm(prev => ({ ...prev, active: e.target.checked }))} className="accent-blue-600" />
            <span className="text-xs text-slate-600">Active product</span>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" size="sm" className="text-xs" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="text-xs bg-primary hover:bg-primary/90 text-white" onClick={handleSave} disabled={upsertMut.isPending}>
            {upsertMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : product ? "Save Changes" : "Add Product"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════
// IMPORT CSV DIALOG
// ═══════════════════════════════════════════════════════════
function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [csvData, setCsvData] = useState<any[]>([]);
  const [preview, setPreview] = useState<any[]>([]);
  const [fileName, setFileName] = useState("");
  const importMut = trpc.erpModel.importProducts.useMutation();
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) { toast.error("CSV must have a header row + data"); return; }

      const headers = lines[0].split(/[,;\t]/).map(h => h.replace(/"/g, "").trim().toLowerCase());
      const rows: any[] = [];
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(/[,;\t]/).map(v => v.replace(/"/g, "").trim());
        const row: any = {};
        headers.forEach((h, idx) => { row[h] = vals[idx] || ""; });
        // Map common column names
        const item: any = {
          erpCode: row["erp_code"] || row["erpcode"] || row["code"] || row["κωδικός"] || row["κωδικοσ"] || "",
          description: row["description"] || row["desc"] || row["name"] || row["περιγραφή"] || row["περιγραφη"] || "",
          price: row["price"] || row["τιμή"] || row["τιμη"] || "",
          category: row["category"] || row["cat"] || row["κατηγορία"] || row["κατηγορια"] || "",
          unit: row["unit"] || row["uom"] || row["μονάδα"] || row["μοναδα"] || "ΤΕΜ",
          vatRate: row["vat"] || row["vat_rate"] || row["vatrate"] || row["φπα"] || "24",
        };
        if (item.erpCode) rows.push(item);
      }
      setCsvData(rows);
      setPreview(rows.slice(0, 5));
    };
    reader.readAsText(file, "utf-8");
  };

  const handleImport = async () => {
    if (csvData.length === 0) { toast.error("No data to import"); return; }
    try {
      const result = await importMut.mutateAsync({ items: csvData });
      toast.success(`Imported: ${result.created} created, ${result.updated} updated${result.errors ? `, ${result.errors} errors` : ""}`);
      onImported();
      onClose();
      setCsvData([]);
      setPreview([]);
      setFileName("");
    } catch (err: any) {
      toast.error("Import failed", { description: err.message });
    }
  };

  const handleDownloadTemplate = () => {
    const tpl = "erp_code,description,category,unit,vat_rate,price\nΗΛ-001-50W,ΠΡΟΒΟΛΕΑΣ LED 50W,Φωτισμός,ΤΕΜ,24,\"8.900,00\"\nΕΡΓ-125MM,ΓΩΝΙΑΚΟΣ ΤΡΟΧΟΣ 1500W,Εργαλεία,ΤΕΜ,24,\"129,00\"";
    const blob = new Blob(["\uFEFF" + tpl], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "product_import_template.csv"; a.click();
  };

  return (
    <Dialog open={open} onOpenChange={() => { onClose(); setCsvData([]); setPreview([]); setFileName(""); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">Import Products from CSV</DialogTitle>
          <DialogDescription className="text-xs">Upload a CSV file with ERP product data. Existing products (by ERP code) will be updated.</DialogDescription>
        </DialogHeader>

        {/* Drop zone */}
        <div className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer ${
          csvData.length > 0 ? "border-emerald-300 bg-emerald-50/50" : "border-slate-200 bg-slate-50/50 hover:border-blue-300"
        }`}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
          {csvData.length > 0 ? (
            <>
              <CheckCircle2 className="h-6 w-6 text-emerald-500 mx-auto mb-1" />
              <p className="text-xs font-semibold text-emerald-700">{fileName}</p>
              <p className="text-[10px] text-emerald-600 mt-0.5">{csvData.length} products parsed</p>
            </>
          ) : (
            <>
              <Upload className="h-6 w-6 text-slate-300 mx-auto mb-1" />
              <p className="text-xs font-medium text-slate-500">Drop CSV file here or click to browse</p>
              <p className="text-[10px] text-slate-400 mt-0.5">Expected: erp_code, description, category, unit, vat_rate, price</p>
            </>
          )}
        </div>

        {/* Preview */}
        {preview.length > 0 && (
          <div className="border border-slate-100 rounded-lg overflow-hidden">
            <div className="px-3 py-1.5 bg-slate-50 text-[9px] font-semibold text-slate-400 uppercase">Preview (first 5 rows)</div>
            <table className="w-full text-[10px]">
              <thead><tr className="border-b border-slate-100">
                {["ERP Code", "Description", "Category", "Unit", "VAT", "Price"].map(h => (
                  <th key={h} className="px-2 py-1.5 text-left font-semibold text-slate-500">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={i} className="border-b border-slate-50">
                    <td className="px-2 py-1.5 font-mono font-semibold text-slate-700">{r.erpCode}</td>
                    <td className="px-2 py-1.5 text-slate-600 max-w-[160px] truncate">{r.description}</td>
                    <td className="px-2 py-1.5 text-slate-400">{r.category}</td>
                    <td className="px-2 py-1.5 text-slate-400">{r.unit}</td>
                    <td className="px-2 py-1.5 text-slate-400">{r.vatRate}%</td>
                    <td className="px-2 py-1.5 font-mono text-slate-600">{r.price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {csvData.length > 5 && <div className="px-3 py-1.5 text-[10px] text-slate-400">... and {csvData.length - 5} more</div>}
          </div>
        )}

        <div className="flex justify-between mt-2">
          <Button variant="outline" size="sm" className="text-[10px] h-7 gap-1" onClick={handleDownloadTemplate}>
            <Download className="h-3 w-3" />Download Template
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="text-xs" onClick={onClose}>Cancel</Button>
            <Button size="sm" className="text-xs bg-primary hover:bg-primary/90 text-white" onClick={handleImport}
              disabled={csvData.length === 0 || importMut.isPending}>
              {importMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Import ${csvData.length} Products`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB: SUPPLIER MAPPINGS
// ═══════════════════════════════════════════════════════════
function MappingsTab() {
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");

  const { data: mappings, isLoading, refetch } = trpc.erpModel.allMappings.useQuery({ search: search || undefined, supplierFilter: supplierFilter || undefined });
  const { data: suppliers } = trpc.knowledgeBase.suppliers.useQuery();
  const { data: unmapped, refetch: refetchUnmapped } = trpc.erpModel.unmapped.useQuery();
  const deleteMut = trpc.knowledgeBase.deleteMapping.useMutation();
  const autoMapMut = trpc.erpModel.autoMap.useMutation();

  const unmappedItems = Array.isArray(unmapped) ? ((unmapped as any)[0] || []) : [];

  const handleAutoMap = async () => {
    try {
      const result = await autoMapMut.mutateAsync();
      toast.success(`Auto-mapped ${result.mapped} items (${result.skipped} skipped)`);
      refetch();
      refetchUnmapped();
    } catch (err: any) {
      toast.error("Auto-map failed", { description: err.message });
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this mapping?")) return;
    await deleteMut.mutateAsync({ id });
    toast.success("Mapping deleted");
    refetch();
  };

  const confColor = (c: number) => c >= 90 ? "text-emerald-600 bg-emerald-50" : c >= 80 ? "text-amber-600 bg-amber-50" : "text-red-600 bg-red-50";
  const sourceLabel = (s: string) => {
    if (!s) return "Manual";
    if (s === "ml_learned" || s === "auto") return "ML Learned";
    if (s === "ml_suggested") return "ML Suggested";
    return "Manual";
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 p-3 border-b border-slate-100">
          <div className="relative flex-1 max-w-[320px]">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input placeholder="Search supplier code, description, or ERP code..."
              value={search} onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-xs outline-none focus:ring-2 focus:ring-blue-500/30" />
          </div>
          <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 text-xs text-slate-600 bg-white">
            <option value="">All Suppliers</option>
            {(suppliers || []).map((s: any) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5 text-violet-600 border-violet-200 hover:bg-violet-50"
            onClick={handleAutoMap} disabled={autoMapMut.isPending}>
            {autoMapMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Auto-Map Unmapped
          </Button>
        </div>

        {/* Mapping cards */}
        <div className="p-3 space-y-2">
          {isLoading ? (
            <div className="py-12 text-center"><Loader2 className="h-5 w-5 animate-spin text-slate-300 mx-auto" /></div>
          ) : !mappings || mappings.length === 0 ? (
            <div className="py-12 text-center">
              <Link2 className="h-8 w-8 text-slate-200 mx-auto mb-2" />
              <p className="text-sm text-slate-400">No supplier mappings yet</p>
              <p className="text-xs text-slate-300 mt-1">Mappings are created automatically when you confirm matches on invoices</p>
            </div>
          ) : (
            mappings.map((m: any) => {
              const conf = Number(m.confidence) || 0;
              return (
                <div key={m.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 bg-slate-50/50 hover:border-slate-200 transition-colors">
                  {/* Supplier side */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <code className="text-xs font-bold text-slate-800 bg-slate-200/60 px-2 py-0.5 rounded">{m.supplierCode}</code>
                      <span className="text-[9px] text-slate-400">from</span>
                      <span className="text-[10px] font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">{m.supplierName || "?"}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">{m.description || "—"}</div>
                  </div>

                  {/* Arrow */}
                  <div className="flex items-center gap-1 px-2 shrink-0">
                    <div className={`w-10 h-0.5 rounded ${conf >= 90 ? "bg-emerald-400" : conf >= 80 ? "bg-amber-400" : "bg-red-300"}`} />
                    <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                  </div>

                  {/* ERP side */}
                  <div className="flex-1 min-w-0">
                    <code className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">{m.erpCode}</code>
                  </div>

                  {/* Confidence */}
                  <div className="text-right shrink-0 min-w-[80px]">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${confColor(conf)}`}>{conf}%</span>
                    <div className="text-[9px] text-slate-300 mt-1">
                      {sourceLabel(m.source)} · {m.usageCount || 0}x used
                    </div>
                  </div>

                  {/* Actions */}
                  <button onClick={() => handleDelete(m.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-slate-300 hover:text-red-500 shrink-0">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Unmapped Items Callout */}
      {unmappedItems.length > 0 && (
        <div className="rounded-xl border-2 border-dashed border-amber-300 bg-amber-50/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-semibold text-amber-800">{unmappedItems.length} Unmapped Supplier Items</span>
            <Badge variant="outline" className="text-[9px] border-amber-200 text-amber-600 bg-amber-100">Last 30 days</Badge>
          </div>
          <p className="text-xs text-amber-700 mb-3 leading-relaxed">
            These supplier codes appeared on invoices but have no ERP mapping yet.
            Click "Auto-Map" above to let the ML matcher suggest matches, or map them manually from the invoice detail page.
          </p>
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {unmappedItems.slice(0, 10).map((u: any, i: number) => (
              <div key={i} className="flex items-center gap-3 text-xs bg-white/60 rounded-lg px-3 py-2">
                <code className="font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">{u.supplierCode}</code>
                <span className="text-slate-500 truncate flex-1">{u.description || "—"}</span>
                <span className="text-[10px] text-amber-600 shrink-0">{u.occurrences}x seen</span>
                {u.supplierName && <span className="text-[10px] text-indigo-500 shrink-0">{u.supplierName}</span>}
              </div>
            ))}
            {unmappedItems.length > 10 && (
              <p className="text-[10px] text-amber-500 pl-3">... and {unmappedItems.length - 10} more</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB: MATCH SETTINGS
// ═══════════════════════════════════════════════════════════
function SettingsTab() {
  const { data: config, refetch } = trpc.configuration.get.useQuery();
  const updateMut = trpc.configuration.save.useMutation();

  // Parse settings from settingsJson
  const settings = (() => {
    try {
      const json = config?.settingsJson ? JSON.parse(config.settingsJson) : {};
      return {
        matchThreshold: json.matchThreshold ?? 85,
        autoLearn: json.autoLearn !== false,
        learnAfterN: json.learnAfterN ?? 3,
        enableExactMatch: json.enableExactMatch !== false,
        enableFuzzyMatch: json.enableFuzzyMatch !== false,
        enableMLRules: json.enableMLRules !== false,
        enableVLM: json.enableVLM ?? false,
        syncSchedule: json.syncSchedule ?? "manual",
      };
    } catch { return { matchThreshold: 85, autoLearn: true, learnAfterN: 3, enableExactMatch: true, enableFuzzyMatch: true, enableMLRules: true, enableVLM: false, syncSchedule: "manual" }; }
  })();

  const saveSettings = async (updates: any) => {
    const current = { ...settings, ...updates };
    const existingJson = config?.settingsJson ? JSON.parse(config.settingsJson) : {};
    const merged = { ...existingJson, ...current };
    try {
      await updateMut.mutateAsync({ settingsJson: JSON.stringify(merged) } as any);
      toast.success("Settings saved");
      refetch();
    } catch (err: any) {
      toast.error("Save failed", { description: err.message });
    }
  };

  const Toggle = ({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc: string }) => (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-slate-100">
      <button onClick={() => onChange(!checked)}
        className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${checked ? "bg-blue-500" : "bg-slate-200"}`}>
        <div className={`w-3.5 h-3.5 rounded-full bg-white shadow-sm absolute top-[3px] transition-all ${checked ? "left-[18px]" : "left-[3px]"}`} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-slate-700">{label}</div>
        <div className="text-[10px] text-slate-400">{desc}</div>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-2 gap-4 max-w-[900px]">
      {/* Left: Matching config */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-5">
        <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-blue-500" />Auto-Match Configuration
        </h3>

        {/* Threshold slider */}
        <div>
          <div className="flex justify-between mb-1.5">
            <label className="text-xs font-medium text-slate-600">Auto-Accept Threshold</label>
            <span className="text-xs font-bold text-blue-600">{settings.matchThreshold}%</span>
          </div>
          <input type="range" min={50} max={100} value={settings.matchThreshold}
            onChange={e => saveSettings({ matchThreshold: Number(e.target.value) })}
            className="w-full accent-blue-500" />
          <div className="flex justify-between text-[9px] text-slate-400 mt-1">
            <span>50% (loose)</span><span>100% (exact only)</span>
          </div>
          <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
            Items matched above this threshold are automatically accepted. Below this, they land in review.
          </p>
        </div>

        {/* Matching strategies */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-600">Matching Strategy (priority order)</label>
          <Toggle checked={settings.enableExactMatch} onChange={v => saveSettings({ enableExactMatch: v })}
            label="1. Exact Code Match" desc="Supplier code → ERP code from existing mappings" />
          <Toggle checked={settings.enableFuzzyMatch} onChange={v => saveSettings({ enableFuzzyMatch: v })}
            label="2. Fuzzy Description" desc="TF-IDF similarity on product descriptions" />
          <Toggle checked={settings.enableMLRules} onChange={v => saveSettings({ enableMLRules: v })}
            label="3. ML Pattern Rules" desc="Learned transformation rules (prefix, suffix, etc.)" />
          <Toggle checked={settings.enableVLM} onChange={v => saveSettings({ enableVLM: v })}
            label="4. VLM Extraction" desc="Vision Language Model reads the invoice image (requires Ollama)" />
        </div>
      </div>

      {/* Right column */}
      <div className="space-y-4">
        {/* Auto-learn */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-blue-500" />Auto-Learn from Corrections
          </h3>
          <Toggle checked={settings.autoLearn} onChange={v => saveSettings({ autoLearn: v })}
            label="Auto-learn from manual corrections" desc="When a user matches a supplier item to an ERP code, automatically create a mapping" />

          <div className="bg-slate-50 rounded-xl p-3">
            <div className="text-[10px] font-semibold text-slate-500 mb-2">Create mapping after N confirmations:</div>
            <div className="flex gap-2">
              {[1, 2, 3, 5].map(n => (
                <button key={n} onClick={() => saveSettings({ learnAfterN: n })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    settings.learnAfterN === n
                      ? "bg-blue-100 text-blue-700 ring-2 ring-blue-500/30"
                      : "bg-white border border-slate-200 text-slate-500 hover:border-blue-200"
                  }`}>
                  {n}x
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Sync schedule */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-blue-500" />ERP Sync Schedule
          </h3>
          <div>
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Product catalog sync frequency</label>
            <select value={settings.syncSchedule}
              onChange={e => saveSettings({ syncSchedule: e.target.value })}
              className="w-full mt-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs text-slate-600 bg-white">
              <option value="manual">Manual only</option>
              <option value="hourly">Every hour</option>
              <option value="6h">Every 6 hours</option>
              <option value="daily">Daily at 06:00</option>
              <option value="weekly">Weekly (Monday)</option>
            </select>
          </div>
          <div className="bg-emerald-50 rounded-xl p-3 border border-emerald-100">
            <div className="flex items-center gap-1.5 mb-1">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              <span className="text-[11px] font-semibold text-emerald-700">Products loaded from catalog</span>
            </div>
            <span className="text-[10px] text-emerald-600">Use "Import CSV" or "Add Product" on the Products tab to load your ERP catalog</span>
          </div>
        </div>
      </div>
    </div>
  );
}
