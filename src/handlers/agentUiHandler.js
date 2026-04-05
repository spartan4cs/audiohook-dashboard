"use strict";

/**
 * src/handlers/agentUiHandler.js
 *
 * Manages Agent UI WebSocket connections.
 * When a browser connects it is registered with the broadcaster so it can
 * receive real-time updates for its conversation.
 *
 * URL: wss://<host>/agent-ui?conversationId=<id>
 */

const logger           = require("../utils/logger").child("AgentUI");
const agentBroadcaster = require("../services/agentBroadcaster");
const sessionStore     = require("../services/sessionStore");

/**
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} req
 */
function handleAgentUiConnection(ws, req) {
  const url    = new URL(req.url, "http://localhost");
  const convId = url.searchParams.get("conversationId") || "default";

  logger.info("Agent UI connected", { conversationId: convId });
  agentBroadcaster.add(convId, ws);

  // Replay current state if the agent refreshes mid-call
  const existing = sessionStore.get(convId);
  if (existing) {
    try {
      ws.send(JSON.stringify({ type: "session_state", data: existing.uiState }));
    } catch (_) { /* ws may already be closing */ }
  }

  ws.on("close", () => {
    logger.info("Agent UI disconnected", { conversationId: convId });
    agentBroadcaster.remove(convId, ws);
  });

  ws.on("error", (err) => {
    logger.warn("Agent UI error", { conversationId: convId, error: err.message });
    agentBroadcaster.remove(convId, ws);
  });
}

module.exports = { handleAgentUiConnection };
