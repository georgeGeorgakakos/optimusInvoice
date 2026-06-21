// Storage helpers - uses local filesystem for development,
// can be swapped to S3/cloud storage for production.

import { ENV } from './_core/env';
import fs from 'fs';
import path from 'path';

const LOCAL_STORAGE_DIR = path.join(process.cwd(), 'data', 'uploads');

// Ensure local storage directory exists
function ensureLocalDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isForgeConfigured(): boolean {
  return Boolean(ENV.forgeApiUrl && ENV.forgeApiKey);
}

// ── Forge (cloud) storage ───────────────────────────────────

type StorageConfig = { baseUrl: string; apiKey: string };

function getStorageConfig(): StorageConfig {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "Storage proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function sanitizeFilename(relKey: string): string {
  // Keep the directory structure, only sanitize the filename part
  const dir = path.dirname(relKey);
  const ext = path.extname(relKey);
  const base = path.basename(relKey, ext);
  // Replace non-ASCII and special chars with underscores, keep alphanumeric, hyphens, dots
  const safe = base.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_');
  return path.posix.join(dir, `${safe}${ext}`);
}

function buildAuthHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

// ── Public API ──────────────────────────────────────────────

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);

  // Use local filesystem when Forge is not configured
  if (!isForgeConfigured()) {
    const safeKey = sanitizeFilename(key);
    const filePath = path.join(LOCAL_STORAGE_DIR, safeKey);
    ensureLocalDir(path.dirname(filePath));

    const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    fs.writeFileSync(filePath, buffer);

    const url = `/api/files/${safeKey}`;
    return { key: safeKey, url };
  }

  // Cloud storage path
  const { baseUrl, apiKey } = getStorageConfig();
  const uploadUrl = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  uploadUrl.searchParams.set("path", key);

  const blob =
    typeof data === "string"
      ? new Blob([data], { type: contentType })
      : new Blob([data as any], { type: contentType });
  const form = new FormData();
  form.append("file", blob, key.split("/").pop() ?? key);

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: buildAuthHeaders(apiKey),
    body: form,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Storage upload failed (${response.status} ${response.statusText}): ${message}`
    );
  }
  const url = (await response.json()).url;
  return { key, url };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);

  if (!isForgeConfigured()) {
    const safeKey = sanitizeFilename(key);
    return { key: safeKey, url: `/api/files/${safeKey}` };
  }

  const { baseUrl, apiKey } = getStorageConfig();
  const downloadApiUrl = new URL(
    "v1/storage/downloadUrl",
    ensureTrailingSlash(baseUrl)
  );
  downloadApiUrl.searchParams.set("path", key);
  const response = await fetch(downloadApiUrl, {
    method: "GET",
    headers: buildAuthHeaders(apiKey),
  });
  return { key, url: (await response.json()).url };
}

/** Read file contents directly (works server-side without HTTP) */
export async function storageGetBuffer(relKey: string): Promise<Buffer> {
  const key = normalizeKey(relKey);

  if (!isForgeConfigured()) {
    const safeKey = sanitizeFilename(key);
    const filePath = path.join(LOCAL_STORAGE_DIR, safeKey);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${safeKey}`);
    }
    return fs.readFileSync(filePath);
  }

  // Cloud: fetch via URL
  const { url } = await storageGet(relKey);
  const response = await fetch(url);
  return Buffer.from(await response.arrayBuffer());
}

// Express middleware to serve local files
export function serveLocalFiles(app: import("express").Express) {
  app.get("/api/files/:fileKey(*)", (req, res) => {
    const fileKey = decodeURIComponent(req.params.fileKey);
    const filePath = path.join(LOCAL_STORAGE_DIR, fileKey);
    
    // Prevent directory traversal
    if (!path.resolve(filePath).startsWith(path.resolve(LOCAL_STORAGE_DIR))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    
    res.sendFile(path.resolve(filePath));
  });
}
