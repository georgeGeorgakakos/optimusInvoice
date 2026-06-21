# 🏗️ Build System & Output Directories

> How Optimus Invoice is compiled, where the output lands, and what Electron does with it.

---

## The Big Picture

Optimus Invoice can be delivered in two completely different ways:

| Mode | Who uses it | How they access it |
|---|---|---|
| **Web App** | Developer / server deployment | Browser at `http://localhost:3000` |
| **Desktop App** | End users | Double-click the `.exe` / `.dmg` / `.AppImage` |

Both modes compile the **same source code** but produce different output and use different tooling. Understanding which mode you are building for determines which commands you run and which output folders matter.

---

## What Gets Compiled and Why

The project has three distinct pieces of code that each need their own compilation step:

### 1. The Frontend (React + TypeScript)
The `client/src/` folder contains React components written in TypeScript with Tailwind CSS. Browsers cannot run TypeScript directly — they only understand plain JavaScript and CSS. **Vite** compiles the TypeScript, bundles all the React components into a single minified JavaScript file, and processes Tailwind into a single CSS file.

### 2. The Backend (Node.js + TypeScript)
The `server/` folder contains the Express API server, also written in TypeScript. Node.js cannot run TypeScript directly either. **esbuild** compiles and bundles the entire backend — all routes, database calls, ERP client, Python bridge — into a single JavaScript file.

### 3. The Desktop Wrapper (Electron)
The `electron/` folder is plain JavaScript (no compilation needed). But Electron needs the already-compiled frontend and backend bundles to package them into an installable app. **electron-builder** takes the output from steps 1 and 2 and wraps them into a platform-specific installer.

---

## Output Directories

```
optimusInvoice/
├── dist/                     ← Web app build output
│   ├── public/               ← Compiled React frontend (HTML + JS + CSS)
│   └── index.js              ← Compiled Node.js backend
│
├── dist-client/              ← Electron frontend build output
│   ├── index.html
│   └── assets/
│       ├── index-[hash].js   ← Bundled React app
│       └── index-[hash].css  ← Bundled Tailwind CSS
│
├── dist-server/              ← Electron backend build output
│   └── index.js              ← Bundled Node.js server
│
└── dist-electron/            ← Final packaged desktop app
    ├── Optimus Invoice Automation Setup.exe   ← Windows installer
    ├── Optimus Invoice Automation.exe         ← Windows portable
    ├── Optimus Invoice Automation.dmg         ← macOS
    └── Optimus Invoice Automation.AppImage    ← Linux
```

---

## Why Two Separate Builds for Frontend?

The frontend is compiled **twice** — once for the web app (`dist/public/`) and once for Electron (`dist-client/`) — because they have a critical difference:

**Web app** uses **absolute paths**:
```html
<script src="/assets/index.js"></script>
```
This works when a server is running and serving files, because `/assets/` resolves to the server root.

**Electron** uses **relative paths**:
```html
<script src="./assets/index.js"></script>
```
This is required because in an Electron app there is no server — the HTML file is loaded directly from the filesystem (`file:///C:/Program Files/Optimus/dist-client/index.html`). Absolute paths would fail because there is no web root to resolve them against.

This is controlled by the `base: './'` setting in `vite.electron.config.ts`.

---

## Build Commands & What They Trigger

### Web App Build

```bash
pnpm build
```

This runs two tools in sequence:

```
pnpm build
    │
    ├─ vite build                              (uses vite.config.ts)
    │       Compiles: client/src/**/*.tsx
    │       Output:   dist/public/
    │
    └─ esbuild server/_core/index.ts           (inline in package.json)
            Compiles: server/**/*.ts
            Output:   dist/index.js
```

Then to run it:
```bash
pnpm start
# Node.js reads dist/index.js
# Express serves dist/public/ as static files
# App is available at http://localhost:3000
```

---

### Electron Desktop Build

The Electron build is a three-stage pipeline:

```bash
pnpm electron:build
```

Which runs these three steps in sequence:

#### Stage 1 — Build the frontend for Electron
```bash
pnpm electron:build:client
# Tool:   vite (using vite.electron.config.ts)
# Input:  client/src/
# Output: dist-client/
# Key difference from web build: base: './' (relative paths)
```

#### Stage 2 — Build the backend for Electron
```bash
pnpm electron:build:server
# Tool:   build-server.js (custom esbuild script)
# Input:  server/_core/index.ts
# Output: dist-server/index.js
# Bundles everything except: mysql2, drizzle-orm, @aws-sdk (kept as node_modules)
```

#### Stage 3 — Package into installer
```bash
electron-builder
# Input:  dist-client/ + dist-server/ + electron/ + node_modules/
# Output: dist-electron/
# Produces platform-specific installer based on OS
```

Or build for a specific platform:
```bash
pnpm electron:build:win    # → dist-electron/*.exe
pnpm electron:build:mac    # → dist-electron/*.dmg
pnpm electron:build:linux  # → dist-electron/*.AppImage
```

---

## What Electron Actually Does at Runtime

When a user installs and opens the `.exe`, here is what happens step by step:

```
User double-clicks Optimus.exe
        │
        ▼
Electron main process starts  (electron/main.js)
        │
        ├─ Loads .env from %APPDATA%/optimus-invoice-automation/.env
        │
        ├─ Spawns Node.js as a background child process
        │       node dist-server/index.js  (port 3001)
        │       Starts Express, connects to MySQL, registers all routes
        │
        ├─ Waits for backend to respond (up to 4 seconds)
        │
        ├─ Opens a BrowserWindow (1400×900)
        │       Dev mode:  loads http://localhost:3000  (Vite dev server)
        │       Prod mode: loads dist-client/index.html (local file)
        │
        └─ User sees the React app — no browser, no terminal needed
```

The user never knows Node.js is running. To them it looks and behaves exactly like a native desktop application.

---

## Development vs Production Mode

Electron behaves differently in each mode, controlled by the `isDev` flag:

```javascript
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
```

| | Development (`pnpm electron:dev`) | Production (installed `.exe`) |
|---|---|---|
| Frontend source | Vite dev server at `http://localhost:3000` | Local file `dist-client/index.html` |
| Backend source | `tsx` runs `server/_core/index.ts` directly | `node` runs `dist-server/index.js` |
| DevTools | Opens automatically | Hidden |
| Config file | `.env` in project root | `.env` in `%APPDATA%/optimus-invoice-automation/` |
| Port | 3000 | 3001 |
| Hot reload | ✅ Yes (Vite HMR) | ❌ No |

---

## The `build-server.js` Script in Detail

The backend bundle for Electron is handled by a custom esbuild script rather than a simple CLI command, because of a specific requirement: some Node.js packages that use native binaries (`.node` files) **cannot be bundled** — they must remain as `node_modules` and be loaded at runtime.

```javascript
// build-server.js
esbuild.build({
  entryPoints: ['server/_core/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist-server/index.js',

  // These stay as external require() calls — NOT bundled:
  external: [
    'mysql2',        // Uses native C++ bindings
    'drizzle-orm',   // Expects to be in node_modules
    '@aws-sdk/*',    // Large AWS SDK — faster to keep external
    'better-sqlite3',// Native binary
    'esbuild',       // Build tool, not runtime dep
    'vite',          // Build tool, not runtime dep
  ],

  loader: {
    '.node': 'file', // Copy .node binary files alongside the bundle
  }
})
```

Everything else — all 1600 lines of `routers.ts`, `invoiceDb.ts`, `softoneClient.ts`, `vlmOrchestrator.ts`, etc. — gets merged into the single `dist-server/index.js` file.

---

## The `.gitignore` and Pre-committed Builds

Normally `dist/` folders are gitignored and never committed. This project is slightly unusual in that `dist-client/` and `dist-server/` **are committed** to the repository. This means:

- You can run the Electron desktop app in production mode immediately after cloning, without running a build step
- The pre-built files in the repo match the source code at the time of the last commit
- If you modify any source code, you need to rebuild (`pnpm electron:build:client` and/or `pnpm electron:build:server`) before the changes are reflected in the desktop app

The `dist/` folder (web build output) and `dist-electron/` (final installers) are **not** committed.

---

## Quick Reference

| Goal | Command | Output |
|---|---|---|
| Run in dev (web) | `pnpm dev` | None — runs in memory |
| Run in dev (desktop) | `pnpm electron:dev` | None — runs in memory |
| Build for web | `pnpm build` | `dist/` |
| Build frontend for Electron | `pnpm electron:build:client` | `dist-client/` |
| Build backend for Electron | `pnpm electron:build:server` | `dist-server/` |
| Package Windows installer | `pnpm electron:build:win` | `dist-electron/*.exe` |
| Package macOS app | `pnpm electron:build:mac` | `dist-electron/*.dmg` |
| Package Linux app | `pnpm electron:build:linux` | `dist-electron/*.AppImage` |
| Package all platforms | `pnpm electron:build` | `dist-electron/` |
| Type-check only | `pnpm check` | None |

---

*Optimus Invoice v2.0 — Build System Documentation | March 2026*
