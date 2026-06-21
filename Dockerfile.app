# =============================================================================
#  OptimusInvoice — Node.js App Container
#  Builds the React frontend + Node.js/Express backend into one image.
#  Production mode: serves pre-built static files, no Vite dev server.
# =============================================================================

FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy dependency manifests first (Docker cache layer — only reinstalls when
# package.json or lockfile changes, not on every code change).
# NOTE: package.json declares pnpm.patchedDependencies (wouter@3.7.1 →
# patches/wouter@3.7.1.patch), so the patches/ folder MUST be present before
# `pnpm install` runs — otherwise pnpm aborts with
# "ENOENT: ... patches/wouter@3.7.1.patch". Copy it here, alongside the manifests.
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/

RUN pnpm install --frozen-lockfile

# Copy all source files
COPY . .

# Build React frontend → dist/public/
# Build Node.js server → dist/index.js
RUN pnpm build

# =============================================================================
#  Runtime stage — only what's needed to run, no build tools
# =============================================================================
FROM node:22-slim

WORKDIR /app

RUN npm install -g pnpm

# ─────────────────────────────────────────────────────────────────────────────
# Python runtime for the ML scripts the Node app spawns.
#
# The Node backend (server/python-integration.ts) shells out to two Python
# scripts at runtime — ml_product_matcher_v2.py (product matching) and
# rule_learning_engine.py (correction-learning + the /rules page). Without a
# python interpreter present these spawns fail, so every line item stays
# UNMATCHED and /rules throws.
#
# These two scripts import ONLY the Python standard library (json, re, difflib,
# datetime, collections, logging, typing) — NO third-party packages — so we
# install just the interpreter and pip nothing. (The heavy VLM/extraction
# engines — torch, pdfplumber, fastapi, etc. — run in the SEPARATE vlm-service /
# qwen containers and are reached over HTTP, so none of that belongs here.)
#
# python-integration.ts probes ["python3","python","py"]; python3 alone suffices,
# but we symlink `python` → `python3` defensively.
# ─────────────────────────────────────────────────────────────────────────────
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Copy built output and production dependencies only
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/patches ./patches
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./

# ─────────────────────────────────────────────────────────────────────────────
# Copy the Python scripts to where the app expects them.
#
# At runtime the server bundle is /app/dist/index.js, so in
# python-integration.ts  __dirname === /app/dist  and
#   PYTHON_DIR = path.join(__dirname, "python")  ===  /app/dist/python
# `pnpm build` bundles the TypeScript but does NOT carry the .py files across,
# so we copy the source folder straight to that path. (The unused heavy engines
# come along too; they cost only disk and are never spawned in this container.)
# ─────────────────────────────────────────────────────────────────────────────
COPY --from=builder /app/server/python ./dist/python

# Install only production deps + drizzle-kit (needed for migrations)
# patches/ copied above so pnpm.patchedDependencies (wouter) resolves here too.
RUN pnpm install --frozen-lockfile --prod
RUN pnpm add -D drizzle-kit

# Upload storage directory
RUN mkdir -p /app/uploads

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run migrations then start the server
CMD ["sh", "-c", "pnpm db:push && node dist/index.js"]