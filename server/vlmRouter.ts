/**
 * vlmRouter.ts
 *
 * tRPC router for the VLM/AI extraction stack — proxies status/preload to the
 * FastAPI vlm-service container at $VLM_SERVICE_URL (default http://localhost:8100).
 *
 * Without this router, the Configuration page's VlmStatusPanel always shows
 * "VLM Service offline" because `trpc.vlm.status` resolves to undefined and
 * `data?.available` is falsy.
 *
 * Exposed procedures:
 *   - status   → maps /health response to the shape the UI expects:
 *                  { available, device, loadedModels, vllmModels, engines:{...} }
 *   - preload  → forwards POST /preload/<engine> to start lazy model loading.
 *
 * The shape of `engines` is dictated by Configuration.tsx — it iterates
 * Object.entries(data.engines) and renders a status grid. Each entry needs:
 *   { available: boolean, type: "local" | "vllm" }
 */

import { protectedProcedure, router } from "./_core/trpc";

// Default points at the container-internal port 8100 (NOT the host-mapped 8300).
// In Docker, VLM_SERVICE_URL is set to http://vlm:8100 and overrides this; the
// default only applies when the env var is unset (e.g. local dev against a
// container whose internal port is 8100).
const VLM_URL =
    process.env.VLM_SERVICE_URL || "http://localhost:8100";

// All engines we want to surface in the status grid. The "type" field tells the
// UI whether the engine runs locally (CPU container) or via vLLM (GPU-only).
// "available" is computed dynamically from the /health response.
const ALL_ENGINES: Record<string, { type: "local" | "vllm" }> = {
  surya:          { type: "local" },
  got_ocr2:       { type: "local" },
  marker:         { type: "local" },
  olmocr:         { type: "vllm"  },
  qwen_vl:        { type: "vllm"  },
  qwen_vl_local:  { type: "local" },
  gemma_vl_local: { type: "local" },   // NEW — Gemma 3 vision container
  qwen3vl_local:  { type: "local" },   // Qwen3-VL-8B GGUF llama-server sidecar
  mineru:         { type: "local" },   // NEW — MinerU pipeline backend (CPU) → Markdown → semantic
};

export const vlmRouter = router({
  // ── Status: proxy to /health and reshape ─────────────────────────────────
  // The UI calls this every 30s via refetchInterval; we keep the function
  // very small so the hot-path stays cheap.
  status: protectedProcedure.query(async () => {
    try {
      const res = await fetch(`${VLM_URL}/health`, {
        // Short timeout — if the service is down we don't want to block the
        // entire Configuration page render. Node 18+ supports AbortSignal.timeout.
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        return { available: false } as const;
      }
      const health: any = await res.json();

      // /health returns loaded_models = ["surya", "qwen_vl_local", ...]
      const loaded: string[] = Array.isArray(health.loaded_models)
          ? health.loaded_models
          : [];

      // Build the engines map the UI expects. Local engines are "available"
      // if they appear in loaded_models. Remote (vllm) ones are always shown
      // but reported as unavailable here — they need a GPU + vLLM container.
      const engines: Record<string, { available: boolean; type: string }> = {};
      for (const [name, meta] of Object.entries(ALL_ENGINES)) {
        engines[name] = {
          available: meta.type === "local" ? loaded.includes(name) : false,
          type: meta.type,
        };
      }

      return {
        available: true,
        device: health.device || "cpu",
        loadedModels: loaded,
        vllmModels: [] as string[],   // populated by /models endpoint if needed
        engines,
        semantic: {
          status: health.semantic_llm || "unknown",
          model:  health.semantic_model || null,
        },
      };
    } catch (err) {
      // Any error (timeout, ECONNREFUSED, DNS, JSON parse) = service offline.
      return { available: false } as const;
    }
  }),

  // ── Preload: trigger background model loading on the vlm-service ─────────
  // The UI fires this when the user clicks the small "load" link on an
  // engine card whose model isn't loaded yet.
  preload: protectedProcedure
      .input((val: unknown) => {
        const v = val as any;
        if (!v?.engine) throw new Error("engine required");
        return { engine: String(v.engine) };
      })
      .mutation(async ({ input }) => {
        const res = await fetch(`${VLM_URL}/preload/${input.engine}`, {
          method: "POST",
        });
        if (!res.ok) {
          throw new Error(`Preload ${input.engine} failed: HTTP ${res.status}`);
        }
        return res.json();
      }),
});