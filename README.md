# 🧾 Optimus — Invoice Automation System

> Intelligent invoice processing with ML-powered product matching, rule learning, and ERP system integration.

![Version](https://img.shields.io/badge/version-2.0-blue)
![Node](https://img.shields.io/badge/node-22+-green)
![Python](https://img.shields.io/badge/python-3.11+-yellow)
![License](https://img.shields.io/badge/license-MIT-purple)

---

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Application](#running-the-application)
- [Building the Desktop App](#building-the-desktop-app)
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [Python ML System](#python-ml-system)
- [ERP Integration](#erp-system-integration)
- [Known Issues](#known-issues)
- [Roadmap](#roadmap)

---

## Overview

**Optimus** is a full-stack invoice automation platform designed to eliminate manual data entry when processing supplier invoices into an ERP system.

The system accepts PDF invoices (including Greek-language invoices in myDATA/ΑΑΔΕ format), extracts structured data using a Python ML pipeline, matches supplier product codes to ERP product codes using machine learning with automatic rule learning, and posts approved invoices directly to ERP.

After processing just **3–5 invoices per supplier**, the system learns transformation patterns and automates **90%+ of product matching** with no further manual intervention.

---

## Features

### ✅ Implemented

| Feature | Description |
|---|---|
| 📤 PDF Invoice Upload | Drag-and-drop interface with base64 encoding |
| 🔍 OCR Extraction | Greek invoice support (myDATA/ΑΑΔΕ format) via pdfplumber |
| 🤖 ML Product Matching | 4-algorithm matching with confidence scores |
| 🧠 Rule Learning Engine | Auto-learns transformation patterns after 3 corrections |
| 📊 Dashboard & Analytics | Automation rate, processing stats, recent activity |
| 🗄️ Invoice Management | Full CRUD with status tracking |
| 🔗 ERP system Integration | Login, product lookup, supplier lookup, invoice creation |
| 🖥️ Electron Desktop App | Standalone Windows/Mac/Linux app framework |
| 🔐 Authentication | OAuth-based user login with session management |
| 📁 Database | Full relational schema with Drizzle ORM migrations |
| ⚙️ Configuration Panel | In-app ERP credential management & connection testing |

### Under evaluation



### 🚧 In Progress

- Batch invoice processing queue
- Knowledge base viewer with edit capabilities
- End-to-end testing with real Greek invoices
- Windows `.exe` production build

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Frontend (React)                  │
│   Dashboard │ Upload │ Invoices │ Matching │ Config  │
└──────────────────────┬──────────────────────────────┘
                       │ tRPC
┌──────────────────────▼──────────────────────────────┐
│                 Backend (Node.js / Express)           │
│   routers.ts │ softoneClient.ts │ invoiceDb.ts       │
│               pythonBridge.ts                        │
└──────────┬─────────────────────────┬────────────────┘
           │ Child Process           │ REST/JSON
┌──────────▼────────────┐   ┌───────▼────────────────┐
│   Python ML Engine    │   │   ERP system   │
│  invoice_extractor    │   │   (SOAP/REST API)       │
│  ml_product_matcher   │   └────────────────────────┘
│  rule_learning_engine │
└──────────┬────────────┘
           │
┌──────────▼────────────┐
│     MySQL Database    │
│  (Drizzle ORM)        │
└───────────────────────┘
```

---

## Tech Stack

**Frontend**
- React 19 + TypeScript
- Tailwind CSS 4 + shadcn/ui
- tRPC client (type-safe API calls)
- Wouter (routing)
- Vite (bundler)

**Backend**
- Node.js 22 + Express 4
- tRPC 11 (end-to-end type safety)
- Drizzle ORM + MySQL
- AWS S3 / MinIO (file storage)

**Desktop**
- Electron + electron-builder
- Supports Windows (.exe), Mac (.dmg), Linux (.AppImage)

**ML / Processing**
- Python 3.11
- pdfplumber (PDF text + table extraction)
- scikit-learn (ML product matching)
- Custom rule learning engine

**ERP**
- ERP API (REST/JSON)
- Session-based auth with 30-minute sessions

---

## Prerequisites

Make sure the following are installed before proceeding:

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18+ | https://nodejs.org |
| pnpm | latest | `npm install -g pnpm` |
| Python | 3.11+ | https://python.org (**not** 3.14) |
| MySQL | 8.0+ | Or PostgreSQL 14+ |
| Git | any | |

> ⚠️ **Python 3.14 is NOT supported** — it is incompatible with pdfplumber, scikit-learn, and other ML dependencies.

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/geosampson/INVOICE_AUTOMATION.git
cd INVOICE_AUTOMATION
```

### 2. Install Node.js Dependencies

```bash
pnpm install
# or: npm install
```

### 3. Install Python Dependencies

```bash
pip install pdfplumber pandas openpyxl scikit-learn requests
```

On Windows, if you have multiple Python versions:

```powershell
py -3.11 -m pip install pdfplumber pandas openpyxl scikit-learn requests
```

### 4. Set Up the Database

**MySQL:**

```sql
CREATE DATABASE invoice_automation;
CREATE USER 'invoice_user'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON invoice_automation.* TO 'invoice_user'@'localhost';
FLUSH PRIVILEGES;
```

**PostgreSQL:**

```sql
CREATE DATABASE invoice_automation;
CREATE USER invoice_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE invoice_automation TO invoice_user;
```

### 5. Configure Environment Variables

```bash
# Copy the example file
cp .env.example .env
```

Then edit `.env` — see [Configuration](#configuration) below.

### 6. Run Database Migrations

```bash
pnpm db:push
```

---

## Configuration

Edit `.env` in the project root with your values:

```env
# ── REQUIRED ──────────────────────────────────────
# Database
DATABASE_URL="mysql://invoice_user:your_password@localhost:3306/invoice_automation"

# Security (generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
JWT_SECRET="your-64-character-random-secret-here"

# Application
NODE_ENV="development"
PORT=3000

# ── OPTIONAL ──────────────────────────────────────
# File Storage (AWS S3 or MinIO)
AWS_ACCESS_KEY_ID="your-access-key"
AWS_SECRET_ACCESS_KEY="your-secret-key"
AWS_REGION="us-east-1"
AWS_S3_BUCKET="invoice-automation-files"
# AWS_ENDPOINT="http://localhost:9000"   # Uncomment for local MinIO

# OAuth Authentication
# OAUTH_SERVER_URL="https://your-oauth-provider.com"
# VITE_OAUTH_PORTAL_URL="https://your-oauth-provider.com/login"
# VITE_APP_ID="your-app-id"
```

> **ERP credentials** are configured through the in-app **Configuration page** at runtime — not via `.env`.

---

## Running the Application

### Development Mode (Web)

```powershell
pnpm dev
```

Opens at **http://localhost:3000**

### Production Mode

```powershell
# Build frontend + backend
pnpm build

# Start production server
pnpm start
```

### TypeScript Type Check

```powershell
pnpm check
```

### Run Tests

```powershell
pnpm test
```

---

## Building the Desktop App

The project includes full Electron configuration for standalone desktop builds.

### Development (Desktop)

```powershell
pnpm electron:dev
```

### Build Windows Installer (.exe)

```powershell
pnpm electron:build:win
```

### Build Mac App (.dmg)

```powershell
pnpm electron:build:mac
```

### Build Linux (.AppImage)

```powershell
pnpm electron:build:linux
```

> Output files are placed in the `dist/` folder after a successful build.

---

## How It Works

### End-to-End Invoice Processing Flow

```
1. Upload PDF
       │
       ▼
2. Python extracts text + tables
   (pdfplumber, Greek ΑΑΔΕ support)
       │
       ▼
3. Header parsed: supplier, date, invoice #, totals
   Line items parsed: code, description, qty, price
       │
       ▼
4. ML matcher runs 4 algorithms:
   - Exact code match
   - Fuzzy description match
   - Rule-based transformation
   - Historical knowledge base
       │
       ▼
5. Top 3–5 matches returned with confidence scores
       │
       ▼
6. User reviews & confirms / corrects
       │
       ▼
7. Rule Learning Engine records correction
   (after 3 corrections → new rule created)
       │
       ▼
8. "Create in ERP" → invoice posted to ERP
```

### Rule Learning Example

| Invoice | Supplier Code | User Action | System Learns |
|---|---|---|---|
| #1 | 74245 | Corrects to `317-74245` | Records correction |
| #2 | 74810 | Corrects to `317-74810` | Records correction |
| #3 | 75001 | Corrects to `317-75001` | ✅ Rule created: **add prefix `317-`** |
| #4+ | any code | Automatic | Applied instantly |

---

## Project Structure

```
InvoiceAutomation/
├── client/                        # React frontend
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.tsx      # Main dashboard with stats
│       │   ├── InvoiceUpload.tsx  # Drag-and-drop upload
│       │   ├── InvoiceList.tsx    # Invoice history & search
│       │   ├── InvoiceDetail.tsx  # Line items, product matching
│       │   ├── Approvals.tsx      # Review queue
│       │   ├── RuleLearning.tsx   # View learned rules
│       │   ├── ErpDataModel.tsx   # ERP product catalog
│       │   ├── KnowledgeBase.tsx  # Supplier-product mappings
│       │   └── Configuration.tsx  # ERP credentials & test
│       ├── components/
│       │   ├── DashboardLayout.tsx
│       │   └── ui/                # shadcn/ui component library
│       └── App.tsx                # Routing
│
├── server/                        # Node.js backend
│   ├── python/                    # Python ML scripts
│   │   ├── invoice_extractor_advanced.py   # PDF extraction
│   │   ├── ml_product_matcher_v2.py        # ML matching
│   │   ├── rule_learning_engine.py         # Rule learning
│   │   ├── document_classifier.py          # Doc type detection
│   │   ├── ocr_helper.py                   # OCR utilities
│   │   ├── softone_api_client.py           # Python ERP client
│   │   ├── credit_note_extractor.py
│   │   ├── cmr_extractor.py
│   │   └── dispatch_extractor.py
│   ├── _core/                     # Framework boilerplate
│   ├── routers.ts                 # All tRPC API endpoints
│   ├── softoneClient.ts           # ERP system TypeScript client
│   ├── invoiceDb.ts               # Database query helpers
│   ├── pythonBridge.ts            # Node → Python bridge
│   ├── python-integration.ts      # Python execution utilities
│   ├── db.ts                      # Database connection
│   └── storage.ts                 # File storage (S3/local)
│
├── electron/                      # Desktop app
│   ├── main.js                    # Electron main process
│   └── preload.js                 # IPC preload script
│
├── drizzle/                       # Database
│   ├── schema.ts                  # Full schema definition
│   ├── relations.ts               # Table relationships
│   └── *.sql                      # Migration files
│
├── shared/
│   └── types.ts                   # Shared TypeScript types
│
├── data/
│   └── invoices/                  # Sample PDF invoices
│
├── .env.example                   # Environment variable template
├── package.json                   # Scripts & dependencies
├── drizzle.config.ts              # Drizzle ORM config
├── vite.config.ts                 # Vite frontend config
├── vite.electron.config.ts        # Vite config for Electron build
└── tsconfig.json                  # TypeScript config
```

---

## Database Schema

| Table | Purpose |
|---|---|
| `users` | Authentication & roles |
| `invoices` | Invoice header (number, date, supplier, status, PDF URL) |
| `invoiceLineItems` | Line items per invoice (code, description, qty, price, ERP match) |
| `suppliers` | Supplier master data (name, tax ID, address) |
| `products` | ERP product catalog (code, description, price) |
| `productMappings` | Supplier code → ERP code mappings (with confidence score) |
| `transformationRules` | ML-learned transformation rules |
| `configuration` | System settings (ERP credentials, preferences) |

**Invoice Status Flow:**

```
pending → processing → review_needed → completed
                    ↘ failed
```

---

## API Reference

All endpoints use **tRPC** (type-safe, no REST documentation needed — use TypeScript autocomplete).

### Key Router Groups

| Router | Endpoints |
|---|---|
| `invoices.*` | `list`, `get`, `upload`, `processInvoice`, `updateStatus` |
| `products.*` | `list`, `search`, `matchProducts` |
| `mappings.*` | `list`, `create`, `update` |
| `rules.*` | `list`, `stats`, `learnFromCorrection` |
| `softone.*` | `testConnection`, `getProducts`, `getSuppliers`, `createInvoice` |
| `configuration.*` | `get`, `save` |
| `auth.*` | `login`, `logout`, `me` |

---

## Python ML System

The Python ML pipeline lives in `server/python/` and is called by Node.js via child process spawning.

### `invoice_extractor_advanced.py`

Extracts invoice data from PDF using multiple strategies:

- **pdfplumber table detection** — handles multi-line cells common in Greek invoices
- **Greek header parsing** — supports ΑΦΜ, ΤΙΜ, ΚΩΔΙΚΟΣ, ΠΟΣ., ΚΑΘΑΡΗ fields
- **Number format parsing** — converts Greek format `1.234,56` → `1234.56`
- **Fallback text extraction** — regex-based parsing when tables fail

**Supported document types:** Invoice (Τιμολόγιο), Credit Note, CMR, Dispatch Note

### `ml_product_matcher_v2.py`

4-algorithm matching engine:

1. **Exact match** — direct code lookup in knowledge base
2. **Rule-based** — applies learned transformation rules
3. **Fuzzy string matching** — description similarity scoring
4. **Historical** — previous confirmed matches from database

Returns top 3–5 candidates per line item with confidence scores (0.0–1.0).

### `rule_learning_engine.py`

Automatically detects transformation patterns from user corrections:

- **Prefix/suffix rules** — "add `317-` before code"
- **Replace rules** — "replace `ABC` with `XYZ`"
- **Regex rules** — complex pattern transformations
- Rule activation threshold: **3 confirmations**
- Rules stored in `transformation_rules.json`

---

## ERP system Integration

The TypeScript client (`server/softoneClient.ts`) handles all ERP communication.

### Authentication

- Session-based login (30-minute sessions)
- Auto-renew on expiry
- Configured via in-app Configuration page

### Supported Operations

| Operation | Description |
|---|---|
| `login()` | Authenticate and get session ID |
| `getProducts()` | Fetch STOCKITEMS (CODE, DESCR, RTLPRICE) |
| `findProductByCode()` | Lookup single product |
| `getSuppliers()` | Fetch TRDR table |
| `findSupplierByName()` | Search supplier by name or AFM |
| `createInvoice()` | Post purchase invoice via SetData |
| `testConnection()` | Verify credentials & connectivity |

### Configuration

Enter credentials through **Settings → Configuration** in the app:

| Field | Example |
|---|---|
| API URL | `https://your-softone-server.com/api` |
| Username | `your_username` |
| Password | `your_password` |
| Company | `1` |
| Fiscal Year | `2026` |
| Branch | `1` |

> SSL verification is disabled by default as required by ERP API documentation.

---

## Known Issues

| Issue | Status | Workaround |
|---|---|---|
| OAuth redirect loop after login (Phase 26) | 🔴 Open | Re-login if redirected back to login page |
| VLM zero line items on scanned PDFs | 🟡 In Progress | Use text-based PDFs for now |
| Batch processing not implemented | 🟡 Planned | Upload invoices one at a time |
| Knowledge Base viewer is read-only | 🟡 Planned | Edit mappings via database directly |
| Manual product search fallback | 🟡 Planned | Use fuzzy match suggestions |

---

## Roadmap

### Short Term
- [ ] Fix OAuth redirect loop (Phase 26)
- [ ] End-to-end test with real Greek invoices
- [ ] Build and test Windows `.exe`
- [ ] Complete Knowledge Base viewer with edit/delete

### Medium Term
- [ ] Batch invoice upload queue
- [ ] VLM integration (Qwen2.5-VL, Surya OCR) for scanned invoices
- [ ] Historical trend analytics
- [ ] Export analytics data

### Long Term
- [ ] Email ingestion (auto-process invoices from inbox)
- [ ] Multi-company / multi-ERP support
- [ ] REST API for third-party integrations
- [ ] Mobile app

---

## Development Commands

```powershell
pnpm dev                    # Start web dev server (localhost:3000)
pnpm build                  # Build for production
pnpm start                  # Run production build
pnpm check                  # TypeScript type check
pnpm test                   # Run test suite
pnpm format                 # Format code with Prettier
pnpm db:push                # Generate & apply DB migrations
pnpm electron:dev           # Run desktop app in dev mode
pnpm electron:build:win     # Build Windows installer
pnpm electron:build:mac     # Build Mac app
pnpm electron:build:linux   # Build Linux AppImage
```

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "Add my feature"`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

---

## License

MIT License — see `LICENSE` for details.

---

*Intelligent invoice automation for ERP integration.*
