# ════════════════════════════════════════════════════════════════
#  Dockerfile — multi-stage, production-optimised for Cloud Run
# ════════════════════════════════════════════════════════════════
#
#  Stage 1 (deps):    install only production dependencies
#  Stage 2 (runtime): tiny final image, non-root user, no dev tools
#
#  Build:   docker build -t audiohook-server .
#  Run:     docker run -p 8080:8080 --env-file .env audiohook-server
# ════════════════════════════════════════════════════════════════

# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests first (layer-cache friendly)
COPY package*.json ./

# Install prod deps only (no devDependencies)
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Security: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy dependency tree from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY server.js        ./
COPY agent-ui.html    ./
COPY src/             ./src/

# Cloud Run injects PORT (default 8080); expose it
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

# Drop to non-root
USER appuser

# Health-check so Docker / Cloud Run shows container status
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
