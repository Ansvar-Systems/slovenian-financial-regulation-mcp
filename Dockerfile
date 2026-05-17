# ─────────────────────────────────────────────────────────────────────────────
# Slovenian Financial Regulation MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t slovenian-financial-regulation-mcp .
# Run:    docker run --rm -p 3000:3000 slovenian-financial-regulation-mcp
#
# The image expects a pre-built database at /app/data/atvp.db.
# Override with ATVP_DB_PATH for a custom location.
#
# Multi-stage build: stage 1 builds TypeScript + native modules
# (better-sqlite3 postinstall fetches/builds the .node binding),
# stage 2 copies node_modules from stage 1 to preserve the native
# binding. The prior single-COPY pattern that re-ran
# `npm ci --ignore-scripts` in the production stage skipped the
# postinstall, so the binding was never present and every tool
# call raised `Could not locate the bindings file ...
# better_sqlite3.node` at runtime. Same regression class as the
# 2026-05-09 sector-binding incident on sibling Slovenian MCPs,
# resolved in slovenian-data-protection-mcp/Dockerfile and adopted
# here verbatim.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native modules ---
FROM node:20-slim AS builder

WORKDIR /app

# Install build tooling needed for better-sqlite3 native compile
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Run full install (no --ignore-scripts) so better-sqlite3 postinstall
# fetches/builds the native .node binding into node_modules.
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Prune to production deps only (preserves the already-built native binding).
RUN npm prune --omit=dev

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV ATVP_DB_PATH=/app/data/atvp.db

# Copy production node_modules (with native binding intact) and built dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
