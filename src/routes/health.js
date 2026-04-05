"use strict";

/**
 * src/routes/health.js
 *
 * Health-check route for Cloud Run / load balancers.
 *
 * GET /health  →  200 { status, uptime, sessions, … }
 * GET /        →  200 text banner
 *
 * Cloud Run uses the /health path for liveness & readiness probes.
 * Configure it in cloudbuild.yaml or service YAML:
 *   livenessProbe:
 *     httpGet:
 *       path: /health
 */

const sessionStore     = require("../services/sessionStore");
const agentBroadcaster = require("../services/agentBroadcaster");
const { config }       = require("../config");

const START_TIME = Date.now();

/**
 * Attach health routes to an existing http.Server request listener.
 * Returns the handler function; the caller decides how to compose it.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 * @returns {boolean} true if the request was handled
 */
function handleHttpRequest(req, res) {
  if (req.method !== "GET") return false;

  if (req.url === "/health" || req.url === "/healthz") {
    const body = JSON.stringify({
      status     : "ok",
      version    : process.env.K_REVISION || "local",   // Cloud Run sets K_REVISION
      uptime     : Math.round((Date.now() - START_TIME) / 1000),
      sessions   : sessionStore.stats(),
      agentClients: agentBroadcaster.totalClients(),
      env        : config.NODE_ENV,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return true;
  }

  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Agent Assist — Genesys AudioHook + Gemini Live\n");
    return true;
  }

  // Serve the Agent UI HTML from /ui path
  if (req.url === "/ui" || req.url === "/ui/") {
    serveAgentUi(res);
    return true;
  }

  return false;  // not our request
}

function serveAgentUi(res) {
  const fs   = require("fs");
  const path = require("path");
  const file = path.resolve(__dirname, "../../agent-ui.html");

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

module.exports = { handleHttpRequest };
