"use strict";

/**
 * server.js  —  Application entry point
 * ════════════════════════════════════════════════════════════════
 *
 * Responsibilities (only bootstrapping — no business logic here):
 *   1. Load env-vars
 *   2. Validate config (fail-fast on missing secrets)
 *   3. Create HTTP server
 *   4. Create two WebSocket servers (Genesys + Agent UI)
 *   5. Route HTTP upgrades to the right WS server
 *   6. Start listening
 *   7. Handle graceful shutdown (SIGTERM / SIGINT — Cloud Run sends SIGTERM)
 *
 * Business logic lives in:
 *   src/handlers/audiohookHandler.js
 *   src/handlers/agentUiHandler.js
 *   src/services/geminiService.js
 *   src/services/crmService.js
 *   src/services/agentBroadcaster.js
 *   src/services/sessionStore.js
 */

require("dotenv").config();   // no-op in Cloud Run (env vars set via Secret Manager)

const http      = require("http");
const WebSocket = require("ws");

// ── Load modules in dependency order ─────────────────────────────────────────
const { config, validate }           = require("./src/config");
const logger                         = require("./src/utils/logger");
const { handleHttpRequest }          = require("./src/routes/health");
const { handleAudiohookConnection }  = require("./src/handlers/audiohookHandler");
const { handleAgentUiConnection }    = require("./src/handlers/agentUiHandler");

// ── Validate env-vars before anything else ────────────────────────────────────
try {
  validate();
} catch (err) {
  // Use process.stderr so it appears even if logger fails
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const handled = handleHttpRequest(req, res);
  if (!handled) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found\n");
  }
});

// ── WebSocket servers (share the same port via upgrade routing) ───────────────
const wssGenesys = new WebSocket.Server({ noServer: true });
const wssAgentUI = new WebSocket.Server({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === config.AUDIOHOOK_PATH) {
    wssGenesys.handleUpgrade(request, socket, head, (ws) => {
      wssGenesys.emit("connection", ws, request);
    });
  } else if (pathname === config.AGENT_UI_PATH) {
    wssAgentUI.handleUpgrade(request, socket, head, (ws) => {
      wssAgentUI.emit("connection", ws, request);
    });
  } else {
    socket.destroy();   // reject unknown paths
  }
});

// ── Wire up connection handlers ───────────────────────────────────────────────
wssGenesys.on("connection", handleAudiohookConnection);
wssAgentUI.on("connection", handleAgentUiConnection);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Cloud Run sends SIGTERM and expects the container to exit within 10 s.
let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} — shutting down gracefully`);

  // Stop accepting new connections
  httpServer.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });

  // Close existing WS clients
  for (const ws of wssGenesys.clients) ws.terminate();
  for (const ws of wssAgentUI.clients) ws.terminate();

  // Force-exit after 8 s (Cloud Run hard-kills at 10 s)
  setTimeout(() => {
    logger.warn("Forced exit after timeout");
    process.exit(1);
  }, 8_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Catch unhandled errors — log but don't crash in production
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  if (!config.isProd()) process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: String(reason) });
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(config.PORT, () => {
  logger.info("Server started", {
    port        : config.PORT,
    env         : config.NODE_ENV,
    audiohook   : config.AUDIOHOOK_PATH,
    agentUi     : config.AGENT_UI_PATH,
    crmAdapter  : config.CRM_ADAPTER,
    vertexAI    : {
      project : config.GOOGLE_CLOUD_PROJECT  || "(ADC auto-detect)",
      location: config.GOOGLE_CLOUD_LOCATION,
      model   : config.GEMINI_MODEL,
    },
  });
});
