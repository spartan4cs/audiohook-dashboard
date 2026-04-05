"use strict";

/**
 * src/services/agentBroadcaster.js
 *
 * Maintains a registry of Agent UI WebSocket connections, keyed by
 * conversationId. Provides a simple broadcast API.
 *
 * Isolated here so the AudioHook handler never touches WebSocket objects
 * directly and so this can be mocked in tests.
 */

const WebSocket = require("ws");
const logger    = require("../utils/logger").child("Broadcaster");

/** @type {Map<string, Set<WebSocket>>} */
const clients = new Map();

const agentBroadcaster = {
  /**
   * Register a new Agent UI connection.
   * @param {string}    conversationId
   * @param {WebSocket} ws
   */
  add(conversationId, ws) {
    if (!clients.has(conversationId)) clients.set(conversationId, new Set());
    clients.get(conversationId).add(ws);
    logger.info("Agent UI joined", { conversationId, total: clients.get(conversationId).size });
  },

  /**
   * Remove a disconnected Agent UI connection.
   * @param {string}    conversationId
   * @param {WebSocket} ws
   */
  remove(conversationId, ws) {
    const set = clients.get(conversationId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) clients.delete(conversationId);
  },

  /**
   * Broadcast a plain object (will be JSON-serialised) to all connected
   * agent browsers for the given conversation.
   * @param {string} conversationId
   * @param {object} message
   */
  broadcast(conversationId, message) {
    const set = clients.get(conversationId);
    if (!set || set.size === 0) return;

    const json = JSON.stringify(message);
    let sent = 0;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
        sent++;
      }
    }
    if (sent > 0) {
      logger.debug("Broadcast sent", { conversationId, recipients: sent, type: message.type });
    }
  },

  /** @returns {number} */
  totalClients() {
    let total = 0;
    for (const set of clients.values()) total += set.size;
    return total;
  },
};

module.exports = agentBroadcaster;
