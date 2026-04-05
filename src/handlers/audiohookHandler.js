"use strict";

/**
 * src/handlers/audiohookHandler.js
 *
 * Manages the Genesys AudioHook WebSocket lifecycle for a single call.
 *
 * Protocol flow:
 *   Genesys → probe  → server replies probe
 *   Genesys → open   → server replies opened (auth + media negotiation)
 *   Genesys → binary audio frames (PCMU)
 *   Genesys → ping   → server replies pong
 *   Genesys → pause/resume
 *   Genesys → close  → server replies closed → cleanup
 */

const crypto           = require("crypto");
const WebSocket        = require("ws");
const { config }       = require("../config");
const logger           = require("../utils/logger").child("AudioHook");
const { convertToPcm16_16k } = require("../utils/audio");
const sessionStore     = require("../services/sessionStore");
const agentBroadcaster = require("../services/agentBroadcaster");
const { connectGemini, sendAudio, generateSummary } = require("../services/geminiService");

// ── Session factory ───────────────────────────────────────────────────────────
function _createSession(ws) {
  return {
    id            : crypto.randomUUID(),
    ws,
    conversationId: null,
    geminiSession : null,
    geminiReady   : false,
    audioBuffer   : [],
    mediaFormat   : null,
    state         : "idle",     // idle | open | paused | closing

    transcript: [],             // rolling transcript (capped by config)

    uiState: {
      transcript : [],
      suggestions: [],
      crmFields  : {
        intent   : null,
        sentiment: null,
        entities : {},
        summary  : null,
      },
    },

    /** Close the Gemini session and remove from store. */
    cleanup() {
      if (this.geminiSession) {
        try { this.geminiSession.close(); } catch (_) {}
        this.geminiSession = null;
      }
      if (this.conversationId) sessionStore.delete(this.conversationId);
    },

    /** Safe JSON send to Genesys. */
    send(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
  };
}

const _sid = (s) => s.id.slice(0, 8);

/**
 * Build a properly-framed Genesys AudioHook response.
 *
 * Genesys protocol seq semantics:
 *   seq      (in our response)  = OUR OWN incrementing counter (not echoed)
 *   clientseq (in our response) = echo of the client's seq from their request
 *   serverseq is sent BY THE CLIENT to ack our last seq — we do NOT send it
 */
function _reply(session, inMsg, fields) {
  session._serverseq = (session._serverseq || 0) + 1;
  return {
    version  : "2",
    id       : inMsg.id,            // echo the request id
    seq      : session._serverseq,  // OUR own counter (1, 2, 3…)
    clientseq: inMsg.seq,           // REQUIRED: echo of client's seq
    ...fields,
  };
}
// ── Control message dispatch ──────────────────────────────────────────────────
function _handleControl(session, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const sid = _sid(session);

  switch (msg.type) {
    case "probe":
      session.send(_reply(session, msg, { type: "probe" }));
      break;

    case "open":
      _handleOpen(session, msg).catch((err) =>
        logger.error("handleOpen error", { sid, error: err.message })
      );
      break;

    case "ping":
      session.send(_reply(session, msg, { type: "pong" }));
      break;

    case "pause":
    case "paused":
      session.state = "paused";
      if (msg.type === "pause") {
        session.send(_reply(session, msg, { type: "paused" }));
      }
      logger.info("Session paused", { sid });
      break;

    case "resume":
    case "resumed":
      session.state = "open";
      if (msg.type === "resume") {
        session.send(_reply(session, msg, { type: "resumed" }));
      }
      logger.info("Session resumed", { sid });
      break;

    case "close":
      session.state = "closing";
      session.send(_reply(session, msg, { type: "closed" }));
      _finalise(session);
      break;

    case "error":
      logger.warn("Genesys error", { sid, code: msg.parameters?.code, message: msg.parameters?.message });
      break;

    case "disconnect":
      logger.info("Genesys disconnect", { sid });
      session.state = "closing";
      break;

    case "info":
      logger.debug("Genesys info", { sid, raw: msg });
      break;

    default:
      logger.warn("Unknown control message", { sid, type: msg.type, raw: msg });
  }
}

// ── Open handshake ────────────────────────────────────────────────────────────
async function _handleOpen(session, msg) {
  const params = msg.parameters || {};
  const sid    = _sid(session);

  // ── Authentication ────────────────────────────────────────
  if (config.AUDIOHOOK_API_KEY !== "dev-key" && params.apiKey !== config.AUDIOHOOK_API_KEY) {
    logger.warn("Unauthorized connection attempt", { sid, remoteKey: params.apiKey });
    session.send({ type: "error", code: 401, message: "Unauthorized", seq: msg.seq });
    session.ws.close(4001, "Unauthorized");
    return;
  }

  session.conversationId = params.conversationId || crypto.randomUUID();
  sessionStore.set(session.conversationId, session);

  // ── Media negotiation ─────────────────────────────────────
  const offered  = params.media || [];
  const selected = offered[0] || { type: "audio", format: "PCMU", rate: 8000, channels: ["external"] };
  session.mediaFormat = selected;
  session.state       = "open";

  // Genesys requires version, id (echoed), clientseq, serverseq, and startPaused
  session.send(_reply(session, msg, {
    type      : "opened",
    parameters: {
      media      : [selected],
      startPaused: false,
    },
  }));
  logger.info("Session opened", { sid, conversationId: session.conversationId, format: selected.format });

  // Notify any waiting Agent UI browsers
  agentBroadcaster.broadcast(session.conversationId, {
    type: "call_started",
    data: { conversationId: session.conversationId, timestamp: new Date().toISOString() },
  });

  // Bootstrap Gemini Live session
  await connectGemini(session);
}

// ── Audio data ────────────────────────────────────────────────────────────────
function _handleAudio(session, data) {
  if (session.state !== "open") return;

  const pcm16 = convertToPcm16_16k(data, session.mediaFormat);

  if (!session.geminiReady) {
    session.audioBuffer.push(pcm16);
    return;
  }
  sendAudio(session, pcm16);
}

// ── Finalise ──────────────────────────────────────────────────────────────────
function _finalise(session) {
  // Guard: ws.on("close") and protocol "close" message can both fire — only run once
  if (session.state === "finalized") return;
  session.state = "finalized";

  const sid = _sid(session);
  logger.info("Finalising session", { sid, transcriptLines: session.transcript.length });

  // Fire-and-forget summary generation
  if (session.transcript.length > 0) {
    generateSummary(session).catch((err) =>
      logger.error("Summary error", { sid, error: err.message })
    );
  }

  // Notify agent UI
  if (session.conversationId) {
    agentBroadcaster.broadcast(session.conversationId, { type: "call_ended" });
  }

  session.cleanup();
}

// ── Public: attach to a WebSocket connection ──────────────────────────────────
/**
 * @param {WebSocket} ws
 * @param {import('http').IncomingMessage} req
 */
function handleAudiohookConnection(ws, req) {
  const session = _createSession(ws);
  logger.info("Genesys connected", { sid: _sid(session), ip: req.socket.remoteAddress });

  ws.on("message", (data, isBinary) => {
    if (isBinary) _handleAudio(session, data);
    else _handleControl(session, data.toString());
  });

  ws.on("close", (code, reason) => {
    logger.info("WebSocket closed", { sid: _sid(session), code, reason: reason?.toString() });
    _finalise(session);
  });

  ws.on("error", (err) => {
    logger.error("WebSocket error", { sid: _sid(session), error: err.message });
    _finalise(session);
  });
}

module.exports = { handleAudiohookConnection };
