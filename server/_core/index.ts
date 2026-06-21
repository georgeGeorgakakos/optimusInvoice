import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
// Background processing-queue worker. Started after the HTTP server is listening
// (see end of startServer). Decouples invoice extraction from the request
// lifecycle so work survives browser-close / navigation and batch is possible.
import { startQueueWorker } from "../queueWorker";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Serve locally stored files (dev mode without cloud storage)
  const { serveLocalFiles } = await import("../storage");
  serveLocalFiles(app);
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
      "/api/trpc",
      createExpressMiddleware({
        router: appRouter,
        createContext,
      })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // Extend server timeouts to handle long-running Qwen2.5-3B inference.
  // Qwen on CPU can take 30-120s per invoice; default headersTimeout=60s drops these.
  // requestTimeout=0 means no hard limit — the VLM_TIMEOUT AbortController handles it.
  server.headersTimeout = 0;        // disable the 60s headers timeout
  server.requestTimeout = 0;        // no request body timeout (VLM fetch has its own)
  server.keepAliveTimeout = 650000; // 650s keep-alive (slightly above VLM_TIMEOUT 600s)
  server.timeout = 0;               // disable legacy socket inactivity timeout

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);

    // ── Start the background processing-queue worker ──────────────────────────
    // Kicked off AFTER listen() so the HTTP server is up first. The worker runs
    // for the lifetime of the process: it claims 'queued' invoices, runs the
    // shared extraction pipeline, and updates status/progress in MySQL. On boot
    // it also recovers any invoices stranded at 'processing' (crash/restart or a
    // browser-killed request under the old inline model). Failures here must not
    // take down the web server, so we catch and log.
    startQueueWorker().catch(err =>
        console.error("[QueueWorker] failed to start:", err)
    );
  });
}

startServer().catch(console.error);