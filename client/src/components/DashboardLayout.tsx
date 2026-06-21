import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { getLoginUrl } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  LayoutDashboard,
  LogOut,
  PanelLeft,
  Upload,
  FileText,
  Brain,
  Settings,
  Database,
  Bell,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  X,
  XCircle,
  Layers,
  Building2,
  Archive,
  ListChecks,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";
import { trpc } from "@/lib/trpc";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { Kbd } from "@/components/ui/kbd";
import { Search } from "lucide-react";

const menuItems = [
  { icon: LayoutDashboard, label: "Dashboard",       path: "/dashboard" },
  { icon: Upload,          label: "Upload Invoice",  path: "/invoices/upload" },
  { icon: FileText,        label: "Invoices",        path: "/invoices" },
  // Processing Queue — live view of the background processing queue. The worker
  // processes invoices server-side, so users can leave and return here anytime.
  { icon: ListChecks,      label: "Processing Queue", path: "/queue" },
  { icon: Archive,         label: "Extractions",     path: "/extractions" },
  { icon: ShieldCheck,     label: "Approvals",       path: "/approvals" },
  { icon: Layers,          label: "ERP Data Model",  path: "/erp-model" },
  { icon: Brain,           label: "Learned Rules",   path: "/rules" },
  { icon: Database,        label: "Knowledge Base",  path: "/knowledge-base" },
  { icon: Settings,        label: "Configuration",   path: "/configuration" },
  { icon: Building2,       label: "Corporate Details",  path: "/settings/client-profile" },
];

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

const NOTIF_CONFIG: Record<string, { icon: any; color: string; bg: string }> = {
  review_needed: {
    icon: AlertCircle,
    color: "text-amber-500",
    bg: "bg-amber-50",
  },
  approval_requested: {
    icon: ShieldCheck,
    color: "text-blue-500",
    bg: "bg-blue-50",
  },
  approval_granted: {
    icon: CheckCircle2,
    color: "text-emerald-500",
    bg: "bg-emerald-50",
  },
  approval_rejected: { icon: XCircle, color: "text-red-500", bg: "bg-red-50" },
  processing_complete: {
    icon: CheckCircle2,
    color: "text-emerald-500",
    bg: "bg-emerald-50",
  },
  processing_failed: { icon: XCircle, color: "text-red-500", bg: "bg-red-50" },
};

export default function DashboardLayout({
                                          children,
                                        }: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) return <DashboardLayoutSkeleton />;

  if (!user) {
    return (
        <div className="relative flex items-center justify-center min-h-screen overflow-hidden bg-[#0a0e1a]">
          <div
              className="pointer-events-none absolute -top-40 -right-32 h-[520px] w-[520px] rounded-full opacity-30"
              style={{ background: "radial-gradient(circle,#6366F1 0%,transparent 70%)" }}
          />
          <div
              className="pointer-events-none absolute -bottom-40 -left-32 h-[460px] w-[460px] rounded-full opacity-25"
              style={{ background: "radial-gradient(circle,#22D3EE 0%,transparent 70%)" }}
          />
          <div className="brand-grid pointer-events-none absolute inset-0 opacity-40" />

          <div className="relative z-10 flex flex-col items-center gap-8 p-8 max-w-md w-full">
            <div className="flex flex-col items-center gap-6">
              <img
                  src="/logo-circle.png"
                  alt="Optimus"
                  className="h-28 w-28 brand-glow rounded-full"
              />
              <div className="text-center">
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2">
                  Welcome to <span className="text-white">Optimus</span><span className="brand-gradient-text">Invoice</span>
                </h1>
                <p className="text-sm text-slate-400">
                  Sign in to manage your invoice automation
                </p>
              </div>
            </div>
            <Button
                onClick={() => {
                  window.location.href = getLoginUrl();
                }}
                size="lg"
                className="w-full border-0 text-white shadow-lg transition-all hover:brightness-110"
                style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}
            >
              Sign in
            </Button>
            <p className="text-xs text-slate-500">
              Autonomous AP engine · Invoice Intelligence
            </p>
          </div>
        </div>
    );
  }

  return (
      <SidebarProvider
          style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
          {children}
        </DashboardLayoutContent>
      </SidebarProvider>
  );
}

function DashboardLayoutContent({
                                  children,
                                  setSidebarWidth,
                                }: {
  children: React.ReactNode;
  setSidebarWidth: (w: number) => void;
}) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // Command palette + keyboard shortcuts
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useKeyboardShortcuts({ onShowHelp: () => setHelpOpen(true) });

  // ── Notifications ──
  const [notifOpen, setNotifOpen] = useState(false);
  const { data: unreadData } = trpc.notifications.unreadCount.useQuery(
      undefined,
      { refetchInterval: 15000 }
  );
  const { data: notifList, refetch: refetchNotifs } =
      trpc.notifications.list.useQuery(undefined, { enabled: notifOpen });
  const markReadMut = trpc.notifications.markRead.useMutation();
  const markAllMut = trpc.notifications.markAllRead.useMutation();
  const unreadCount = unreadData?.count ?? 0;

  // ── Pending approvals badge ──
  const { data: pendingCountData } = trpc.approvals.pendingCount.useQuery(
      undefined,
      { refetchInterval: 30000 }
  );
  const pendingApprovals = pendingCountData?.count ?? 0;

  // ── Processing-queue badge ──
  // Live count of invoices currently queued or processing, shown as a badge on
  // the "Processing Queue" nav item. Polls every 15s (same cadence as the bell).
  // Because the worker runs server-side, this stays accurate even if the user
  // navigates around the app.
  const { data: queueData } = trpc.invoices.queueStatus.useQuery(
      undefined,
      { refetchInterval: 15000 }
  );
  const queueActive =
      (Number((queueData?.counts as any)?.queued) || 0) +
      (Number((queueData?.counts as any)?.processing) || 0);

  const activeMenuItem = menuItems.find(item => {
    if (item.path === "/dashboard") return location === "/dashboard";
    if (item.path === "/invoices/upload")
      return location === "/invoices/upload";
    if (item.path === "/invoices")
      return (
          location.startsWith("/invoices") && location !== "/invoices/upload"
      );
    if (item.path === "/approvals") return location === "/approvals";
    return location === item.path;
  });

  useEffect(() => {
    if (isCollapsed) setIsResizing(false);
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH)
        setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => setIsResizing(false);
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  // Navigation guard.
  // NOTE: with the persistent processing queue, leaving the app NO LONGER loses
  // any work — the background worker keeps extracting server-side and the user
  // can return to the Processing Queue page at any time to see progress. The old
  // "leaving will lose queue progress" warning is therefore obsolete. We keep a
  // light, accurate heads-up (not a blocker) only if a batch is mid-flight, so
  // users simply know where to look — but navigation is never destructive now.
  const guardNav = (path: string) => {
    setLocation(path);
  };

  const handleNotifClick = async (n: any) => {
    if (!n.read) {
      await markReadMut.mutateAsync({ id: n.id });
      refetchNotifs();
    }
    if (n.invoiceId) {
      setNotifOpen(false);
      setLocation(`/invoices/${n.invoiceId}`);
    }
  };

  const fmtAgo = (d: string | Date) => {
    const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
      <>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
        <div className="relative" ref={sidebarRef}>
          <Sidebar
              collapsible="icon"
              className="border-r-0"
              disableTransition={isResizing}
          >
            <SidebarHeader className="h-16 justify-center">
              <div className="flex items-center gap-3 px-2 transition-all w-full">
                <button
                    onClick={toggleSidebar}
                    className="h-8 w-8 flex items-center justify-center hover:bg-white/10 rounded-lg transition-colors focus:outline-none shrink-0"
                    aria-label="Toggle navigation"
                >
                  <PanelLeft className="h-4 w-4 text-slate-400" />
                </button>
                {!isCollapsed && (
                    <div className="flex items-center gap-2.5 min-w-0">
                      <img
                          src="/logo-icon.png"
                          alt="Optimus"
                          className="h-7 w-7 rounded-lg shrink-0 brand-glow"
                      />
                      <span className="font-bold tracking-tight truncate text-base">
                    <span className="text-white">Optimus</span><span className="brand-gradient-text">Invoice</span>
                  </span>
                    </div>
                )}
              </div>
            </SidebarHeader>

            <SidebarContent className="gap-0 px-2 pt-2">
              <SidebarMenu>
                {menuItems.map(item => {
                  const isActive = (() => {
                    if (item.path === "/dashboard")
                      return location === "/dashboard";
                    if (item.path === "/invoices/upload")
                      return location === "/invoices/upload";
                    if (item.path === "/invoices")
                      return (
                          location.startsWith("/invoices") &&
                          location !== "/invoices/upload"
                      );
                    if (item.path === "/approvals")
                      return location === "/approvals";
                    return location === item.path;
                  })();
                  // Badges: approvals shows pending count; queue shows active
                  // (queued + processing) count. Both are live-polled above.
                  const badge =
                      item.path === "/approvals" && pendingApprovals > 0
                          ? pendingApprovals
                          : item.path === "/queue" && queueActive > 0
                              ? queueActive
                              : null;
                  return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                            isActive={isActive}
                            onClick={() => guardNav(item.path)}
                            tooltip={item.label}
                            className={`h-10 rounded-lg transition-all font-normal text-[13px] ${isActive ? "bg-indigo-500/15 text-white font-medium shadow-[inset_2px_0_0_0_#22d3ee]" : "text-slate-400 hover:text-white hover:bg-white/5"}`}
                        >
                          <item.icon
                              className={`h-4 w-4 ${isActive ? "text-cyan-400" : ""}`}
                          />
                          <span className="flex-1">{item.label}</span>
                          {badge !== null && (
                              <span className="ml-auto h-4 min-w-[16px] px-1 text-[9px] font-bold text-white rounded-full flex items-center justify-center" style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1)" }}>
                          {badge > 99 ? "99+" : badge}
                        </span>
                          )}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarContent>

            <SidebarFooter className="p-3">
              {/* Notification bell */}
              <div className="mb-2 relative">
                <button
                    onClick={() => {
                      setNotifOpen(o => !o);
                      if (!notifOpen) refetchNotifs();
                    }}
                    className="flex items-center gap-2.5 w-full px-2 py-2 rounded-lg hover:bg-white/5 transition-colors text-slate-400 hover:text-white group-data-[collapsible=icon]:justify-center focus:outline-none"
                >
                  <div className="relative shrink-0">
                    <Bell className="h-4 w-4" />
                    {unreadCount > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 h-3.5 min-w-[14px] text-[8px] font-bold bg-red-500 text-white rounded-full flex items-center justify-center px-0.5 animate-pulse">
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                    )}
                  </div>
                  {!isCollapsed && (
                      <span className="text-[13px]">Notifications</span>
                  )}
                </button>

                {notifOpen && (
                    <>
                      {/* Backdrop */}
                      <div
                          className="fixed inset-0 z-[99]"
                          onClick={() => setNotifOpen(false)}
                      />
                      {/* Panel */}
                      <div className="absolute bottom-full left-0 mb-2 w-80 bg-white rounded-xl shadow-xl border border-slate-200 z-[100] overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                      <span className="text-sm font-semibold text-slate-800">
                        Notifications
                      </span>
                          <div className="flex items-center gap-2">
                            {unreadCount > 0 && (
                                <button
                                    onClick={async () => {
                                      await markAllMut.mutateAsync();
                                      refetchNotifs();
                                    }}
                                    className="text-[10px] text-blue-600 hover:text-blue-700 font-medium"
                                >
                                  Mark all read
                                </button>
                            )}
                            <button
                                onClick={() => setNotifOpen(false)}
                                className="p-0.5 rounded hover:bg-slate-100"
                            >
                              <X className="h-3.5 w-3.5 text-slate-400" />
                            </button>
                          </div>
                        </div>
                        <div className="max-h-80 overflow-y-auto">
                          {!notifList || notifList.length === 0 ? (
                              <div className="py-8 text-center">
                                <Bell className="h-6 w-6 text-slate-200 mx-auto mb-2" />
                                <p className="text-xs text-slate-400">
                                  No notifications yet
                                </p>
                              </div>
                          ) : (
                              notifList.map((n: any) => {
                                const cfg =
                                    NOTIF_CONFIG[n.type] ||
                                    NOTIF_CONFIG.processing_complete;
                                const Icon = cfg.icon;
                                return (
                                    <button
                                        key={n.id}
                                        onClick={() => handleNotifClick(n)}
                                        className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-slate-50 border-b border-slate-50 transition-colors ${!n.read ? "bg-blue-50/30" : ""}`}
                                    >
                                      <div
                                          className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${cfg.bg}`}
                                      >
                                        <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <p
                                            className={`text-xs leading-snug ${!n.read ? "font-semibold text-slate-800" : "text-slate-600"}`}
                                        >
                                          {n.title}
                                        </p>
                                        {n.message && (
                                            <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-2">
                                              {n.message}
                                            </p>
                                        )}
                                        <p className="text-[9px] text-slate-300 mt-1">
                                          {fmtAgo(n.createdAt)}
                                        </p>
                                      </div>
                                      {!n.read && (
                                          <span className="h-2 w-2 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                                      )}
                                    </button>
                                );
                              })
                          )}
                        </div>
                      </div>
                    </>
                )}
              </div>

              {/* User avatar */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-white/5 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none">
                    <Avatar className="h-8 w-8 border border-slate-600 shrink-0">
                      <AvatarFallback className="text-xs font-semibold text-white" style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}>
                        {user?.name?.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                      <p className="text-sm font-medium text-slate-200 truncate leading-none">
                        {user?.name || "-"}
                      </p>
                      <p className="text-[11px] text-slate-500 truncate mt-1">
                        {user?.email || "-"}
                      </p>
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                      onClick={logout}
                      className="cursor-pointer text-destructive focus:text-destructive"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>Sign out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarFooter>
          </Sidebar>
          <div
              className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-500/30 transition-colors ${isCollapsed ? "hidden" : ""}`}
              onMouseDown={() => {
                if (!isCollapsed) setIsResizing(true);
              }}
              style={{ zIndex: 50 }}
          />
        </div>

        <SidebarInset>
          {isMobile && (
              <div className="flex border-b h-14 items-center justify-between bg-white/80 backdrop-blur px-2 sticky top-0 z-40">
                <div className="flex items-center gap-2">
                  <SidebarTrigger className="h-9 w-9 rounded-lg" />
                  <img
                      src="/logo-icon.png"
                      alt="Optimus"
                      className="h-5 w-5 rounded"
                  />
                  <span className="tracking-tight text-foreground font-medium text-sm">
                {activeMenuItem?.label ?? "OptimusInvoice"}
              </span>
                </div>
                <button
                    onClick={() => setPaletteOpen(true)}
                    aria-label="Open command palette"
                    className="h-9 w-9 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
                >
                  <Search className="h-4 w-4" />
                </button>
              </div>
          )}
          {!isMobile && (
              <div className="flex h-14 items-center justify-between border-b border-border bg-background/70 backdrop-blur px-6 sticky top-0 z-30">
                <h2 className="text-sm font-medium text-foreground tracking-tight">
                  {activeMenuItem?.label ?? "OptimusInvoice"}
                </h2>
                <button
                    onClick={() => setPaletteOpen(true)}
                    className="group flex items-center gap-2 h-9 rounded-lg border border-border bg-muted/40 pl-3 pr-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
                >
                  <Search className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Search…</span>
                  <Kbd className="ml-1">⌘K</Kbd>
                </button>
              </div>
          )}
          <main className="flex-1 p-6 bg-muted/30">{children}</main>
        </SidebarInset>
      </>
  );
}
