"use strict";

/**
 * src/services/sessionStore.js
 *
 * In-memory session store.
 * Keyed by conversationId after the AudioHook `open` handshake.
 *
 * For multi-instance Cloud Run deployments this should be replaced with
 * a Redis-backed store (e.g. @google-cloud/redis-client or ioredis).
 * The interface is intentionally identical so the swap is a one-liner.
 */

const logger = require("../utils/logger").child("SessionStore");

/** @type {Map<string, import('./session').Session>} */
const store = new Map();

/** Metrics — surfaced on /health */
let totalCreated  = 0;
let totalFinished = 0;

const sessionStore = {
  /**
   * @param {string} id  conversationId
   * @param {object} session
   */
  set(id, session) {
    store.set(id, session);
    totalCreated++;
    logger.debug("Session added", { conversationId: id, active: store.size });
  },

  /** @param {string} id */
  get(id) {
    return store.get(id);
  },

  /** @param {string} id */
  delete(id) {
    store.delete(id);
    totalFinished++;
    logger.debug("Session removed", { conversationId: id, active: store.size });
  },

  /** @returns {number} */
  size() {
    return store.size;
  },

  stats() {
    return {
      active  : store.size,
      created : totalCreated,
      finished: totalFinished,
    };
  },
};

module.exports = sessionStore;
