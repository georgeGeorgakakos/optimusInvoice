import { useState, useEffect } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import {
  Settings,
  CheckCircle2,
  XCircle,
  Loader2,
  Shield,
  Database,
  Brain,
  Bell,
  FileText,
  Globe,
  Zap,
  ChevronDown,
  ChevronRight,
  Cpu,
  Activity,
} from "lucide-react";
import { toast } from "sonner";

type SettingsState = {
  erpType: string;
  // Softone
  softoneApiUrl: string;
  softoneUsername: string;
  softonePassword: string;
  softoneClientId: string;
  softoneAppId: string;
  softoneCompany: string;
  softoneBranch: string;
  softoneModule: string;
  softoneRefId: string;
  // SAP
  sapApiUrl: string;
  sapCompanyDb: string;
  sapUsername: string;
  sapPassword: string;
  // Dynamics
  dynamicsTenantId: string;
  dynamicsClientId: string;
  dynamicsClientSecret: string;
  dynamicsEnvironment: string;
  // Custom
  customApiUrl: string;
  customAuthType: string;
  customAuthToken: string;
  customHeaders: string;
  // Extraction
  extractionLanguage: string;
  defaultVatRate: string;
  defaultCurrency: string;
  autoProcessOnUpload: boolean;
  // ML
  autoAcceptThreshold: number;
  matchingMethods: string[];
  minConfidenceToShow: number;
  maxSuggestionsPerItem: number;
  // Notifications
  emailNotifications: boolean;
  notifyOnComplete: boolean;
  notifyOnError: boolean;
  defaultSortOrder: string;
  dashboardRefreshInterval: number;
  // OptimusDB
  optimusDbEnabled: boolean;
  optimusDbApiUrl: string;
  optimusDbAuthToken: string;
  optimusDbCatalog: string;
  optimusDbNodeId: string;
  // VLM / AI extraction — these drive the engine selector + service URLs
  vlmServiceUrl: string;
  vllmUrl: string;
  vlmEngine: string;
  useNativeText: boolean;
};

const defaultSettings: SettingsState = {
  erpType: "softone",
  softoneApiUrl: "",
  softoneUsername: "",
  softonePassword: "",
  softoneClientId: "",
  softoneAppId: "",
  softoneCompany: "",
  softoneBranch: "",
  softoneModule: "",
  softoneRefId: "",
  sapApiUrl: "",
  sapCompanyDb: "",
  sapUsername: "",
  sapPassword: "",
  dynamicsTenantId: "",
  dynamicsClientId: "",
  dynamicsClientSecret: "",
  dynamicsEnvironment: "",
  customApiUrl: "",
  customAuthType: "bearer",
  customAuthToken: "",
  customHeaders: "",
  extractionLanguage: "mixed",
  defaultVatRate: "24",
  defaultCurrency: "EUR",
  autoProcessOnUpload: true,
  autoAcceptThreshold: 90,
  matchingMethods: ["exact", "fuzzy", "tfidf", "pattern"],
  minConfidenceToShow: 30,
  maxSuggestionsPerItem: 5,
  emailNotifications: false,
  notifyOnComplete: false,
  notifyOnError: false,
  defaultSortOrder: "newest",
  dashboardRefreshInterval: 30,
  optimusDbEnabled: false,
  optimusDbApiUrl: "",
  optimusDbAuthToken: "",
  optimusDbCatalog: "invoices",
  optimusDbNodeId: "",
  // VLM defaults — Surya is the safe default, the rest come from saved settings
  vlmServiceUrl: "http://localhost:8300",
  vllmUrl:       "http://localhost:8200",
  vlmEngine:     "surya",
  useNativeText: false,
};

const erpConnectors = [
  {
    id: "softone",
    name: "ERP System",
    desc: "ERP integration for invoice reconciliation",
    color: "blue",
  },
  {
    id: "sap",
    name: "SAP Business One",
    desc: "Enterprise resource planning by SAP",
    color: "indigo",
  },
  {
    id: "dynamics",
    name: "Dynamics 365",
    desc: "Microsoft cloud-based ERP platform",
    color: "violet",
  },
  {
    id: "custom",
    name: "Custom REST API",
    desc: "Connect to any ERP via REST API",
    color: "slate",
  },
];

function SectionHeader({
                         icon: Icon,
                         title,
                         desc,
                         color = "slate",
                       }: {
  icon: any;
  title: string;
  desc: string;
  color?: string;
}) {
  const colors: Record<string, string> = {
    slate: "bg-slate-100 text-slate-500",
    blue: "bg-blue-50 text-blue-500",
    amber: "bg-amber-50 text-amber-500",
    violet: "bg-violet-50 text-violet-500",
    emerald: "bg-emerald-50 text-emerald-500",
  };
  return (
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
        <div
            className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${colors[color] || colors.slate}`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <p className="text-xs text-slate-400">{desc}</p>
        </div>
      </div>
  );
}

function Toggle({
                  checked,
                  onChange,
                  label,
                }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
      <label className="flex items-center justify-between cursor-pointer group">
      <span className="text-sm text-slate-600 group-hover:text-slate-800 transition-colors">
        {label}
      </span>
        <button
            type="button"
            onClick={() => onChange(!checked)}
            className={`relative w-10 h-5.5 rounded-full transition-colors ${checked ? "bg-blue-600" : "bg-slate-200"}`}
        >
        <span
            className={`absolute top-0.5 left-0.5 h-4.5 w-4.5 bg-white rounded-full shadow-sm transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0"}`}
            style={{ height: "18px", width: "18px" }}
        />
        </button>
      </label>
  );
}

function MethodChip({
                      active,
                      label,
                      onClick,
                    }: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
      <button
          type="button"
          onClick={onClick}
          className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-all ${
              active
                  ? "bg-blue-50 text-blue-700 border-blue-200"
                  : "bg-white text-slate-400 border-slate-200 hover:border-slate-300"
          }`}
      >
        {label}
      </button>
  );
}

// ─── VLM Status Panel ────────────────────────────────────────────────────────
function VlmStatusPanel() {
  const { data, isLoading, refetch } = trpc.vlm.status.useQuery(undefined, {
    refetchInterval: 30000,
    retry: false,
  });
  const preloadMut = trpc.vlm.preload.useMutation({
    onSuccess: () => {
      toast.success("Preload started");
      refetch();
    },
    onError: e => toast.error(e.message),
  });

  // Display labels for the engine status badges.
  // Includes both vision engines as LOCAL options: Qwen2.5-VL-3B and Gemma 3 4B-it.
  const engineLabels: Record<string, string> = {
    surya: "Surya",
    got_ocr2: "GOT-OCR2",
    marker: "Marker",
    olmocr: "olmOCR-2-7B",
    qwen_vl: "Qwen2.5-VL",
    qwen_vl_local: "Qwen2.5-VL-3B",
    gemma_vl_local: "Gemma 3 4B",       // NEW — parallel container :8500
    qwen3vl_local: "Qwen3-VL-8B",       // NEW — Q5_K_M GGUF llama-server sidecar :8600
    mineru: "MinerU (pipeline)",         // NEW — CPU document parser → Markdown → semantic
  };

  if (isLoading) {
    return (
        <div className="flex items-center gap-2 py-3 text-slate-400 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking VLM service...
        </div>
    );
  }

  if (!data?.available) {
    return (
        <div className="flex items-center justify-between p-3 rounded-lg border border-red-100 bg-red-50">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-500 shrink-0" />
            <div>
              <p className="text-xs font-semibold text-red-700">
                VLM Service offline
              </p>
              <p className="text-[11px] text-red-400">
                Start the service:{" "}
                <code className="font-mono">
                  uvicorn vlm_service:app --port 8300
                </code>
              </p>
            </div>
          </div>
          <Button
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => refetch()}
          >
            Retry
          </Button>
        </div>
    );
  }

  return (
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between p-3 rounded-lg border border-emerald-100 bg-emerald-50">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
            <div>
              <p className="text-xs font-semibold text-emerald-700">
                VLM Service online
              </p>
              <p className="text-[11px] text-emerald-500">
                {data.device?.toUpperCase() || "CPU"} ·{" "}
                {data.loadedModels?.length || 0} models loaded
                {data.vllmModels?.length > 0 &&
                    ` · vLLM: ${data.vllmModels.join(", ")}`}
              </p>
            </div>
          </div>
          <Button
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => refetch()}
          >
            <Activity className="h-3 w-3 mr-1" /> Refresh
          </Button>
        </div>

        {/* Engine status grid — wraps naturally with 7+ engines */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {Object.entries(data.engines || {}).map(
              ([key, engine]: [string, any]) => (
                  <div
                      key={key}
                      className={`relative p-2.5 rounded-lg border text-center transition-all ${
                          engine.available
                              ? "border-emerald-200 bg-emerald-50"
                              : "border-slate-200 bg-slate-50"
                      }`}
                  >
                    <div
                        className={`text-[10px] font-bold mb-0.5 ${engine.available ? "text-emerald-700" : "text-slate-400"}`}
                    >
                      {engineLabels[key] || key}
                    </div>
                    <div
                        className={`text-[9px] uppercase tracking-wide ${engine.available ? "text-emerald-500" : "text-slate-300"}`}
                    >
                      {engine.available
                          ? "✓ ready"
                          : engine.type === "vllm"
                              ? "vLLM offline"
                              : "not loaded"}
                    </div>
                    {!engine.available && engine.type === "local" && (
                        <button
                            onClick={() => preloadMut.mutate({ engine: key })}
                            className="mt-1 text-[9px] text-blue-500 hover:text-blue-700 underline"
                            disabled={preloadMut.isPending}
                        >
                          load
                        </button>
                    )}
                  </div>
              )
          )}
        </div>
      </div>
  );
}

export default function Configuration() {
  const { data: rawConfig, isLoading: configLoading } =
      trpc.configuration.get.useQuery();
  const { data: savedSettings, isLoading: settingsLoading } =
      trpc.configuration.getSettings.useQuery();
  const saveSettingsMutation = trpc.configuration.saveSettings.useMutation();
  const testMutation = trpc.softone.testConnection.useMutation();
  const testOptimusMut = trpc.optimusDb.testConnection.useMutation();

  const [settings, setSettings] = useState<SettingsState>(defaultSettings);
  const [expandedErp, setExpandedErp] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [dirty, setDirty] = useState(false);

  const isLoading = configLoading || settingsLoading;

  useEffect(() => {
    if (savedSettings && rawConfig) {
      setSettings({
        ...defaultSettings,
        ...savedSettings,
        erpType: savedSettings.erpType || rawConfig.erpType || "softone",
        softoneApiUrl: rawConfig.softoneApiUrl || "",
        softoneUsername: rawConfig.softoneUsername || "",
        softonePassword: rawConfig.softonePassword || "",
        softoneClientId: rawConfig.softoneClientId || "",
        softoneAppId: rawConfig.softoneAppId || "",
        softoneCompany: rawConfig.softoneCompany || "",
        softoneBranch: rawConfig.softoneBranch || "",
        softoneModule: rawConfig.softoneModule || "",
        softoneRefId: rawConfig.softoneRefId || "",
      });
      setExpandedErp(savedSettings.erpType || rawConfig.erpType || "softone");
    }
  }, [savedSettings, rawConfig]);

  const update = (key: keyof SettingsState, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const toggleMethod = (method: string) => {
    const current = settings.matchingMethods;
    if (current.includes(method)) {
      if (current.length <= 1) return; // at least one
      update(
          "matchingMethods",
          current.filter(m => m !== method)
      );
    } else {
      update("matchingMethods", [...current, method]);
    }
  };

  const handleSave = async () => {
    try {
      await saveSettingsMutation.mutateAsync(settings);
      toast.success("Settings saved");
      setDirty(false);
    } catch (e: any) {
      toast.error(e.message || "Failed to save");
    }
  };

  const handleTest = async () => {
    try {
      setTestResult(null);
      const result = await testMutation.mutateAsync();
      // testConnection returns a union: {success, message} | {success, error}.
      // Normalize to {success, message} so the state shape stays consistent
      // and TS narrowing works regardless of which branch was returned.
      const message =
          "message" in result
              ? (result as { message: string }).message
              : String((result as { error: unknown }).error ?? "Connection failed");
      const normalised = { success: result.success, message };
      setTestResult(normalised);
      normalised.success
          ? toast.success("Connection successful!")
          : toast.error(normalised.message);
    } catch (e: any) {
      setTestResult({ success: false, message: e.message });
      toast.error("Test failed");
    }
  };

  if (isLoading)
    return (
        <DashboardLayout>
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-7 w-7 border-2 border-blue-600 border-t-transparent" />
          </div>
        </DashboardLayout>
    );

  const softoneFields = [
    {
      id: "softoneApiUrl",
      label: "API URL",
      placeholder: "https://your-erp.example.com/api",
      type: "text",
    },
    {
      id: "softoneUsername",
      label: "Username",
      placeholder: "API username",
      type: "text",
    },
    {
      id: "softonePassword",
      label: "Password",
      placeholder: "API password",
      type: "password",
    },
    {
      id: "softoneCompany",
      label: "Company",
      placeholder: "Company number (e.g. 1)",
      type: "text",
    },
    {
      id: "softoneBranch",
      label: "Branch",
      placeholder: "Branch number (e.g. 1)",
      type: "text",
    },
    {
      id: "softoneClientId",
      label: "Client ID",
      placeholder: "Client ID (optional)",
      type: "text",
    },
    {
      id: "softoneAppId",
      label: "App ID",
      placeholder: "App ID (optional)",
      type: "text",
    },
    {
      id: "softoneModule",
      label: "Module",
      placeholder: "Module (optional)",
      type: "text",
    },
    {
      id: "softoneRefId",
      label: "Reference ID",
      placeholder: "Reference ID (optional)",
      type: "text",
    },
  ];
  const sapFields = [
    {
      id: "sapApiUrl",
      label: "Service Layer URL",
      placeholder: "https://server:50000/b1s/v1",
      type: "text",
    },
    {
      id: "sapCompanyDb",
      label: "Company Database",
      placeholder: "SBODemoUS",
      type: "text",
    },
    {
      id: "sapUsername",
      label: "Username",
      placeholder: "manager",
      type: "text",
    },
    {
      id: "sapPassword",
      label: "Password",
      placeholder: "Password",
      type: "password",
    },
  ];
  const dynamicsFields = [
    {
      id: "dynamicsTenantId",
      label: "Tenant ID",
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      type: "text",
    },
    {
      id: "dynamicsClientId",
      label: "Client ID",
      placeholder: "Application (client) ID",
      type: "text",
    },
    {
      id: "dynamicsClientSecret",
      label: "Client Secret",
      placeholder: "Client secret value",
      type: "password",
    },
    {
      id: "dynamicsEnvironment",
      label: "Environment",
      placeholder: "production",
      type: "text",
    },
  ];
  const customFields = [
    {
      id: "customApiUrl",
      label: "Base URL",
      placeholder: "https://api.your-erp.com/v1",
      type: "text",
    },
    {
      id: "customAuthType",
      label: "Auth Type",
      placeholder: "bearer",
      type: "text",
    },
    {
      id: "customAuthToken",
      label: "Auth Token / Key",
      placeholder: "Bearer token or API key",
      type: "password",
    },
    {
      id: "customHeaders",
      label: "Custom Headers (JSON)",
      placeholder: '{"X-Custom": "value"}',
      type: "text",
    },
  ];

  const erpFieldsMap: Record<string, typeof softoneFields> = {
    softone: softoneFields,
    sap: sapFields,
    dynamics: dynamicsFields,
    custom: customFields,
  };

  return (
      <DashboardLayout>
        <div className="space-y-6 max-w-3xl">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                Configuration
              </h1>
              <p className="text-slate-500 mt-1 text-sm">
                System settings, ERP connections, and ML parameters
              </p>
            </div>
            {dirty && (
                <Button
                    onClick={handleSave}
                    disabled={saveSettingsMutation.isPending}
                    size="sm"
                    className="bg-primary hover:bg-primary/90 text-white text-xs h-8 px-4 shadow-sm"
                >
                  {saveSettingsMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : null}
                  Save All Changes
                </Button>
            )}
          </div>

          {/* ═══════════ SECTION 1: ERP INTEGRATIONS ═══════════ */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <SectionHeader
                icon={Database}
                title="ERP Integration"
                desc="Select and configure your ERP connector"
                color="blue"
            />
            <div className="p-5 space-y-3">
              {/* ERP Selector Cards */}
              <div className="grid grid-cols-2 gap-3">
                {erpConnectors.map(erp => {
                  const isSelected = settings.erpType === erp.id;
                  const colorMap: Record<string, string> = {
                    blue: "border-blue-400 bg-blue-50/50 ring-1 ring-blue-200",
                    indigo:
                        "border-indigo-400 bg-indigo-50/50 ring-1 ring-indigo-200",
                    violet:
                        "border-violet-400 bg-violet-50/50 ring-1 ring-violet-200",
                    slate:
                        "border-slate-400 bg-slate-50/50 ring-1 ring-slate-200",
                  };
                  return (
                      <button
                          key={erp.id}
                          type="button"
                          onClick={() => {
                            update("erpType", erp.id);
                            setExpandedErp(erp.id);
                          }}
                          className={`p-3.5 rounded-xl border text-left transition-all ${
                              isSelected
                                  ? colorMap[erp.color]
                                  : "border-slate-200 hover:border-slate-300"
                          }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-semibold text-slate-800">
                        {erp.name}
                      </span>
                          {isSelected && (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">
                          Active
                        </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400">{erp.desc}</p>
                      </button>
                  );
                })}
              </div>

              {/* Expanded Credentials */}
              {expandedErp && (
                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                        {erpConnectors.find(e => e.id === expandedErp)?.name}{" "}
                        Credentials
                      </p>
                      {expandedErp === "softone" && (
                          <Button
                              variant="outline"
                              size="sm"
                              onClick={handleTest}
                              disabled={testMutation.isPending}
                              className="text-[11px] h-7 px-3 border-slate-200"
                          >
                            {testMutation.isPending ? (
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                                <Zap className="h-3 w-3 mr-1" />
                            )}
                            Test
                          </Button>
                      )}
                    </div>
                    <div className="grid md:grid-cols-2 gap-3">
                      {(erpFieldsMap[expandedErp] || []).map(f => (
                          <div key={f.id} className="space-y-1">
                            <Label
                                htmlFor={f.id}
                                className="text-[11px] font-medium text-slate-500"
                            >
                              {f.label}
                            </Label>
                            <Input
                                id={f.id}
                                type={f.type}
                                placeholder={f.placeholder}
                                value={(settings as any)[f.id] || ""}
                                onChange={e =>
                                    update(f.id as keyof SettingsState, e.target.value)
                                }
                                className="h-8 text-xs bg-slate-50 border-slate-200 focus:bg-white"
                            />
                          </div>
                      ))}
                    </div>
                    {testResult && (
                        <div
                            className={`mt-3 p-3 rounded-lg border flex items-center gap-2 ${
                                testResult.success
                                    ? "bg-emerald-50 border-emerald-200"
                                    : "bg-red-50 border-red-200"
                            }`}
                        >
                          {testResult.success ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                          ) : (
                              <XCircle className="h-3.5 w-3.5 text-red-600" />
                          )}
                          <p
                              className={`text-xs ${testResult.success ? "text-emerald-700" : "text-red-700"}`}
                          >
                            {testResult.message}
                          </p>
                        </div>
                    )}
                  </div>
              )}
            </div>
          </div>

          {/* ═══════════ SECTION: OPTIMUSDB CATALOG ═══════════ */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <SectionHeader
                icon={Globe}
                title="OptimusDB Catalog"
                desc="Push processed invoices to the OptimusDB distributed data catalog"
                color="emerald"
            />
            <div className="p-5 space-y-4">
              {/* Enable toggle */}
              <div className="flex items-center justify-between p-3 rounded-lg bg-emerald-50/50 border border-emerald-100">
                <div>
                  <p className="text-sm font-medium text-slate-700">
                    Enable OptimusDB Integration
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Automatically push completed invoices to the catalog
                  </p>
                </div>
                <button
                    onClick={() =>
                        setSettings(s => ({
                          ...s,
                          optimusDbEnabled: !s.optimusDbEnabled,
                        }))
                    }
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        settings.optimusDbEnabled ? "bg-emerald-500" : "bg-slate-200"
                    }`}
                >
                <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
                        settings.optimusDbEnabled
                            ? "translate-x-6"
                            : "translate-x-1"
                    }`}
                />
                </button>
              </div>

              {settings.optimusDbEnabled && (
                  <>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium text-slate-500">
                          API URL *
                        </Label>
                        <Input
                            className="text-xs h-9 font-mono"
                            placeholder="http://localhost:8080/api"
                            value={settings.optimusDbApiUrl}
                            onChange={e =>
                                setSettings(s => ({
                                  ...s,
                                  optimusDbApiUrl: e.target.value,
                                }))
                            }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium text-slate-500">
                          Auth Token
                        </Label>
                        <Input
                            className="text-xs h-9 font-mono"
                            type="password"
                            placeholder="Bearer token (optional)"
                            value={settings.optimusDbAuthToken}
                            onChange={e =>
                                setSettings(s => ({
                                  ...s,
                                  optimusDbAuthToken: e.target.value,
                                }))
                            }
                        />
                      </div>
                    </div>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium text-slate-500">
                          Catalog Name
                        </Label>
                        <Input
                            className="text-xs h-9"
                            placeholder="invoices"
                            value={settings.optimusDbCatalog}
                            onChange={e =>
                                setSettings(s => ({
                                  ...s,
                                  optimusDbCatalog: e.target.value,
                                }))
                            }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium text-slate-500">
                          Node ID
                        </Label>
                        <Input
                            className="text-xs h-9 font-mono"
                            placeholder="node-1 (optional)"
                            value={settings.optimusDbNodeId}
                            onChange={e =>
                                setSettings(s => ({
                                  ...s,
                                  optimusDbNodeId: e.target.value,
                                }))
                            }
                        />
                      </div>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-8 gap-1.5"
                        disabled={
                            !settings.optimusDbApiUrl || testOptimusMut.isPending
                        }
                        onClick={async () => {
                          try {
                            await saveSettingsMutation.mutateAsync(settings);
                            const result = await testOptimusMut.mutateAsync();
                            if (result.success)
                              toast.success(
                                  `OptimusDB connected! Version: ${result.version || "OK"}`
                              );
                            else toast.error(`Connection failed: ${result.error}`);
                          } catch (err: any) {
                            toast.error(err.message);
                          }
                        }}
                    >
                      {testOptimusMut.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                          <Zap className="h-3 w-3" />
                      )}
                      Test Connection
                    </Button>
                  </>
              )}
            </div>
          </div>

          {/* ═══════════ SECTION: VLM SERVICE ═══════════ */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <SectionHeader
                icon={Cpu}
                title="VLM / AI Extraction Engines"
                desc="Configure visual AI models for high-accuracy invoice OCR"
                color="violet"
            />
            <div className="p-5 space-y-5">
              {/* Live status */}
              <VlmStatusPanel />

              {/* Service URL */}
              <div className="grid md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-[11px] font-medium text-slate-500">
                    VLM Service URL
                  </Label>
                  <Input
                      className="h-8 text-xs"
                      placeholder="http://localhost:8300"
                      value={(settings as any).vlmServiceUrl ?? ""}
                      onChange={e => update("vlmServiceUrl", e.target.value)}
                  />
                  <p className="text-[10px] text-slate-400">
                    FastAPI service: Surya + pdfplumber + dispatcher (8300)
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] font-medium text-slate-500">
                    vLLM Server URL
                  </Label>
                  <Input
                      className="h-8 text-xs"
                      placeholder="http://localhost:8200"
                      value={(settings as any).vllmUrl ?? ""}
                      onChange={e => update("vllmUrl", e.target.value)}
                  />
                  <p className="text-[10px] text-slate-400">
                    vLLM: olmOCR-2-7B + Qwen2.5-VL-7B/3B (GPU only)
                  </p>
                </div>
              </div>

              {/* Default engine */}
              <div className="space-y-1">
                <Label className="text-[11px] font-medium text-slate-500">
                  Default Engine
                </Label>
                <select
                    value={(settings as any).vlmEngine ?? "surya"}
                    onChange={e => update("vlmEngine", e.target.value)}
                    className="w-full max-w-xs h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-3 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  <option value="auto">
                    Auto — pdfplumber for digital PDFs, Surya OCR for scans (recommended)
                  </option>
                  <option value="surya">
                    Surya — OCR for scanned/image PDFs (Greek+English, slow on CPU)
                  </option>
                  <option value="qwen_vl_local">
                    Qwen2.5-VL-3B — vision model via transformers fp32 (slowest, CPU)
                  </option>
                  {/* NEW — Gemma 3 4B-it parallel container on port 8500 */}
                  <option value="gemma_vl_local">
                    Gemma 3 4B-it — vision model, best for hard/watermarked Greek scans (CPU)
                  </option>
                  {/* NEW — Qwen3-VL-8B Q5_K_M GGUF via llama-server sidecar on port 8600 */}
                  <option value="qwen3vl_local">
                    Qwen3-VL-8B — vision model GGUF, highest accuracy, slower than Gemma (CPU)
                  </option>
                  {/* NEW — MinerU pipeline backend (pure CPU) → Markdown → semantic_extractor */}
                  <option value="mineru">
                    MinerU — document parser → Markdown (tables; struggles with watermarks)
                  </option>
                  <option value="got_ocr2" disabled style={{color:"#94a3b8"}}>
                    GOT-OCR2 — not available (conflicts with transformers 4.52)
                  </option>
                  <option value="olmocr" disabled style={{color:"#94a3b8"}}>
                    olmOCR-2-7B — not available (requires vLLM + GPU)
                  </option>
                  <option value="marker" disabled style={{color:"#94a3b8"}}>
                    Marker — not available (conflicts with current dependencies)
                  </option>
                  <option value="qwen_vl" disabled style={{color:"#94a3b8"}}>
                    Qwen2.5-VL — not available (requires vLLM + GPU)
                  </option>
                </select>
              </div>

              {/* Engine descriptions */}
              <div className="grid md:grid-cols-2 gap-2">
                {[
                  {
                    key: "surya",
                    label: "Surya OCR",
                    desc: "Greek layout detection + recognition. Local CPU. 10–30s.",
                    tag: "local",
                    available: true,
                  },
                  {
                    key: "qwen_vl_local",
                    label: "Qwen2.5-VL-3B",
                    desc: "Alibaba vision model — reads invoice image directly, outputs structured JSON. Local CPU. 90–120s. Run Download-VlmWheels.ps1 first to pre-cache model.",
                    tag: "local",
                    available: true,
                  },
                  // NEW — parallel Gemma 3 container on :8500
                  {
                    key: "gemma_vl_local",
                    label: "Gemma 3 4B-it",
                    desc: "Google vision model — reads invoice image directly, outputs structured JSON. Local CPU. 60–90s. Requires HuggingFace license acceptance + HF_TOKEN in .env.",
                    tag: "local",
                    available: true,
                  },
                  // NEW — MinerU pipeline backend (pure CPU document reader)
                  {
                    key: "mineru",
                    label: "MinerU (pipeline)",
                    desc: "Document parser — converts the PDF to Markdown (tables as HTML), then the semantic extractor maps it to the invoice schema. Reader, not vision-to-JSON. Pure CPU, hallucination-free. Run: pip install \"mineru[core]\".",
                    tag: "local",
                    available: true,
                  },
                  {
                    key: "got_ocr2",
                    label: "GOT-OCR2",
                    desc: "Not available — conflicts with transformers>=4.52 required by Qwen2.5-VL / Gemma 3.",
                    tag: "unavailable",
                    available: false,
                  },
                  {
                    key: "marker",
                    label: "Marker",
                    desc: "Not available — dependency conflicts with current image.",
                    tag: "unavailable",
                    available: false,
                  },
                  {
                    key: "olmocr",
                    label: "olmOCR-2-7B",
                    desc: "Not available — requires vLLM container + GPU.",
                    tag: "unavailable",
                    available: false,
                  },
                  {
                    key: "qwen_vl",
                    label: "Qwen2.5-VL-7B/3B",
                    desc: "Not available — requires vLLM container + GPU.",
                    tag: "unavailable",
                    available: false,
                  },
                ].map(e => (
                    <div
                        key={e.key}
                        className={`flex items-start gap-2 p-3 rounded-lg border ${
                            (e as any).available === false
                                ? "border-slate-100 bg-slate-50 opacity-50"
                                : "border-slate-100 bg-slate-50"
                        }`}
                    >
                  <span
                      className={`mt-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                          (e as any).tag === "unavailable"
                              ? "bg-slate-100 text-slate-400"
                              : (e as any).tag === "vllm"
                                  ? "bg-violet-100 text-violet-700"
                                  : "bg-blue-50 text-blue-700"
                      }`}
                  >
                    {(e as any).tag === "unavailable" ? "off" : (e as any).tag}
                  </span>
                      <div>
                        <p className={`text-xs font-semibold ${(e as any).available === false ? "text-slate-400" : "text-slate-700"}`}>
                          {e.label}
                        </p>
                        <p className="text-[11px] text-slate-400 leading-snug">
                          {e.desc}
                        </p>
                      </div>
                    </div>
                ))}
              </div>
            </div>
          </div>

          {/* ═══════════ SECTION 2: PDF EXTRACTION ═══════════ */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <SectionHeader
                icon={FileText}
                title="PDF Extraction Settings"
                desc="Configure how invoices are parsed"
                color="amber"
            />
            <div className="p-5 space-y-4">
              <div className="grid md:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-[11px] font-medium text-slate-500">
                    Language
                  </Label>
                  <select
                      value={settings.extractionLanguage}
                      onChange={e => update("extractionLanguage", e.target.value)}
                      className="w-full h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-3 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                  >
                    <option value="greek">Greek</option>
                    <option value="english">English</option>
                    <option value="mixed">Mixed (Greek + English)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] font-medium text-slate-500">
                    Default VAT Rate
                  </Label>
                  <select
                      value={settings.defaultVatRate}
                      onChange={e => update("defaultVatRate", e.target.value)}
                      className="w-full h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-3 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                  >
                    <option value="24">24%</option>
                    <option value="13">13%</option>
                    <option value="6">6%</option>
                    <option value="0">0% (Exempt)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] font-medium text-slate-500">
                    Default Currency
                  </Label>
                  <select
                      value={settings.defaultCurrency}
                      onChange={e => update("defaultCurrency", e.target.value)}
                      className="w-full h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-3 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                  >
                    <option value="EUR">EUR - Euro</option>
                    <option value="USD">USD - US Dollar</option>
                    <option value="GBP">GBP - Pound Sterling</option>
                  </select>
                </div>
              </div>
              <div className="space-y-2 pt-1">
                <Toggle
                    checked={settings.autoProcessOnUpload}
                    onChange={v => update("autoProcessOnUpload", v)}
                    label="Auto-process invoice on upload"
                />
                <div className="flex items-start gap-3 pt-1 pb-1 px-3 rounded-lg border border-slate-100 bg-slate-50">
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-slate-700 mb-0.5">
                      Native text extraction (pdfplumber)
                    </p>
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      When <strong>ON</strong>: digitally-generated PDFs (Fiverr, Adobe, etc.) are read directly
                      without OCR — instant and perfectly accurate. Scanned PDFs still use Surya.
                      <br/>
                      When <strong>OFF</strong>: Surya OCR runs on every invoice regardless of type
                      — consistent visual processing, ~2 min per page on CPU.
                    </p>
                  </div>
                  <div className="mt-0.5 shrink-0">
                    <Toggle
                        checked={(settings as any).useNativeText === true}
                        onChange={v => update("useNativeText", v)}
                        label=""
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ═══════════ SECTION 3: ML MATCHING ═══════════ */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <SectionHeader
                icon={Brain}
                title="ML Matching Settings"
                desc="Configure AI-powered product matching behavior"
                color="violet"
            />
            <div className="p-5 space-y-5">
              {/* Auto-accept threshold */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <Label className="text-xs font-medium text-slate-700">
                      Auto-Accept Threshold
                    </Label>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Matches above this confidence are auto-confirmed
                    </p>
                  </div>
                  <span className="text-lg font-bold text-blue-700 tabular-nums">
                  {settings.autoAcceptThreshold}%
                </span>
                </div>
                <input
                    type="range"
                    min={50}
                    max={100}
                    step={5}
                    value={settings.autoAcceptThreshold}
                    onChange={e =>
                        update("autoAcceptThreshold", Number(e.target.value))
                    }
                    className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between text-[10px] text-slate-300 mt-1">
                  <span>50% (aggressive)</span>
                  <span>100% (manual only)</span>
                </div>
              </div>

              {/* Matching methods */}
              <div>
                <Label className="text-xs font-medium text-slate-700 mb-2 block">
                  Active Matching Methods
                </Label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: "exact", label: "Exact Match" },
                    { id: "fuzzy", label: "Fuzzy Match" },
                    { id: "tfidf", label: "TF-IDF Similarity" },
                    { id: "pattern", label: "Pattern Rules" },
                  ].map(m => (
                      <MethodChip
                          key={m.id}
                          active={settings.matchingMethods.includes(m.id)}
                          label={m.label}
                          onClick={() => toggleMethod(m.id)}
                      />
                  ))}
                </div>
              </div>

              {/* Numeric settings */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className="text-[11px] font-medium text-slate-500">
                    Min. Confidence to Show
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                        type="number"
                        min={0}
                        max={100}
                        value={settings.minConfidenceToShow}
                        onChange={e =>
                            update("minConfidenceToShow", Number(e.target.value))
                        }
                        className="h-8 text-xs bg-slate-50 border-slate-200 w-20 tabular-nums"
                    />
                    <span className="text-xs text-slate-400">
                    % minimum to display as suggestion
                  </span>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] font-medium text-slate-500">
                    Max Suggestions
                  </Label>
                  <div className="flex items-center gap-2">
                    <select
                        value={settings.maxSuggestionsPerItem}
                        onChange={e =>
                            update("maxSuggestionsPerItem", Number(e.target.value))
                        }
                        className="h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-3 w-20"
                    >
                      <option value={3}>3</option>
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                    </select>
                    <span className="text-xs text-slate-400">per line item</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ═══════════ SECTION 4: NOTIFICATIONS ═══════════ */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <SectionHeader
                icon={Bell}
                title="Notifications & Preferences"
                desc="Email alerts and display preferences"
                color="emerald"
            />
            <div className="p-5 space-y-4">
              <Toggle
                  checked={settings.emailNotifications}
                  onChange={v => update("emailNotifications", v)}
                  label="Enable email notifications"
              />
              {settings.emailNotifications && (
                  <div className="pl-4 border-l-2 border-slate-100 space-y-3">
                    <Toggle
                        checked={settings.notifyOnComplete}
                        onChange={v => update("notifyOnComplete", v)}
                        label="Notify when invoice processing completes"
                    />
                    <Toggle
                        checked={settings.notifyOnError}
                        onChange={v => update("notifyOnError", v)}
                        label="Notify on processing errors"
                    />
                  </div>
              )}
              <div className="pt-2 border-t border-slate-100 space-y-3">
                <div className="flex items-center justify-between">
                <span className="text-sm text-slate-600">
                  Default invoice sort order
                </span>
                  <select
                      value={settings.defaultSortOrder}
                      onChange={e => update("defaultSortOrder", e.target.value)}
                      className="h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-3"
                  >
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                <span className="text-sm text-slate-600">
                  Dashboard refresh interval
                </span>
                  <select
                      value={settings.dashboardRefreshInterval}
                      onChange={e =>
                          update("dashboardRefreshInterval", Number(e.target.value))
                      }
                      className="h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-3"
                  >
                    <option value={15}>15 seconds</option>
                    <option value={30}>30 seconds</option>
                    <option value={60}>1 minute</option>
                    <option value={0}>Manual only</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Save button (always visible at bottom) */}
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-2">
              <Shield className="h-4 w-4 text-slate-300 mt-0.5 shrink-0" />
              <p className="text-xs text-slate-400">
                Credentials are stored securely and used only for ERP API calls.
              </p>
            </div>
            <Button
                onClick={handleSave}
                disabled={saveSettingsMutation.isPending}
                size="sm"
                className="bg-primary hover:bg-primary/90 text-white text-xs h-8 px-5"
            >
              {saveSettingsMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              Save All Changes
            </Button>
          </div>
        </div>
      </DashboardLayout>
  );
}
