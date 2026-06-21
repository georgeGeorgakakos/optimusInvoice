import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { trpc } from "@/lib/trpc";
import {
  LayoutDashboard,
  Upload,
  FileText,
  Archive,
  ShieldCheck,
  Layers,
  Brain,
  Database,
  Settings,
  Building2,
  Moon,
  Sun,
  FileSearch,
} from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";

/**
 * Global command palette. Mount once near the app root (inside the
 * authenticated shell). Opens on ⌘K / Ctrl-K, or via the `open`/`onOpenChange`
 * props if you want to trigger it from a button.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = isControlled ? onOpenChange ?? (() => {}) : setInternalOpen;

  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  // Theme toggle (ThemeProvider is always mounted at the app root).
  const { theme, setTheme } = useTheme();

  // Live invoice search — only fetch the list while the palette is open.
  const { data: invoices } = trpc.invoices.list.useQuery(undefined, {
    enabled: isOpen,
  });

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!isOpen);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [isOpen, setOpen]);

  const go = (path: string) => {
    setOpen(false);
    setLocation(path);
  };

  const nav = [
    { icon: LayoutDashboard, label: "Dashboard", path: "/dashboard" },
    { icon: Upload, label: "Upload invoice", path: "/invoices/upload" },
    { icon: FileText, label: "Invoices", path: "/invoices" },
    { icon: Archive, label: "Extractions", path: "/extractions" },
    { icon: ShieldCheck, label: "Approvals", path: "/approvals" },
    { icon: Layers, label: "ERP data model", path: "/erp-model" },
    { icon: Brain, label: "Learned rules", path: "/rules" },
    { icon: Database, label: "Knowledge base", path: "/knowledge-base" },
    { icon: Settings, label: "Configuration", path: "/configuration" },
    { icon: Building2, label: "Corporate details", path: "/settings/client-profile" },
  ];

  const matchedInvoices = useMemo(() => {
    if (!invoices || !Array.isArray(invoices)) return [];
    const q = search.trim().toLowerCase();
    const list = invoices as any[];
    if (!q) return list.slice(0, 5);
    return list
      .filter(inv => {
        const num = String(inv.invoiceNumber ?? inv.number ?? inv.id ?? "").toLowerCase();
        const vendor = String(inv.vendor ?? inv.supplierName ?? inv.vendorName ?? "").toLowerCase();
        return num.includes(q) || vendor.includes(q);
      })
      .slice(0, 6);
  }, [invoices, search]);

  return (
    <CommandDialog open={isOpen} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search invoices, jump to a page, run an action…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {matchedInvoices.length > 0 && (
          <CommandGroup heading="Invoices">
            {matchedInvoices.map((inv: any) => (
              <CommandItem
                key={inv.id}
                value={`invoice ${inv.invoiceNumber ?? inv.id} ${inv.vendor ?? inv.supplierName ?? ""}`}
                onSelect={() => go(`/invoices/${inv.id}`)}
              >
                <FileSearch className="mr-2 h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">
                  {inv.invoiceNumber ?? inv.number ?? `Invoice #${inv.id}`}
                </span>
                {(inv.vendor || inv.supplierName || inv.vendorName) && (
                  <span className="ml-2 text-xs text-muted-foreground truncate max-w-[140px]">
                    {inv.vendor ?? inv.supplierName ?? inv.vendorName}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Navigate">
          {nav.map(item => (
            <CommandItem
              key={item.path}
              value={`go ${item.label}`}
              onSelect={() => go(item.path)}
            >
              <item.icon className="mr-2 h-4 w-4 text-muted-foreground" />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Actions">
          <CommandItem
            value="toggle theme dark light mode"
            onSelect={() => {
              setTheme(theme === "dark" ? "light" : "dark");
              setOpen(false);
            }}
          >
            {theme === "dark" ? (
              <Sun className="mr-2 h-4 w-4 text-muted-foreground" />
            ) : (
              <Moon className="mr-2 h-4 w-4 text-muted-foreground" />
            )}
            Toggle {theme === "dark" ? "light" : "dark"} mode
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
