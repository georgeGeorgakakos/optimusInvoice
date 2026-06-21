# 🧾 Optimus Invoice — Complete Technical Documentation

> **Intelligent invoice processing platform** with ML-powered extraction, automatic rule learning, multi-engine OCR/VLM support, and ERP integration (SoftOne Capital).

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Tech Stack](#3-tech-stack)
4. [Project Structure](#4-project-structure)
5. [File-by-File Documentation](#5-file-by-file-documentation)
   - 5.1 [Root Configuration Files](#51-root-configuration-files)
   - 5.2 [Frontend — `client/src`](#52-frontend--clientsrc)
   - 5.3 [Backend — `server/`](#53-backend--server)
   - 5.4 [Python ML Engine — `server/python/`](#54-python-ml-engine--serverpython)
   - 5.5 [VLM Microservice — `vlm-service/`](#55-vlm-microservice--vlm-service)
   - 5.6 [Database — `drizzle/`](#56-database--drizzle)
   - 5.7 [Electron Desktop App — `electron/`](#57-electron-desktop-app--electron)
   - 5.8 [Deployment & Utilities](#58-deployment--utilities)
6. [Database Schema](#6-database-schema)
7. [API Reference (tRPC Routers)](#7-api-reference-trpc-routers)
8. [OCR & Extraction Pipeline](#8-ocr--extraction-pipeline)
9. [ML Product Matching & Rule Learning](#9-ml-product-matching--rule-learning)
10. [ERP Integration (SoftOne)](#10-erp-integration-softone)
11. [OptimusDB Integration](#11-optimusdb-integration)
12. [Installation & Setup](#12-installation--setup)
13. [Environment Variables](#13-environment-variables)
14. [Running the Application](#14-running-the-application)
15. [Building the Desktop App](#15-building-the-desktop-app)
16. [VLM Service (Docker)](#16-vlm-service-docker)
17. [Known Issues & Roadmap](#17-known-issues--roadmap)

---

## 1. System Overview

**Optimus Invoice** is a full-stack invoice automation platform designed to eliminate manual data entry when processing supplier invoices into an ERP system.

**Core workflow:**

1. User uploads a supplier PDF invoice (Greek myDATA/ΑΑΔΕ format or international).
2. The system classifies the document type (invoice, credit note, CMR, dispatch note).
3. A multi-strategy extraction pipeline (pdfplumber → Tesseract OCR → VLM) extracts structured data.
4. ML product matching maps supplier product codes to ERP codes using 4 algorithms with confidence scoring.
5. A rule learning engine observes manual corrections and auto-learns transformation patterns after 3 examples.
6. Approved invoices are posted directly to SoftOne Capital ERP.
7. All processed invoice metadata is optionally synced to OptimusDB for distributed catalog management.

After processing **3–5 invoices per supplier**, the system achieves **90%+ automation** on product matching with no manual intervention.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (React 19 + TypeScript)             │
│  Home │ Dashboard │ Upload │ Invoices │ Detail │ Approvals       │
│  Rules │ Knowledge Base │ Configuration │ ERP Model              │
└──────────────────────────┬──────────────────────────────────────┘
                           │  tRPC (type-safe RPC over HTTP)
┌──────────────────────────▼──────────────────────────────────────┐
│                   Backend (Node.js 22 + Express 4)               │
│  routers.ts   invoiceDb.ts   softoneClient.ts   storage.ts       │
│  pythonBridge.ts   python-integration.ts   vlmOrchestrator.ts    │
└────────┬────────────────────────────────┬───────────────────────┘
         │ child_process (spawn)          │ HTTP / REST
┌────────▼──────────────────┐  ┌─────────▼──────────────────────┐
│   Python ML Engine        │  │   SoftOne Capital ERP           │
│  document_classifier.py   │  │   (SOAP/REST API)               │
│  invoice_extractor_       │  │   Login → Products → Suppliers  │
│    advanced.py            │  │   → Create Invoice              │
│  dispatch_extractor.py    │  └────────────────────────────────┘
│  credit_note_extractor.py │
│  cmr_extractor.py         │  ┌────────────────────────────────┐
│  ml_product_matcher_v2.py │  │   OptimusDB (Distributed       │
│  rule_learning_engine.py  │  │   Data Catalog REST API)        │
│  ocr_helper.py            │  └────────────────────────────────┘
│  vlm_extractor.py         │
│  vlm_invoice_parser.py    │  ┌────────────────────────────────┐
│  softone_api_client.py    │  │   VLM Microservice (Docker)    │
└───────────────────────────┘  │   Port 8300 — FastAPI          │
                               │   Surya │ GOT-OCR2 │ olmOCR    │
┌──────────────────────────┐   │   Marker │ Qwen2.5-VL          │
│    MySQL Database        │   └────────────────────────────────┘
│    (Drizzle ORM)         │
│  users, invoices,        │
│  invoiceLineItems,       │
│  suppliers, products,    │
│  productMappings,        │
│  transformationRules,    │
│  configuration,          │
│  notifications,          │
│  approvals               │
└──────────────────────────┘
```

---

## 3. Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend Framework | React | 19 |
| Language | TypeScript | 5.9 |
| CSS | Tailwind CSS | 4 |
| Component Library | shadcn/ui + Radix UI | latest |
| API Layer | tRPC | 11 |
| State Management | TanStack Query | 5 |
| Routing | Wouter | 3.7 |
| Build Tool | Vite | 7 |
| Backend Runtime | Node.js | 22 |
| Backend Framework | Express | 4 |
| ORM | Drizzle ORM | 0.44 |
| Database | MySQL | 8.0+ |
| Desktop Shell | Electron | 39 |
| ML Engine | Python | 3.11 |
| PDF Extraction | pdfplumber | latest |
| Node OCR | tesseract.js (WASM) | 5 |
| Node PDF Render | mupdf (WASM) + pdfjs-dist | latest |
| VLM Service | FastAPI + PyTorch | latest |
| Containerization | Docker | latest |
| Package Manager | pnpm | 10.4 |

---

## 4. Project Structure

```
optimusInvoice/
├── client/                        # React frontend
│   ├── index.html                 # HTML shell
│   ├── public/                    # Static assets (logos)
│   └── src/
│       ├── App.tsx                # Root component + router
│       ├── main.tsx               # React entry point
│       ├── index.css              # Tailwind base styles
│       ├── const.ts               # Shared frontend constants
│       ├── components/            # Shared UI components
│       │   ├── AIChatBox.tsx
│       │   ├── DashboardLayout.tsx
│       │   ├── DashboardLayoutSkeleton.tsx
│       │   ├── ErrorBoundary.tsx
│       │   ├── ManusDialog.tsx
│       │   ├── Map.tsx
│       │   └── ui/                # shadcn/ui component library (40+ components)
│       ├── contexts/
│       │   └── ThemeContext.tsx
│       ├── hooks/
│       │   ├── useComposition.ts
│       │   ├── useMobile.tsx
│       │   └── usePersistFn.ts
│       ├── lib/
│       │   ├── trpc.ts            # tRPC client setup
│       │   └── utils.ts           # Tailwind class merge utility
│       ├── pages/                 # Route-level page components
│       │   ├── Home.tsx
│       │   ├── Dashboard.tsx
│       │   ├── InvoiceUpload.tsx
│       │   ├── InvoiceList.tsx
│       │   ├── InvoiceDetail.tsx
│       │   ├── Approvals.tsx
│       │   ├── RuleLearning.tsx
│       │   ├── KnowledgeBase.tsx
│       │   ├── Configuration.tsx
│       │   ├── ErpDataModel.tsx
│       │   ├── ComponentShowcase.tsx
│       │   └── NotFound.tsx
│       └── _core/
│           └── hooks/
│               └── useAuth.ts
├── server/                        # Node.js backend
│   ├── routers.ts                 # All tRPC routes (1600+ lines)
│   ├── invoiceDb.ts               # All database operations
│   ├── db.ts                      # Drizzle DB connection
│   ├── ocr.ts                     # Node-native OCR pipeline
│   ├── pythonBridge.ts            # Python child process interface (legacy)
│   ├── python-integration.ts      # Full Python ML integration module
│   ├── softoneClient.ts           # SoftOne ERP API client
│   ├── optimusDbClient.ts         # OptimusDB REST client
│   ├── storage.ts                 # File storage (local / cloud)
│   ├── vlmOrchestrator.ts         # VLM service orchestration
│   ├── python/                    # Python ML scripts
│   │   ├── invoice_extractor_advanced.py
│   │   ├── dispatch_extractor.py
│   │   ├── credit_note_extractor.py
│   │   ├── cmr_extractor.py
│   │   ├── document_classifier.py
│   │   ├── ml_product_matcher_v2.py
│   │   ├── rule_learning_engine.py
│   │   ├── ocr_helper.py
│   │   ├── vlm_extractor.py
│   │   ├── vlm_invoice_parser.py
│   │   ├── vlm_service.py
│   │   └── softone_api_client.py
│   └── _core/                     # Framework core (auth, context, env)
│       ├── index.ts               # Express server entry point
│       ├── trpc.ts                # tRPC setup
│       ├── context.ts             # Request context
│       ├── env.ts                 # Environment variables
│       ├── cookies.ts             # Session cookie helpers
│       ├── oauth.ts               # OAuth callback handler
│       ├── llm.ts                 # LLM utility wrapper
│       ├── sdk.ts                 # Manus SDK integration
│       ├── systemRouter.ts        # Health / system routes
│       ├── vite.ts                # Vite dev server integration
│       ├── dataApi.ts             # Data API proxy
│       ├── map.ts                 # Map / geo utilities
│       ├── imageGeneration.ts     # Image generation helper
│       ├── notification.ts        # Push notification helper
│       └── voiceTranscription.ts  # Voice/audio transcription
├── shared/                        # Code shared by client + server
│   ├── const.ts                   # Cookie name, error messages
│   ├── types.ts                   # Shared TypeScript types
│   └── _core/
│       └── errors.ts              # Standard error codes
├── drizzle/                       # Database schema + migrations
│   ├── schema.ts                  # Full Drizzle ORM schema
│   ├── relations.ts               # Table relations
│   ├── 0000_strange_famine.sql    # Migration: users table
│   ├── 0001_safe_lightspeed.sql   # Migration: invoices, products, suppliers
│   ├── 0002_yellow_the_spike.sql  # Migration: configuration
│   ├── 0003_colossal_logan.sql    # Migration: notifications
│   ├── 0004_violet_thunderbolts.sql # Migration: approvals
│   ├── 0005_melted_proudstar.sql  # Migration: documentType + erpType
│   └── meta/                      # Drizzle migration snapshots
├── vlm-service/                   # Dockerized VLM microservice
│   ├── app.py                     # FastAPI app (same as vlm_service.py)
│   ├── vlm_invoice_parser.py      # Invoice field parser for VLM output
│   ├── Dockerfile                 # Docker image definition
│   ├── docker-compose.vlm.yml     # Docker Compose for VLM service
│   ├── requirements.txt           # Python deps (FastAPI, surya, etc.)
│   ├── test_vlm.py                # VLM service test script
│   └── CommandHowTo.txt           # Docker build/run commands reference
├── vLMBenchmark/                  # VLM accuracy benchmarking
│   ├── benchmark.py               # Full benchmark runner
│   ├── quick_test.py              # Fast single-engine test
│   ├── ground_truth.json          # Ground truth extraction data
│   ├── setup.bat / setup.sh       # Benchmark environment setup
│   └── README.md                  # Benchmark documentation
├── electron/                      # Electron desktop wrapper
│   ├── main.js                    # Main process (window, backend spawn)
│   ├── preload.js                 # Preload script (contextBridge)
│   └── assets/
│       └── icon.png               # App icon
├── data/                          # Local data storage
│   ├── invoices/                  # Sample invoice PDFs
│   └── uploads/                   # Uploaded invoice storage (dev)
├── dist-client/                   # Built frontend assets
├── dist-server/                   # Built backend bundle
├── model_cache/                   # GOT-OCR2 model weights cache
├── package.json                   # Node.js project manifest
├── pnpm-lock.yaml                 # Locked dependency tree
├── vite.config.ts                 # Vite (web) build config
├── vite.electron.config.ts        # Vite (Electron) build config
├── drizzle.config.ts              # Drizzle Kit config
├── tsconfig.json                  # TypeScript config
├── vitest.config.ts               # Vitest test config
├── build-server.js                # esbuild server bundle script
├── components.json                # shadcn/ui component config
├── .prettierrc                    # Prettier formatting config
├── OptimusInvoice.ps1             # Main PowerShell launcher
├── deploySolutionLocal.ps1        # Local deployment setup script
├── diagnose_vlm.ps1               # VLM diagnostics script
├── docker-compose.vlm.yml         # Top-level Docker Compose
├── Dockerfile.vlm                 # VLM Docker image (top-level)
├── eng.traineddata                # Tesseract English language data
├── ell.traineddata                # Tesseract Greek language data
└── README.md                      # Original project readme
```

---

## 5. File-by-File Documentation

### 5.1 Root Configuration Files

#### `package.json`
Node.js project manifest. Defines the application name (`optimus-invoice-automation`), version, and all npm scripts:
- `dev` — starts dev server with hot reload via `tsx watch`
- `build` — builds frontend (Vite) and backend (esbuild) for production
- `start` — runs the production build
- `db:push` — runs Drizzle schema migrations
- `electron:build` — builds the full Electron desktop app
- `test` — runs Vitest unit tests
Also contains Electron Builder configuration for Windows (NSIS installer + portable), macOS (DMG), and Linux (AppImage) targets.

#### `vite.config.ts`
Vite build configuration for the React web frontend. Configures path aliases (`@` → `client/src`, `@shared` → `shared`), Tailwind CSS plugin, React plugin, and JSX location plugin (for Manus runtime). The dev server proxies API calls to Node.js.

#### `vite.electron.config.ts`
Separate Vite config used when building the frontend for embedding inside the Electron app. Outputs to `dist-client/` instead of the standard `dist/` path.

#### `drizzle.config.ts`
Drizzle Kit configuration. Points to `drizzle/schema.ts` as the source of truth and reads `DATABASE_URL` from the environment to connect to MySQL and run migrations.

#### `tsconfig.json`
TypeScript project configuration. Enables strict mode, ES2022 target, and module resolution for the monorepo layout with path aliases for `@`, `@shared`, and `@assets`.

#### `vitest.config.ts`
Test framework configuration. Sets up Vitest for unit testing server-side TypeScript files.

#### `build-server.js`
Custom esbuild script that bundles the Node.js backend into a single `dist-server/index.js` file for Electron packaging. Handles bundling of the Tailwind CSS oxide native binaries for multiple Linux targets.

#### `components.json`
shadcn/ui CLI configuration. Defines component aliases, style settings (New York style), Tailwind config path, and the `@/components/ui` import alias for the shadcn component library.

#### `OptimusInvoice.ps1`
Main Windows PowerShell launcher for the application. Handles environment validation, starts the Node.js server, and opens the browser for web mode usage.

#### `deploySolutionLocal.ps1`
PowerShell deployment script for local development setup. Installs dependencies, runs database migrations, copies configuration files, and ensures all prerequisites are met.

#### `diagnose_vlm.ps1`
PowerShell diagnostics script for troubleshooting the VLM service. Tests Docker availability, checks if the VLM container is running, tests the health endpoint, and runs a sample invoice through the OCR pipeline.

#### `docker-compose.vlm.yml` / `Dockerfile.vlm`
Top-level Docker Compose and Dockerfile for the VLM microservice. Configures the container with CUDA GPU support, memory limits, volume mounts for model caching, and exposes port 8300.

#### `eng.traineddata` / `ell.traineddata`
Pre-trained Tesseract OCR language data files for English and Greek respectively. Used by the `ocr.ts` module's fallback OCR pipeline for scanned PDF processing.

---

### 5.2 Frontend — `client/src`

#### `main.tsx`
React application entry point. Mounts the root `App` component into the DOM. Initializes the tRPC client and TanStack Query provider.

#### `App.tsx`
Root application component. Defines the client-side routing table using Wouter:

| Route | Component |
|---|---|
| `/` | `Home` |
| `/dashboard` | `Dashboard` |
| `/invoices` | `InvoiceList` |
| `/invoices/upload` | `InvoiceUpload` |
| `/invoices/:id` | `InvoiceDetail` |
| `/rules` | `RuleLearning` |
| `/knowledge-base` | `KnowledgeBase` |
| `/configuration` | `Configuration` |
| `/approvals` | `Approvals` |
| `/erp-model` | `ErpDataModel` |

Wraps the app in `ThemeProvider` (light default), `TooltipProvider`, `ErrorBoundary`, and `Toaster`.

#### `index.css`
Global stylesheet. Defines Tailwind CSS base directives and custom CSS variables for the design system (color tokens for light/dark themes, border radius, shadow definitions).

#### `const.ts`
Frontend constants: `AXIOS_TIMEOUT_MS` (30,000ms), `UNAUTHED_ERR_MSG`, `NOT_ADMIN_ERR_MSG`.

#### `lib/trpc.ts`
tRPC client initialisation. Creates the tRPC client with `httpBatchLink` pointing to `/api/trpc`. Exports the `trpc` object used throughout the frontend for type-safe API calls.

#### `lib/utils.ts`
Utility function `cn()` — combines `clsx` and `tailwind-merge` for conditional class name composition. Used in every UI component.

#### `contexts/ThemeContext.tsx`
React context for light/dark theme management. Provides `useTheme` hook and `ThemeProvider` wrapper. Persists theme preference to `localStorage` and applies the class to the document root.

#### `hooks/useComposition.ts`
Custom React hook for managing IME (Input Method Editor) composition state — prevents premature form submissions when typing in CJK or Greek input methods.

#### `hooks/useMobile.tsx`
Hook that returns a boolean indicating whether the viewport is below the mobile breakpoint (768px). Subscribes to window resize events.

#### `hooks/usePersistFn.ts`
Hook that returns a stable function reference whose implementation can change over time — useful for callbacks in `useEffect` dependencies without causing infinite loops.

#### `_core/hooks/useAuth.ts`
Authentication hook. Calls `trpc.auth.me.useQuery()` to get the current user session. Returns `{ user, isLoading, isAuthenticated }`.

#### `components/AIChatBox.tsx`
AI-powered chat overlay component. Provides a floating chat interface allowing users to ask questions about invoices or the system. Calls the backend LLM integration. Supports streaming responses rendered as Markdown.

#### `components/DashboardLayout.tsx`
Master layout component used by all authenticated pages. Renders the sidebar navigation (with invoice counts, approval badges, notification bell), top header bar, breadcrumbs, and wraps page content. Handles responsive collapse on mobile. Contains the navigation item definitions for all routes.

#### `components/DashboardLayoutSkeleton.tsx`
Loading skeleton variant of `DashboardLayout`. Displayed while the user session is loading to prevent layout flash.

#### `components/ErrorBoundary.tsx`
React class component error boundary. Catches render-time JavaScript errors anywhere in the component tree and displays a user-friendly error screen with a reload option.

#### `components/ManusDialog.tsx`
Dialog component for Manus platform integrations. Renders a modal with platform-specific content (e.g., OAuth flows, settings panels) injected via the Manus runtime.

#### `components/Map.tsx`
Google Maps integration component. Renders an embedded map (used in supplier/customer location display). Wraps the Google Maps JavaScript API with type-safe React bindings.

#### `pages/Home.tsx`
Landing / onboarding page (38KB). Displayed to unauthenticated users or as the marketing entry point. Contains the OAuth login button, product feature overview, and animated hero section.

#### `pages/Dashboard.tsx`
Main analytics dashboard. Displays:
- KPI cards: total invoices, automation rate, pending approvals, processing errors
- Line chart of invoice processing volume over time
- Donut chart of match status distribution
- Recent invoice activity table
- Quick action buttons (upload, view approvals)

Calls `trpc.invoices.statistics`, `trpc.invoices.analytics`, and `trpc.approvals.pendingCount`.

#### `pages/InvoiceUpload.tsx`
PDF invoice upload page. Features:
- Drag-and-drop zone for PDF files
- Base64 encoding of files for tRPC upload
- Progress indicator during processing
- Document type auto-detection display
- Redirect to InvoiceDetail on completion

Calls `trpc.invoices.upload` mutation.

#### `pages/InvoiceList.tsx`
Invoice management list. Features:
- Searchable, filterable table of all invoices
- Status badges (pending, processing, completed, failed, review_needed)
- Document type icons (invoice, credit note, CMR, dispatch note)
- Pagination
- Bulk status filters

Calls `trpc.invoices.list`.

#### `pages/InvoiceDetail.tsx`
The largest and most complex page (84KB). Full invoice review and approval workflow:
- PDF viewer (inline preview)
- Extracted header data (supplier, date, totals)
- Line item table with match status per row
- ERP code lookup and manual override for each line item
- Confidence score display and color coding
- Submit to ERP button
- Approval request/decision panel
- OptimusDB push status indicator
- Extraction debug info panel

Calls: `trpc.invoices.getById`, `trpc.invoices.updateLineItem`, `trpc.invoices.submitToErp`, `trpc.approvals.*`, `trpc.softone.getProducts`, `trpc.optimusDb.push`.

#### `pages/Approvals.tsx`
Approval workflow management page. Lists all invoices awaiting approval with:
- Pending approval queue with invoice summary
- Approve / Reject buttons with optional comment
- Approval history log
- Per-user approval statistics

Calls `trpc.approvals.*`.

#### `pages/RuleLearning.tsx`
Rule learning engine dashboard. Displays:
- List of learned transformation rules per supplier
- Rule type (prefix_addition, suffix_removal, etc.)
- Confidence scores and usage statistics
- Example transformations
- Ability to enable/disable or delete rules

Calls `trpc.rules.*`.

#### `pages/KnowledgeBase.tsx`
Product mapping knowledge base viewer. Displays:
- All confirmed supplier code → ERP code mappings
- Supplier filter
- Mapping confidence and usage count
- Add/edit/delete mapping controls
- Learned rule associations

Calls `trpc.knowledgeBase.*`.

#### `pages/Configuration.tsx`
System configuration panel (large, 45KB). Sections:
- **ERP Connection**: SoftOne API URL, credentials, company/branch/fiscal year, test connection button
- **Extraction Settings**: OCR engine selection, VLM service URL, confidence threshold
- **ML Settings**: Matching algorithm weights, minimum confidence
- **Notifications**: Email/webhook alert settings
- **OptimusDB**: API URL, auth token, catalog name, enable/disable toggle

Calls `trpc.configuration.*` and `trpc.softone.testConnection`.

#### `pages/ErpDataModel.tsx`
ERP data model explorer (40KB). Displays:
- ERP product catalog with search
- Supplier registry
- Auto-mapping tool (attempts to auto-map unmapped ERP products)
- Category browser
- Product-to-mapping relationship view
- Export to CSV functionality

Calls `trpc.erpModel.*`.

#### `pages/ComponentShowcase.tsx`
Developer-only component showcase page (59KB). Renders all shadcn/ui components for visual testing and design review. Not linked in production navigation.

#### `pages/NotFound.tsx`
404 page. Displayed for unknown routes. Includes a link back to the dashboard.

---

### 5.3 Backend — `server/`

#### `_core/index.ts`
Express application entry point. Responsibilities:
- Creates Express app and HTTP server
- Configures body parser with 50MB limit for PDF uploads
- Registers OAuth routes under `/api/oauth/`
- Mounts the tRPC router at `/api/trpc`
- Serves locally uploaded files from `data/uploads/`
- In development: sets up Vite dev server middleware
- In production: serves static built frontend
- Finds an available port starting from 3000 (tries up to 3019)

#### `_core/trpc.ts`
tRPC server setup. Defines:
- `publicProcedure` — accessible without authentication
- `protectedProcedure` — requires a valid session cookie; throws `UNAUTHORIZED` if not present
- The tRPC router factory

#### `_core/context.ts`
Creates the per-request tRPC context. Extracts the session cookie, verifies the JWT, and attaches `user` (or `null`) to the context. Also attaches `req` and `res` for cookie manipulation.

#### `_core/env.ts`
Environment variable loader. Exports a typed `ENV` object with:
- `appId`, `cookieSecret`, `databaseUrl`
- `oAuthServerUrl`, `ownerOpenId`
- `isProduction`
- `forgeApiUrl`, `forgeApiKey` (cloud file storage)

#### `_core/cookies.ts`
Cookie helper utilities. `getSessionCookieOptions()` returns `httpOnly`, `secure`, `sameSite`, and `maxAge` options appropriate for the current environment (dev vs. production).

#### `_core/oauth.ts`
OAuth callback handler. Registers `/api/oauth/callback` route. On successful OAuth, upserts the user in the database and sets the session JWT cookie.

#### `_core/llm.ts`
LLM integration wrapper. Provides a `chat()` function that calls a configured LLM (via the Manus SDK or direct API) for the AI chat box feature. Handles streaming responses.

#### `_core/sdk.ts`
Manus platform SDK integration. Provides helper functions for Manus-specific features (file forge, notifications, data API) used in the platform-hosted version of the app.

#### `_core/systemRouter.ts`
System-level tRPC routes. Exposes `system.healthCheck` (returns `{ ok: true, timestamp }`) used by monitoring and the Electron app to verify the backend is running.

#### `_core/vite.ts`
Vite development server middleware integration. In development mode, this module creates a Vite dev server and attaches it to the Express app so the React frontend is served with HMR.

#### `_core/dataApi.ts`
Proxy routes for the Manus data API. Forwards requests to the Manus platform's data storage service for platform-hosted deployments.

#### `_core/map.ts`
Google Maps / geo utilities. Provides geocoding and reverse-geocoding helpers used by the `Map.tsx` component.

#### `_core/imageGeneration.ts`
Image generation helper. Wraps an image generation API call for potential use in document processing or UI features.

#### `_core/notification.ts`
Push notification helper. Sends browser push notifications or webhook calls for invoice processing events (completion, errors, approval requests).

#### `_core/voiceTranscription.ts`
Voice transcription helper. Wraps a speech-to-text API for potential use in the AI chat interface.

---

#### `db.ts`
Database connection module. Lazily initialises a Drizzle ORM instance connected to MySQL via `DATABASE_URL`. Exports:
- `getDb()` — returns the Drizzle instance (or `null` if no database is configured, allowing the app to run in demo mode)
- `upsertUser()` — creates or updates a user record on OAuth login

#### `routers.ts`
The main tRPC router (1600+ lines). Defines all API endpoints grouped into sub-routers:

| Router | Endpoints |
|---|---|
| `auth` | `me`, `logout` |
| `invoices` | `list`, `getById`, `upload`, `processInvoice`, `updateLineItem`, `submitToErp`, `statistics`, `analytics`, `exportHistory`, `getFileUrl` |
| `products` | `search`, `getByCode`, `syncFromErp`, `import` |
| `configuration` | `get`, `getSettings`, `updateSoftone`, `updateSettings`, `testConnection` |
| `rules` | `list`, `getBySupplier`, `statistics` |
| `knowledgeBase` | `mappings`, `addMapping`, `deleteMapping`, `rules`, `addRule`, `deleteRule`, `suppliers`, `stats`, `exportMappings` |
| `softone` | `testConnection`, `getProducts`, `getProductByCode`, `getSuppliers`, `getSupplierByCode`, `createInvoice` |
| `erpModel` | `products`, `getProduct`, `categories`, `stats`, `mappingCounts`, `unmapped`, `mapProduct`, `updateMapping`, `importProducts`, `autoMap`, `getProductMappings`, `addMapping`, `updateProductMapping`, `exportProducts`, `suppliers` |
| `notifications` | `list`, `unreadCount`, `markRead`, `markAllRead` |
| `approvals` | `pending`, `getByInvoice`, `approve`, `reject`, `history`, `pendingCount`, `requestApproval` |
| `optimusDb` | `testConnection`, `push` |

Also contains `tryPushToOptimusDb()` — a non-blocking helper called after invoice completion to auto-push metadata to OptimusDB.

#### `invoiceDb.ts`
Database access layer (37KB). All CRUD operations for every table. Key function groups:
- **Invoices**: `createInvoice`, `getInvoiceById`, `getInvoicesByUserId`, `updateInvoice`, `updateInvoiceStatus`, `deleteInvoice`
- **Line Items**: `createLineItem`, `getLineItemsByInvoiceId`, `updateLineItem`, `bulkCreateLineItems`
- **Suppliers**: `createSupplier`, `getSupplierById`, `getSupplierByCode`, `findOrCreateSupplier`
- **Products**: `createProduct`, `getProductByCode`, `searchProducts`, `upsertProducts`
- **Product Mappings**: `createMapping`, `getMappingBySupplierCode`, `getMappingsBySupplier`, `updateMappingUsage`, `getAllMappings`
- **Transformation Rules**: `createRule`, `getRulesBySupplier`, `updateRuleStats`, `getAllRules`
- **Configuration**: `getConfiguration`, `getUserConfiguration`, `upsertConfiguration`
- **Notifications**: `createNotification`, `getNotificationsByUserId`, `markNotificationRead`, `markAllNotificationsRead`
- **Approvals**: `createApproval`, `getApprovalsByInvoiceId`, `updateApproval`, `getPendingApprovals`
- **Analytics**: `getInvoiceStatistics`, `getInvoiceAnalytics`, `getExportHistory`

#### `ocr.ts`
Node.js-native PDF text extraction pipeline. Zero system dependencies — pure WASM:
1. **Step 1** — `pdfjs-dist`: fast text extraction for text-based PDFs. If extracted text > 50 characters, returns immediately.
2. **Step 2** — `mupdf` (WASM): renders each page to PNG images if pdfjs returns insufficient text.
3. **Step 3** — `tesseract.js` (WASM): OCR on rendered page images using Greek + English (`eng+ell`) language data.

Returns `OcrResult { text, method, pages, confidence }`.

#### `pythonBridge.ts`
Legacy Python child process bridge. Spawns Python scripts as child processes and communicates via stdin/stdout JSON. Provides type-safe TypeScript interfaces for `ExtractedInvoiceData` and `ProductMatch`. **Superseded by `python-integration.ts`** for most operations but retained for backward compatibility.

#### `python-integration.ts`
Full Python ML integration module (30KB). The primary Node.js → Python interface. Features:
- **Robust Python command detection**: Tries `py`, `python`, `python3` in platform-appropriate order
- **VLM multi-engine integration**: Passes OCR text from Surya/GOT-OCR2/olmOCR/Marker to Python extractors via `--ocr-text` argument
- **Document classification**: Calls `document_classifier.py` to determine document type before extraction
- **Type-specific extraction**: Routes to the correct extractor (`invoice_extractor_advanced.py`, `dispatch_extractor.py`, `credit_note_extractor.py`, `cmr_extractor.py`) based on classification result
- **Product matching**: Calls `ml_product_matcher_v2.py` with knowledge base JSON
- **Rule operations**: Applies and updates transformation rules via `rule_learning_engine.py`
- **Knowledge base management**: Reads/writes JSON knowledge base files

#### `softoneClient.ts`
SoftOne Capital ERP API client (TypeScript). Handles:
- Session-based authentication (30-minute timeout with auto-renewal)
- `login()` / `logout()` with credential management
- `getProducts()` — full product catalog retrieval
- `getProductByCode()` — single product lookup
- `getSuppliers()` — supplier list retrieval
- `getSupplierByCode()` — single supplier lookup
- `setData()` — generic ERP data write (used for invoice creation)
- `createInvoice()` — posts a complete invoice with line items to SoftOne

Uses `axios` with HTTPS agent (self-signed cert support for on-premise SoftOne).

#### `optimusDbClient.ts`
REST API client for OptimusDB — the distributed data catalog component from George's PhD research. Responsible for:
- `createOptimusDbClient()` — factory with API URL, auth token, catalog name, and node ID
- `buildInvoiceMetadata()` — transforms a completed invoice + line items into an OptimusDB catalog entry schema
- `pushInvoice()` — POSTs the entry to OptimusDB's `/catalog/entries` endpoint
- `testConnection()` — tests reachability and auth

This client bridges the invoice automation domain with the OptimusDB/OptimusDDC research stack.

#### `storage.ts`
File storage abstraction layer. Supports two backends:
- **Local filesystem** (development): stores uploaded PDFs in `data/uploads/invoices/{invoiceId}/`
- **Cloud storage via Forge API** (production): uploads to a Manus-managed object store and returns a presigned URL
- `uploadPdf()` — saves a base64-encoded PDF to the configured storage backend
- `getPdfUrl()` — returns a temporary download URL for a stored invoice PDF
- `serveLocalFiles()` — registers an Express static route for local file serving

#### `vlmOrchestrator.ts`
VLM service orchestration layer (TypeScript). Manages communication with the Docker-hosted VLM microservice. Features:
- **Multi-engine support**: `surya` (fast, 10-30s), `got_ocr2` (accurate, 3-7 min), `olmocr` (structured JSON), `marker` (PDF → Markdown), `qwen_vl` (visual Q&A)
- **Auto mode**: Runs Surya first; escalates to olmOCR if confidence < 0.70
- **Encoder service** (port 8100): LayoutLMv3/LiLT for layout understanding
- **Detection service** (port 8101): YOLOv5/ResNet50 for document element detection
- `extractWithVlm()` — sends a PDF page to the VLM service and returns extracted text or structured JSON
- `getVlmHealth()` — checks if the VLM service is available and which models are loaded

---

### 5.4 Python ML Engine — `server/python/`

#### `document_classifier.py`
Document type classifier. Analyzes extracted PDF text using keyword scoring to determine document type: `invoice`, `credit_note`, `cmr`, or `dispatch_note`.

Special handling for Greek combined documents:
- `Τιμολόγιο Πώλησης - Δελτίο Αποστολής` → classified as **invoice** (not dispatch_note)
- Uses regex patterns for Greek Unicode text with OCR-variant tolerance
- Scoring system: each document type accumulates points from keyword matches; highest score wins
- Returns `{ document_type, confidence, scores, reasoning }`

#### `invoice_extractor_advanced.py`
Main invoice data extractor (49KB). Supports Greek myDATA/ΑΑΔΕ format and international invoices. Extraction strategy:
1. `pdfplumber` for text-based PDFs (Greek text + table structure preservation)
2. OCR text fallback via `ocr_helper.py`
3. VLM text via `--ocr-text` argument

Extracted fields:
- **Header**: supplier name/tax ID/address, invoice number, date, currency, totals (net, VAT, gross)
- **Line items**: supplier code, description, quantity, unit, unit price, up to 3 discount levels, net amount, VAT rate/amount, total with VAT
- **Greek number parsing**: converts `1.234,56` format to `1234.56`
- **Table detection**: multiple heuristic strategies for identifying the products table
- **myDATA compliance**: handles MARK numbers, ΑΑΔΕ QR codes, ΑΦΜ extraction

Output: JSON to stdout for Node.js consumption.

#### `dispatch_extractor.py`
Dispatch note (`Δελτίο Αποστολής`) extractor. Handles both text-based and scanned/vector PDFs. OCR-specific challenges addressed:
- Header garbling (`ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ`) → position-based detection
- Column misalignment in PSM3 OCR → merge with PSM6 (table-optimized)
- `ΤΕΜΑΧ` appearing as `TEMAX`, `τεΜΑΧ` → case-insensitive matching
- OCR artifact removal (`|`, random pipes)

Extracts: sender, recipient, delivery address, line items, vehicle registration, driver info.

#### `credit_note_extractor.py`
Credit note (`Πιστωτικό Τιμολόγιο`) extractor. Wraps `invoice_extractor_advanced.py` and adds credit-note-specific fields:
- Original invoice reference number
- Reason for credit
- Negative amount handling
- Returns extended invoice structure with `document_type: "credit_note"` and `original_invoice_ref`

#### `cmr_extractor.py`
CMR (Convention on the Contract for the International Carriage of Goods by Road) document extractor. Extracts:
- Sender (box 1), recipient (box 3), carrier (box 16)
- Place of taking over (box 4), place of delivery (box 3)
- Goods description (box 6), weight, volume (boxes 11-12)
- CMR number, date, sequential number
- Insurance details (box 8)

#### `ml_product_matcher_v2.py`
Enhanced ML product matcher with integrated rule learning. Implements 4 matching algorithms in priority order:
1. **Direct exact match**: Looks up supplier code directly in the knowledge base
2. **Rule-based transformation**: Applies learned transformation rules (prefix/suffix manipulation, regex)
3. **Fuzzy string matching**: Uses `difflib.SequenceMatcher` for similarity-based matching
4. **Description-based matching**: Compares product descriptions when codes are unavailable

Features:
- Confidence scoring (0-100) per match
- Knowledge base persistence (JSON file)
- Integration with `RuleLearningEngine` for automatic rule application
- `confirm_match()` — records a user confirmation to feed back into the rule learner
- `get_suggestions()` — returns top-N alternative matches for manual review

#### `rule_learning_engine.py`
Automatic transformation rule learning engine. Observes user corrections and detects recurring patterns. Rule types:
- `prefix_addition` / `prefix_removal`
- `suffix_addition` / `suffix_removal`
- `separator_removal` (hyphens, dots, spaces)
- `character_replacement`
- `regex_pattern` (complex transformations)

Learning process:
1. Each correction is recorded as a `(supplier_code, erp_code)` pair
2. After **3 confirmations** of the same pattern, a rule is auto-generated
3. Rules have confidence scores that increase with successful applications
4. `apply_rules()` — applies all applicable rules to a supplier code
5. Rules are persisted to `transformation_rules.json`

#### `ocr_helper.py`
PDF text extraction helper (Python side). Two strategies in priority order:
1. `pdfplumber` — always attempted first; preserves Greek characters and table structure
2. Pre-extracted OCR text — reads a `.ocr.txt` file created by the Node.js `ocr.ts` pipeline (fallback for scanned PDFs)

Returns `{ text, method, pages, tables }`. The `tables` key contains structured table data from pdfplumber for line item extraction.

#### `vlm_extractor.py`
VLM integration layer for the Python pipeline. Calls the sidecar VLM service at `VLM_SERVICE_URL` (default: `http://vlm-service:8100`). Functions:
- `is_vlm_available()` — health check
- `vlm_extract(pdf_path, doc_type, page)` — sends PDF to VLM for visual extraction
- `merge_extractions(ocr_result, vlm_result)` — intelligently merges OCR-based and VLM-based extraction results, preferring the higher-confidence fields from each source

#### `vlm_invoice_parser.py`
Invoice field parser for VLM text output. Handles multiple international invoice formats:
- Service invoices (Travel Services LTD — Bulgarian dual-currency)
- Adobe table format (product code + EA qty + price + tax columns)
- Fiverr format (Invoice FIXXXX title)
- Trengo format (European amounts)
- GitHub receipt (Transaction ID as number, USD)
- New Relic format (Invoice No:, USD, usage-based)
- Pharos GBP format (large qty rows)

Includes `MONTH_NAMES` regex and `SKIP_WORDS` set for robust parsing of free-form VLM output into structured invoice fields.

#### `vlm_service.py`
FastAPI VLM microservice (also used as `vlm-service/app.py`). Exposes REST endpoints for multi-engine OCR:
- `GET /health` — service status + loaded models
- `POST /extract` — extracts text from a PDF using the specified engine
- `POST /extract/batch` — processes multiple PDFs

Engine implementations:
- **Surya** (`surya-ocr`): Layout-aware OCR with line detection; 10-30s per page; supports Greek + English
- **GOT-OCR2** (`stepfun-ai/GOT-OCR2_0`): Generative OCR; 3-7 minutes; highest accuracy for complex documents
- **olmOCR** (`allenai/olmOCR-2-7B`): Structured JSON extraction via vLLM; specialized for document understanding
- **Marker** (`pdf2image` + Marker library): Converts PDF pages to Markdown; handles mixed text+scan documents
- **Qwen2.5-VL** (via vLLM): Visual question answering for custom extraction prompts

Model loading is lazy (loaded on first use) with a shared model registry `_models`.

#### `softone_api_client.py`
Python SoftOne Capital ERP API client. Mirrors the TypeScript `softoneClient.ts` but for use from Python scripts. Features:
- Session management with 30-minute timeout and automatic refresh
- `login()` / `logout()`
- `get_data()` — generic data retrieval (products, suppliers, document types)
- `set_data()` — data creation/update
- `create_invoice()` — full invoice creation with line items
- Connection pooling via `requests.Session`

---

### 5.5 VLM Microservice — `vlm-service/`

#### `app.py`
The standalone FastAPI application for the VLM microservice (mirrors `server/python/vlm_service.py`). This is the entry point for the Docker container. Runs on port 8300.

#### `vlm_invoice_parser.py`
Copy of the invoice field parser (same as `server/python/vlm_invoice_parser.py`). Included in the VLM service container so the VLM can perform field extraction within the service itself without calling back to the main Python pipeline.

#### `Dockerfile`
Multi-stage Docker image. Base: `python:3.11-slim`. Installs: FastAPI, uvicorn, Surya OCR, GOT-OCR2 dependencies, pdf2image, Pillow, Torch (CPU/CUDA). Downloads model weights to `/root/.cache` on first run.

#### `docker-compose.vlm.yml`
Docker Compose configuration for the VLM service standalone deployment. Mounts `vlm-cache:/root/.cache` for model persistence. Exposes port 8300. Sets `VLM_SERVICE_URL` environment variable.

#### `requirements.txt`
Python dependencies for the VLM service: `fastapi`, `uvicorn[standard]`, `python-multipart`, `surya-ocr>=0.6.0`, `chandra-ocr>=0.1.0`, `tiktoken>=0.7.0`, `pdf2image>=1.17.0`, `Pillow>=10.0.0`.

#### `test_vlm.py`
Test script for the VLM service. Sends a sample PDF to the `/extract` endpoint and prints the structured result. Usage: `python test_vlm.py <pdf_path> <doc_type> [engine]`

#### `CommandHowTo.txt`
Quick reference for Docker operations: build, run, stop, rebuild, and test commands for the VLM service container.

---

### 5.6 Database — `drizzle/`

#### `schema.ts`
Drizzle ORM schema definitions for all 9 database tables (see [Database Schema](#6-database-schema) section for full details).

#### `relations.ts`
Drizzle relation definitions linking tables (e.g., `invoices` → `invoiceLineItems`, `invoices` → `approvals`).

#### `0000_strange_famine.sql` → `0005_melted_proudstar.sql`
Sequential SQL migration files managed by Drizzle Kit. Each migration is idempotent and run in order. The migrations progressively build the full schema from the initial `users` table to the complete 9-table schema.

---

### 5.7 Electron Desktop App — `electron/`

#### `main.js`
Electron main process. Responsibilities:
- Loads `.env` from `userData` directory or fallback path (production config support)
- Creates a `BrowserWindow` (1400×900 minimum size, context isolation enabled)
- In **dev mode**: loads `http://localhost:3000` (connects to `npm run dev`)
- In **production mode**: spawns the Node.js backend as a child process from `dist-server/index.js`, then loads `http://localhost:3001`
- Handles `IPC` events: `select-file` (native file picker dialog), `get-app-version`
- Manages backend process lifecycle (start, restart, graceful shutdown)
- Registers `deep-link` protocol handler for OAuth redirects

#### `preload.js`
Electron preload script. Exposes a safe `window.electronAPI` bridge to the renderer via `contextBridge`:
- `selectFile()` — opens native file dialog
- `getAppVersion()` — returns Electron app version
- `onBackendReady(callback)` — fires when the backend is up
- `platform` — exposes `process.platform` for OS-specific UI adjustments

---

### 5.8 Deployment & Utilities

#### `vLMBenchmark/benchmark.py`
Full VLM accuracy benchmarking suite. Tests all 5 OCR engines against a ground truth dataset. Measures:
- Field extraction accuracy (invoice number, supplier name, totals, line items)
- Processing time per engine per document
- Confidence calibration
Outputs a detailed accuracy report and comparison matrix.

#### `vLMBenchmark/quick_test.py`
Fast single-engine benchmark for development. Tests one engine against the first ground truth sample and prints field-level accuracy.

#### `vLMBenchmark/ground_truth.json`
Ground truth extraction data for benchmark evaluation. Contains the expected extracted fields (supplier, invoice number, line items, totals) for a set of reference invoice PDFs.

#### `vLMBenchmark/setup.bat` / `setup.sh`
Benchmark environment setup scripts. Install Python dependencies and configure the benchmark working directory.

---

## 6. Database Schema

### `users`
| Column | Type | Description |
|---|---|---|
| `id` | INT PK | Auto-increment primary key |
| `openId` | VARCHAR(64) UNIQUE | OAuth identifier |
| `name` | TEXT | Display name |
| `email` | VARCHAR(320) | Email address |
| `loginMethod` | VARCHAR(64) | Auth provider |
| `role` | ENUM(user, admin) | Access role |
| `createdAt`, `updatedAt`, `lastSignedIn` | TIMESTAMP | Audit fields |

### `suppliers`
| Column | Type | Description |
|---|---|---|
| `id` | INT PK | Auto-increment |
| `code` | VARCHAR(64) UNIQUE | ERP supplier code |
| `name` | TEXT | Supplier name |
| `taxId` | VARCHAR(64) | Greek ΑΦΜ / VAT number |
| `address` | TEXT | Address |

### `products`
| Column | Type | Description |
|---|---|---|
| `id` | INT PK | Auto-increment |
| `erpCode` | VARCHAR(128) UNIQUE | ERP product code |
| `description` | TEXT | Product description |
| `price` | VARCHAR(32) | Base price |
| `category` | VARCHAR(128) | Product category |

### `invoices`
| Column | Type | Description |
|---|---|---|
| `id` | INT PK | Auto-increment |
| `userId` | INT FK → users | Owner |
| `supplierId` | INT FK → suppliers | Linked supplier |
| `documentType` | ENUM | invoice, credit_note, cmr, dispatch_note |
| `invoiceNumber` | VARCHAR(128) | Invoice number as extracted |
| `invoiceDate` | TIMESTAMP | Invoice date |
| `totalAmount` | VARCHAR(32) | Total gross amount |
| `currency` | VARCHAR(8) | Default: EUR |
| `pdfUrl` | TEXT | Presigned URL |
| `pdfFileKey` | VARCHAR(512) | Storage key |
| `status` | ENUM | pending, processing, completed, failed, review_needed |
| `errorMessage` | TEXT | Processing error details |
| `extractedData` | TEXT | Full JSON extraction result |
| `processedAt` | TIMESTAMP | Completion timestamp |

### `invoiceLineItems`
| Column | Type | Description |
|---|---|---|
| `id` | INT PK | Auto-increment |
| `invoiceId` | INT FK → invoices | Parent invoice |
| `lineNumber` | INT | Position in invoice |
| `supplierCode` | VARCHAR(128) | Raw code from invoice |
| `erpCode` | VARCHAR(128) | Matched ERP code |
| `description` | TEXT | Product description |
| `quantity`, `unit`, `unitPrice` | VARCHAR | Product quantity/price |
| `discount1/2/3` | VARCHAR | Up to 3 discount levels |
| `netAmount`, `vatRate`, `vatAmount`, `totalWithVat` | VARCHAR | Financials |
| `matchStatus` | ENUM | matched, pending, manual, failed |
| `matchConfidence` | VARCHAR(8) | 0-100 |

### `productMappings`
Confirmed supplier code → ERP code mappings used as the knowledge base for ML matching.

### `transformationRules`
Learned code transformation rules with type, pattern, confidence, usage/success counts, and example pairs.

### `configuration`
Per-user ERP connection settings (SoftOne credentials, company/branch/fiscal year), plus extensible `settingsJson` for all other settings.

### `notifications`
Bell notifications: type (`review_needed`, `approval_requested`, etc.), title, message, linked invoice, read status.

### `approvals`
Multi-step approval chain: step (1=review, 2=approve, 3=final), status (pending/approved/rejected), requester, assignee, comment, decision timestamp.

---

## 7. API Reference (tRPC Routers)

All API calls use tRPC over HTTP POST to `/api/trpc`. Protected procedures require a valid `app_session_id` cookie.

### `auth`
| Procedure | Type | Auth | Description |
|---|---|---|---|
| `auth.me` | query | public | Returns current user or null |
| `auth.logout` | mutation | public | Clears session cookie |

### `invoices`
| Procedure | Type | Auth | Description |
|---|---|---|---|
| `invoices.list` | query | ✅ | All invoices for current user |
| `invoices.getById` | query | ✅ | Invoice + line items by ID |
| `invoices.upload` | mutation | ✅ | Upload PDF, trigger extraction pipeline |
| `invoices.processInvoice` | mutation | ✅ | Re-process an existing invoice |
| `invoices.updateLineItem` | mutation | ✅ | Manual ERP code correction |
| `invoices.submitToErp` | mutation | ✅ | Post invoice to SoftOne ERP |
| `invoices.statistics` | query | ✅ | KPI counts (total, by status) |
| `invoices.analytics` | query | ✅ | Time-series chart data |
| `invoices.exportHistory` | query | ✅ | ERP export log |
| `invoices.getFileUrl` | query | ✅ | Presigned URL for PDF download |

### `configuration`
| Procedure | Type | Auth | Description |
|---|---|---|---|
| `configuration.get` | query | ✅ | Full configuration record |
| `configuration.getSettings` | query | ✅ | Parsed `settingsJson` |
| `configuration.updateSoftone` | mutation | ✅ | Save ERP credentials |
| `configuration.updateSettings` | mutation | ✅ | Save extended settings |
| `configuration.testConnection` | mutation | ✅ | Live ERP connection test |

### `softone`
| Procedure | Type | Auth | Description |
|---|---|---|---|
| `softone.testConnection` | mutation | ✅ | Authenticate to SoftOne |
| `softone.getProducts` | query | ✅ | Fetch full product catalog |
| `softone.getProductByCode` | query | ✅ | Single product lookup |
| `softone.getSuppliers` | query | ✅ | Fetch supplier list |
| `softone.getSupplierByCode` | query | ✅ | Single supplier lookup |
| `softone.createInvoice` | mutation | ✅ | Post invoice to ERP |

### `optimusDb`
| Procedure | Type | Auth | Description |
|---|---|---|---|
| `optimusDb.testConnection` | mutation | ✅ | Test OptimusDB API connectivity |
| `optimusDb.push` | mutation | ✅ | Push invoice metadata to catalog |

---

## 8. OCR & Extraction Pipeline

The full processing pipeline for an uploaded invoice PDF:

```
PDF Upload (base64)
        │
        ▼
  storage.ts → save to local/cloud
        │
        ▼
  python-integration.ts
        │
        ├─ ocr.ts (Node.js)
        │    ├─ pdfjs-dist (text-based PDF?) ──→ text ✓
        │    └─ mupdf → PNG pages
        │         └─ tesseract.js (eng+ell) ──→ text ✓
        │
        ├─ vlmOrchestrator.ts (if VLM enabled)
        │    └─ POST to vlm-service:8300/extract
        │         └─ Surya / GOT-OCR2 / olmOCR ──→ structured text ✓
        │
        ▼
  document_classifier.py
        └─ Scores keywords → document_type
                │
                ├─ "invoice"        → invoice_extractor_advanced.py
                ├─ "dispatch_note"  → dispatch_extractor.py
                ├─ "credit_note"    → credit_note_extractor.py
                └─ "cmr"            → cmr_extractor.py
                         │
                         ▼
                  Extracted JSON
                         │
                         ▼
                ml_product_matcher_v2.py
                    ├─ Direct match (KB lookup)
                    ├─ Rule transformation
                    ├─ Fuzzy match
                    └─ Description match
                         │
                         ▼
                invoiceDb.ts → save invoice + line items
                         │
                         ▼
                [Automatic] tryPushToOptimusDb()
```

---

## 9. ML Product Matching & Rule Learning

### Matching Algorithm Priority

1. **Direct match** (confidence: 100): Supplier code found verbatim in the knowledge base for this supplier.
2. **Rule-based transformation** (confidence: 75-95): Apply learned transformation rules. e.g., `SUP-001` → strip hyphen → `SUP001` → prepend `KAL` → `KALSUP001`.
3. **Fuzzy string matching** (confidence: 40-74): `difflib.SequenceMatcher` similarity ratio.
4. **Description matching** (confidence: 20-60): Compare product description text.

### Rule Learning Workflow

1. User uploads invoice from Supplier A (first time).
2. ML matches codes with varying confidence.
3. User manually corrects 3 line items (e.g., always adds prefix `KAL` to supplier codes).
4. After 3 confirmations of the same pattern, `rule_learning_engine.py` auto-generates a `prefix_addition` rule for Supplier A.
5. All future invoices from Supplier A automatically apply the rule — 90%+ automation rate.

### Knowledge Base Structure

```json
{
  "suppliers": {
    "SUPPLIER_CODE": {
      "name": "Supplier Name",
      "confirmed_mappings": 42
    }
  },
  "mappings": {
    "SUPPLIER_CODE:SUPPLIER_PROD_CODE": "ERP_CODE"
  }
}
```

---

## 10. ERP Integration (SoftOne)

SoftOne Capital is a Greek ERP system used by SMEs. The integration uses SoftOne's REST/JSON API:

### Authentication Flow
1. `POST /api/login` with username, password, company ID → returns `sessionid`
2. Session valid for 30 minutes; auto-renewed on expiry
3. All subsequent requests include `sessionid` in headers

### Invoice Creation
```
GET /api/getdata?object=ITELINES → fetch matching products
GET /api/getdata?object=SUPPLIER → fetch/verify supplier
POST /api/setdata?object=SOPURCHDOC → create purchase invoice
  Body: {
    SUPPDOC: {
      SERIES: <document_series>,
      TRDR: <supplier_id>,
      FINDATE: <invoice_date>,
      ...header fields
    },
    MTRL lines: [
      { MTRL: <product_id>, QTY1: <qty>, PRICE: <unit_price>, ... }
    ]
  }
```

---

## 11. OptimusDB Integration

OptimusDB is George's PhD research project — a decentralized distributed data catalog. When enabled in Configuration, every completed invoice is automatically pushed as a catalog entry:

```
Invoice Completed
      │
      ▼
optimusDbClient.ts::buildInvoiceMetadata()
      │  Transforms invoice + line items to catalog entry schema
      ▼
POST {optimusDbApiUrl}/catalog/entries
  Authorization: Bearer {authToken}
  Body: {
    catalog: "invoices",
    nodeId: "...",
    metadata: {
      invoiceNumber, supplierName, supplierTaxId,
      totalAmount, currency, lineItemCount, matchedItemCount,
      lineItems: [ { supplierCode, erpCode, matchStatus, ... } ]
    }
  }
```

This feeds invoice data into the OptimusDB/OptimusDDC distributed catalog for research into distributed metadata management.

---

## 12. Installation & Setup

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18+ | https://nodejs.org |
| pnpm | latest | `npm install -g pnpm` |
| Python | 3.11 | ⚠️ NOT 3.14 — incompatible with pdfplumber/sklearn |
| MySQL | 8.0+ | Or MariaDB 10.6+ |
| Docker | latest | Required only for VLM service |

### Steps

```bash
# 1. Clone
git clone https://github.com/georgeGeorgakakos/optimusInvoice
cd optimusInvoice

# 2. Install Node.js dependencies
pnpm install

# 3. Install Python dependencies
pip install pdfplumber scikit-learn requests

# 4. Configure environment
cp .env.example .env
# Edit .env — see Environment Variables section

# 5. Create database and run migrations
pnpm db:push

# 6. Start development server
pnpm dev
```

---

## 13. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | MySQL connection string: `mysql://user:pass@localhost:3306/optimus` |
| `JWT_SECRET` | ✅ | Secret for signing session cookies (min 32 chars) |
| `OAUTH_SERVER_URL` | ✅ | OAuth provider URL for authentication |
| `VITE_APP_ID` | ✅ | Application ID for the Manus platform |
| `OWNER_OPEN_ID` | ⬜ | OpenID of the initial admin user |
| `PORT` | ⬜ | Server port (default: 3000) |
| `VLM_SERVICE_URL` | ⬜ | VLM microservice URL (default: `http://localhost:8300`) |
| `ENCODER_URL` | ⬜ | Encoder service URL (default: `http://localhost:8100`) |
| `DETECTION_URL` | ⬜ | Detection service URL (default: `http://localhost:8101`) |
| `VLLM_URL` | ⬜ | vLLM server URL (default: `http://localhost:8200`) |
| `BUILT_IN_FORGE_API_URL` | ⬜ | Cloud file storage API URL |
| `BUILT_IN_FORGE_API_KEY` | ⬜ | Cloud file storage API key |

> SoftOne ERP credentials are stored in the database (per-user configuration) and managed through the Configuration page — they are NOT environment variables.

---

## 14. Running the Application

### Development Mode
```bash
pnpm dev
# Opens at http://localhost:3000
# Backend API at http://localhost:3000/api/trpc
```

### Production Mode
```bash
pnpm build          # Build frontend + backend
pnpm start          # Start production server
```

### With VLM Service (Docker)
```bash
# Start VLM service (downloads ~6GB model weights on first run)
docker compose -f docker-compose.vlm.yml up -d

# Start application
pnpm dev
```

### Windows PowerShell (all-in-one launcher)
```powershell
.\OptimusInvoice.ps1
```

---

## 15. Building the Desktop App

The Electron app packages the Node.js backend and React frontend into a standalone desktop application.

```bash
# Build all (client + server bundles + Electron)
pnpm electron:build

# Windows portable (.exe)
pnpm electron:build:win

# macOS (.dmg)
pnpm electron:build:mac

# Linux (.AppImage)
pnpm electron:build:linux
```

Output: `dist-electron/` directory.

The Electron app:
1. Reads `.env` from `%APPDATA%/optimus-invoice-automation/.env`
2. Spawns the Node.js backend as a child process
3. Waits for the backend to start (polls `/api/trpc/system.healthCheck`)
4. Opens the `BrowserWindow` loading `http://localhost:3001`

---

## 16. VLM Service (Docker)

The VLM service is optional — only needed for scanned PDFs that cannot be processed by the Node.js `pdfjs-dist` + `tesseract.js` pipeline.

```bash
# Build image
cd vlm-service
docker build -t vlm-service .

# Run (first start downloads ~6GB model weights)
docker run -d \
  --name vlm-service \
  -p 8300:8300 \
  -v vlm-cache:/root/.cache \
  --memory=16g \
  vlm-service

# Monitor startup
docker logs -f vlm-service

# Test with a sample PDF
python vlm-service/test_vlm.py data/invoices/FI45483162319.pdf invoice surya
```

### Engine Selection Guide

| Engine | Speed | Accuracy | Use Case |
|---|---|---|---|
| `surya` | 10-30s | Good | Default for scanned Greek/English docs |
| `got_ocr2` | 3-7 min | Excellent | Complex table extraction, fallback |
| `olmocr` | 1-3 min | Excellent | Structured JSON extraction |
| `marker` | 30-90s | Good | Mixed PDF (text+scan) → Markdown |
| `qwen_vl` | 30-60s | Good | Custom prompts, visual Q&A |
| `auto` | Variable | Adaptive | Surya first, escalates if confidence < 70% |

---

## 17. Known Issues & Roadmap

### Known Issues

- Python 3.14 is **not supported** — incompatible with pdfplumber, scikit-learn, and other ML dependencies. Use Python 3.11.
- The Electron Windows `.exe` production build is still in progress.
- First VLM service startup takes 5-15 minutes to download and load model weights.
- Large invoices (100+ line items) may cause the `InvoiceDetail.tsx` page to render slowly.

### Roadmap

- [ ] Batch invoice processing queue (upload multiple PDFs, process in background)
- [ ] Knowledge base editor with inline correction UI
- [ ] End-to-end test suite with real Greek invoice fixtures
- [ ] Windows `.exe` production build (signed installer)
- [ ] Multi-user role-based access (reviewer, approver, admin)
- [ ] Webhook notifications for external systems
- [ ] Additional ERP connectors (beyond SoftOne)
- [ ] Invoice deduplication detection
- [ ] Audit trail export (PDF report of all processed invoices)

---

*Documentation generated: March 2026 | Author: George Georgakakos | Project: OptimusInvoice v2.0*
