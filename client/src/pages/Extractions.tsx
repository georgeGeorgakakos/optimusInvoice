/**
 * Extractions.tsx — Browse and preview saved extraction JSON files.
 *
 * Backed by the `extractions` tRPC sub-router, which reads/writes files under
 * the EXTRACTIONS_DIR (defaults to ./extractions/). Layout:
 *
 *  ┌──────────────────┬─────────────────────────────────────────────────┐
 *  │  Search bar      │                                                 │
 *  ├──────────────────┤                                                 │
 *  │  📂 2026-06-01   │     (right panel — JSON viewer)                 │
 *  │    📁 Fiverr…    │                                                 │
 *  │      📄 INV001   │     pretty-printed, collapsible, with           │
 *  │      📄 INV002   │     syntax highlighting and key path tooltips   │
 *  │    📁 Acme Ltd   │                                                 │
 *  │      📄 INV003   │                                                 │
 *  │  📂 2026-05-31   │                                                 │
 *  │    …             │                                                 │
 *  └──────────────────┴─────────────────────────────────────────────────┘
 *
 * Implementation notes
 * ────────────────────
 *  - We build the tree on the client from the flat list returned by `list()`
 *    to keep the server endpoint simple.
 *  - Default folder state: most-recent date expanded, others collapsed.
 *  - The JSON viewer is a custom recursive component (no external dep) that
 *    handles primitives, arrays and objects with appropriate styling. Objects
 *    and arrays are collapsible.
 *  - Search filters the tree by file name, client name, or date — case-
 *    insensitive substring match.
 *  - Download button: dumps the JSON envelope verbatim using a Blob URL.
 */

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import {
    Archive,
    ChevronDown,
    ChevronRight,
    Download,
    FileJson,
    Folder,
    FolderOpen,
    RefreshCw,
    Search,
    Trash2,
    Calendar,
    Building2,
} from "lucide-react";

// ── Types matching the backend response ─────────────────────────────────────
interface ExtractionFileInfo {
    relativePath: string;
    date:         string;
    client:       string;
    fileName:     string;
    sizeBytes:    number;
    modifiedAt:   string;
}

interface ExportEnvelope {
    meta: {
        invoiceId:        number;
        userId:           number;
        exportedAt:       string;
        engine?:          string | null;
        extractionMethod?: string | null;
    };
    data: any;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Group a flat list of file infos into a 2-level tree: date → client → files.
 * Returns an ordered structure so React renders deterministically.
 */
type ClientGroup = { client: string; files: ExtractionFileInfo[] };
type DateGroup   = { date: string; clients: ClientGroup[] };

function buildTree(files: ExtractionFileInfo[]): DateGroup[] {
    const byDate = new Map<string, Map<string, ExtractionFileInfo[]>>();
    for (const f of files) {
        if (!byDate.has(f.date)) byDate.set(f.date, new Map());
        const dateMap = byDate.get(f.date)!;
        if (!dateMap.has(f.client)) dateMap.set(f.client, []);
        dateMap.get(f.client)!.push(f);
    }
    const tree: DateGroup[] = [];
    // Backend already sorted; preserve insertion order.
    // Use Array.from() instead of `for…of map.entries()` so this compiles cleanly
    // without --downlevelIteration even on TS targets older than ES2015.
    for (const [date, dateMap] of Array.from(byDate.entries())) {
        const clients: ClientGroup[] = [];
        for (const [client, clientFiles] of Array.from(dateMap.entries())) {
            clients.push({ client, files: clientFiles });
        }
        tree.push({ date, clients });
    }
    return tree;
}

/**
 * Format bytes as "1.2 KB" / "345 B" etc.
 */
function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Format an ISO timestamp as a short human time (HH:MM:SS).
 */
function shortTime(iso: string): string {
    try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
        return iso;
    }
}

// ── JSON viewer (recursive, with collapsibles) ──────────────────────────────

interface JsonNodeProps {
    value: any;
    keyName?: string;
    depth: number;
    isLast?: boolean;
}

function JsonNode({ value, keyName, depth, isLast = true }: JsonNodeProps) {
    // For primitive values we just render inline. For objects/arrays we make
    // them collapsible. Default-expanded for depth 0 and 1, collapsed deeper.
    const [open, setOpen] = useState(depth < 2);

    const indent = { paddingLeft: `${depth * 14}px` };

    // ── Primitives ─────────────────────────────────────────────────────────
    if (value === null) {
        return (
            <div style={indent} className="font-mono text-xs leading-relaxed">
                {keyName && <span className="text-purple-700">"{keyName}"</span>}
                {keyName && <span className="text-slate-400">: </span>}
                <span className="text-slate-400 italic">null</span>
                {!isLast && <span className="text-slate-400">,</span>}
            </div>
        );
    }

    if (typeof value === "string") {
        return (
            <div style={indent} className="font-mono text-xs leading-relaxed">
                {keyName && <span className="text-purple-700">"{keyName}"</span>}
                {keyName && <span className="text-slate-400">: </span>}
                <span className="text-emerald-700">"{value}"</span>
                {!isLast && <span className="text-slate-400">,</span>}
            </div>
        );
    }

    if (typeof value === "number") {
        return (
            <div style={indent} className="font-mono text-xs leading-relaxed">
                {keyName && <span className="text-purple-700">"{keyName}"</span>}
                {keyName && <span className="text-slate-400">: </span>}
                <span className="text-blue-700">{value}</span>
                {!isLast && <span className="text-slate-400">,</span>}
            </div>
        );
    }

    if (typeof value === "boolean") {
        return (
            <div style={indent} className="font-mono text-xs leading-relaxed">
                {keyName && <span className="text-purple-700">"{keyName}"</span>}
                {keyName && <span className="text-slate-400">: </span>}
                <span className="text-orange-700">{value ? "true" : "false"}</span>
                {!isLast && <span className="text-slate-400">,</span>}
            </div>
        );
    }

    // ── Arrays ─────────────────────────────────────────────────────────────
    if (Array.isArray(value)) {
        const isEmpty = value.length === 0;
        return (
            <div>
                <div
                    style={indent}
                    className="font-mono text-xs leading-relaxed cursor-pointer hover:bg-slate-50 select-none flex items-start"
                    onClick={() => !isEmpty && setOpen(!open)}
                >
                    {!isEmpty && (
                        <span className="text-slate-400 mr-1">
              {open ? <ChevronDown className="h-3 w-3 inline" /> : <ChevronRight className="h-3 w-3 inline" />}
            </span>
                    )}
                    {keyName && <span className="text-purple-700">"{keyName}"</span>}
                    {keyName && <span className="text-slate-400">: </span>}
                    <span className="text-slate-500">[</span>
                    {isEmpty && <span className="text-slate-500">]</span>}
                    {!isEmpty && !open && (
                        <span className="text-slate-400 italic ml-1">{value.length} items</span>
                    )}
                    {!isEmpty && !open && <span className="text-slate-500">]</span>}
                    {!isLast && (!open || isEmpty) && <span className="text-slate-400">,</span>}
                </div>
                {open && !isEmpty && (
                    <>
                        {value.map((item, i) => (
                            <JsonNode
                                key={i}
                                value={item}
                                depth={depth + 1}
                                isLast={i === value.length - 1}
                            />
                        ))}
                        <div style={indent} className="font-mono text-xs leading-relaxed">
                            <span className="text-slate-500">]</span>
                            {!isLast && <span className="text-slate-400">,</span>}
                        </div>
                    </>
                )}
            </div>
        );
    }

    // ── Objects ────────────────────────────────────────────────────────────
    if (typeof value === "object") {
        const entries = Object.entries(value);
        const isEmpty = entries.length === 0;
        return (
            <div>
                <div
                    style={indent}
                    className="font-mono text-xs leading-relaxed cursor-pointer hover:bg-slate-50 select-none flex items-start"
                    onClick={() => !isEmpty && setOpen(!open)}
                >
                    {!isEmpty && (
                        <span className="text-slate-400 mr-1">
              {open ? <ChevronDown className="h-3 w-3 inline" /> : <ChevronRight className="h-3 w-3 inline" />}
            </span>
                    )}
                    {keyName && <span className="text-purple-700">"{keyName}"</span>}
                    {keyName && <span className="text-slate-400">: </span>}
                    <span className="text-slate-500">&#123;</span>
                    {isEmpty && <span className="text-slate-500">&#125;</span>}
                    {!isEmpty && !open && (
                        <span className="text-slate-400 italic ml-1">{entries.length} keys</span>
                    )}
                    {!isEmpty && !open && <span className="text-slate-500">&#125;</span>}
                    {!isLast && (!open || isEmpty) && <span className="text-slate-400">,</span>}
                </div>
                {open && !isEmpty && (
                    <>
                        {entries.map(([k, v], i) => (
                            <JsonNode
                                key={k}
                                keyName={k}
                                value={v}
                                depth={depth + 1}
                                isLast={i === entries.length - 1}
                            />
                        ))}
                        <div style={indent} className="font-mono text-xs leading-relaxed">
                            <span className="text-slate-500">&#125;</span>
                            {!isLast && <span className="text-slate-400">,</span>}
                        </div>
                    </>
                )}
            </div>
        );
    }

    // Unknown type — should be unreachable
    return <div style={indent} className="font-mono text-xs">{String(value)}</div>;
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function Extractions() {
    const [searchTerm, setSearchTerm] = useState("");
    const [selected, setSelected]     = useState<string | null>(null);
    const [expandedDates, setExpandedDates]     = useState<Set<string>>(new Set());
    const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set());

    // List query
    const listQuery = trpc.extractions.list.useQuery(undefined, {
        refetchOnWindowFocus: false,
    });

    // Get-one query (only when a file is selected)
    const detailQuery = trpc.extractions.get.useQuery(
        { relativePath: selected || "" },
        { enabled: !!selected, refetchOnWindowFocus: false },
    );

    // Delete mutation
    const deleteMutation = trpc.extractions.delete.useMutation({
        onSuccess: () => {
            toast.success("Extraction deleted");
            setSelected(null);
            listQuery.refetch();
        },
        onError: (err) => {
            toast.error(`Delete failed: ${err.message}`);
        },
    });

    // Build the tree from the flat list, applying the search filter
    const tree = useMemo(() => {
        const all = listQuery.data ?? [];
        const term = searchTerm.trim().toLowerCase();
        const filtered = term
            ? all.filter(
                f =>
                    f.fileName.toLowerCase().includes(term) ||
                    f.client.toLowerCase().includes(term) ||
                    f.date.toLowerCase().includes(term),
            )
            : all;
        return buildTree(filtered);
    }, [listQuery.data, searchTerm]);

    // Auto-expand the most recent date on first load
    useMemo(() => {
        if (tree.length > 0 && expandedDates.size === 0) {
            setExpandedDates(new Set([tree[0].date]));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tree.length]);

    // Toggle helpers
    const toggleDate = (date: string) => {
        setExpandedDates(prev => {
            const next = new Set(prev);
            if (next.has(date)) next.delete(date);
            else next.add(date);
            return next;
        });
    };
    const toggleClient = (key: string) => {
        setExpandedClients(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    // Download the currently-viewed JSON as a file
    const handleDownload = () => {
        if (!detailQuery.data || !selected) return;
        const blob = new Blob([JSON.stringify(detailQuery.data, null, 2)], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = selected.split("/").pop() || "extraction.json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleDelete = () => {
        if (!selected) return;
        if (!confirm(`Delete this extraction file?\n\n${selected}`)) return;
        deleteMutation.mutate({ relativePath: selected });
    };

    const totalCount  = listQuery.data?.length ?? 0;
    const visibleCount = tree.reduce(
        (acc, dg) => acc + dg.clients.reduce((a, cg) => a + cg.files.length, 0),
        0,
    );

    return (
        <DashboardLayout>
            <div className="h-full flex flex-col p-6 gap-4">
                {/* ── Header ───────────────────────────────────────────────── */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                            <Archive className="h-6 w-6 text-indigo-600" />
                            Extractions
                        </h1>
                        <p className="text-sm text-slate-500 mt-1">
                            Browse saved invoice extraction JSON files
                            {totalCount > 0 && ` — ${totalCount} total`}
                            {searchTerm && visibleCount !== totalCount && ` (${visibleCount} visible)`}
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => listQuery.refetch()}
                        disabled={listQuery.isFetching}
                    >
                        <RefreshCw className={`h-4 w-4 mr-2 ${listQuery.isFetching ? "animate-spin" : ""}`} />
                        Refresh
                    </Button>
                </div>

                {/* ── Main 2-pane layout ──────────────────────────────────── */}
                <div className="flex-1 grid grid-cols-12 gap-4 min-h-0">
                    {/* Left pane: tree */}
                    <div className="col-span-4 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden">
                        {/* Search bar */}
                        <div className="p-3 border-b border-slate-100">
                            <div className="relative">
                                <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-slate-400" />
                                <Input
                                    type="text"
                                    placeholder="Search by client, date, or filename..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="pl-8 text-sm"
                                />
                            </div>
                        </div>

                        {/* Tree body */}
                        <div className="flex-1 overflow-y-auto p-2 text-sm">
                            {listQuery.isLoading && (
                                <div className="flex items-center justify-center py-8">
                                    <Spinner />
                                </div>
                            )}
                            {!listQuery.isLoading && tree.length === 0 && (
                                <div className="text-center py-8 text-slate-400 text-sm">
                                    {searchTerm ? "No matches" : "No extractions yet"}
                                </div>
                            )}
                            {tree.map(dg => {
                                const dateOpen = expandedDates.has(dg.date);
                                return (
                                    <div key={dg.date} className="mb-1">
                                        {/* Date row */}
                                        <div
                                            className="flex items-center gap-1.5 cursor-pointer hover:bg-slate-50 rounded px-1.5 py-1"
                                            onClick={() => toggleDate(dg.date)}
                                        >
                                            {dateOpen ? (
                                                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                                            ) : (
                                                <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                                            )}
                                            <Calendar className="h-3.5 w-3.5 text-slate-500" />
                                            <span className="font-medium text-slate-700 text-xs">{dg.date}</span>
                                            <span className="text-[10px] text-slate-400 ml-auto">
                        {dg.clients.reduce((a, c) => a + c.files.length, 0)} files
                      </span>
                                        </div>

                                        {/* Clients */}
                                        {dateOpen && (
                                            <div className="ml-4">
                                                {dg.clients.map(cg => {
                                                    const clientKey = `${dg.date}/${cg.client}`;
                                                    const clientOpen = expandedClients.has(clientKey);
                                                    return (
                                                        <div key={clientKey} className="mb-0.5">
                                                            <div
                                                                className="flex items-center gap-1.5 cursor-pointer hover:bg-slate-50 rounded px-1.5 py-1"
                                                                onClick={() => toggleClient(clientKey)}
                                                            >
                                                                {clientOpen ? (
                                                                    <ChevronDown className="h-3 w-3 text-slate-400" />
                                                                ) : (
                                                                    <ChevronRight className="h-3 w-3 text-slate-400" />
                                                                )}
                                                                {clientOpen ? (
                                                                    <FolderOpen className="h-3.5 w-3.5 text-amber-500" />
                                                                ) : (
                                                                    <Folder className="h-3.5 w-3.5 text-amber-500" />
                                                                )}
                                                                <span className="text-slate-700 text-xs truncate" title={cg.client}>
                                    {cg.client}
                                  </span>
                                                                <span className="text-[10px] text-slate-400 ml-auto">
                                    {cg.files.length}
                                  </span>
                                                            </div>

                                                            {clientOpen && (
                                                                <div className="ml-5">
                                                                    {cg.files.map(f => {
                                                                        const isActive = f.relativePath === selected;
                                                                        return (
                                                                            <div
                                                                                key={f.relativePath}
                                                                                className={[
                                                                                    "flex items-center gap-1.5 px-1.5 py-1 cursor-pointer rounded text-xs",
                                                                                    isActive
                                                                                        ? "bg-indigo-50 text-indigo-700 font-medium"
                                                                                        : "hover:bg-slate-50 text-slate-600",
                                                                                ].join(" ")}
                                                                                onClick={() => setSelected(f.relativePath)}
                                                                            >
                                                                                <FileJson className="h-3.5 w-3.5 flex-shrink-0" />
                                                                                <span className="truncate" title={f.fileName}>
                                              {f.fileName}
                                            </span>
                                                                                <span className="text-[10px] text-slate-400 ml-auto whitespace-nowrap">
                                              {shortTime(f.modifiedAt)}
                                            </span>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Right pane: JSON viewer */}
                    <div className="col-span-8 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden">
                        {!selected && (
                            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
                                Select an extraction from the list to preview
                            </div>
                        )}

                        {selected && (
                            <>
                                {/* Toolbar */}
                                <div className="border-b border-slate-100 px-4 py-3 flex items-center gap-3">
                                    <FileJson className="h-4 w-4 text-indigo-600 flex-shrink-0" />
                                    <span className="text-sm font-medium text-slate-800 truncate flex-1" title={selected}>
                    {selected}
                  </span>
                                    {detailQuery.data?.meta?.engine && (
                                        <span className="text-[10px] uppercase tracking-wider font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                      {detailQuery.data.meta.engine}
                    </span>
                                    )}
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleDownload}
                                        disabled={!detailQuery.data}
                                    >
                                        <Download className="h-3.5 w-3.5 mr-1.5" />
                                        Download
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleDelete}
                                        disabled={deleteMutation.isPending}
                                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                    >
                                        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                        Delete
                                    </Button>
                                </div>

                                {/* Meta info bar */}
                                {detailQuery.data?.meta && (
                                    <div className="border-b border-slate-100 px-4 py-2 bg-slate-50/50 flex items-center gap-4 text-xs text-slate-600">
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3.5 w-3.5" />
                            Invoice #{detailQuery.data.meta.invoiceId}
                          </span>
                                        <span>
                            Exported: {new Date(detailQuery.data.meta.exportedAt).toLocaleString()}
                          </span>
                                        {detailQuery.data.meta.extractionMethod && (
                                            <span>Type: {detailQuery.data.meta.extractionMethod}</span>
                                        )}
                                    </div>
                                )}

                                {/* JSON tree */}
                                <div className="flex-1 overflow-auto p-4 bg-slate-50/30">
                                    {detailQuery.isLoading && (
                                        <div className="flex items-center justify-center py-8">
                                            <Spinner />
                                        </div>
                                    )}
                                    {detailQuery.error && (
                                        <div className="text-red-600 text-sm">
                                            Failed to load: {detailQuery.error.message}
                                        </div>
                                    )}
                                    {detailQuery.data && (
                                        <JsonNode value={detailQuery.data} depth={0} />
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </DashboardLayout>
    );
}
