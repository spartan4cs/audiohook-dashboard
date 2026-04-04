/**
 * ============================================================
 *  Agent Assist Server  —  Genesys AudioHook + Gemini Live
 * ============================================================
 *  What this does:
 *   1. Receives real-time audio from Genesys AudioHook (WSS)
 *   2. Converts PCMU → PCM16 16kHz and streams to Gemini Live
 *   3. Gemini returns: transcripts + AI suggestions + CRM fields
 *   4. Broadcasts everything to the Agent UI via a second WSS endpoint
 *
 *  Endpoints:
 *   wss://<host>/api/v1/audiohook/ws   ← Genesys connects here
 *   wss://<host>/agent-ui              ← Agent browser connects here
 *   http://<host>/health               ← Health check
 */

"use strict";

require("dotenv").config();
const http      = require("http");
const WebSocket = require("ws");
const crypto    = require("crypto");
const { GoogleGenAI, Modality } = require("@google/genai");

// ─── Config ────────────────────────────────────────────────
const CONFIG = {
  PORT           : process.env.PORT                || 3000,
  AUDIOHOOK_PATH : "/api/v1/audiohook/ws",
  AGENT_UI_PATH  : "/agent-ui",
  API_KEY        : process.env.AUDIOHOOK_API_KEY        || "dev-key",
  GEMINI_API_KEY : process.env.GEMINI_API_KEY           || "",
  GEMINI_MODEL   : "gemini-2.0-flash-live-001",
};

const genai = new GoogleGenAI({ apiKey: CONFIG.GEMINI_API_KEY });

// ─── HTTP server ───────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Agent Assist Server — Genesys AudioHook + Gemini Live\n");
});

// ─── Two WebSocket servers on the same HTTP server ─────────
const wssGenesys = new WebSocket.Server({ noServer: true });
const wssAgentUI = new WebSocket.Server({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://localhost`);

  if (url.pathname === CONFIG.AUDIOHOOK_PATH) {
    wssGenesys.handleUpgrade(request, socket, head, (ws) => {
      wssGenesys.emit("connection", ws, request);
    });
  } else if (url.pathname === CONFIG.AGENT_UI_PATH) {
    wssAgentUI.handleUpgrade(request, socket, head, (ws) => {
      wssAgentUI.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ─── Session store: conversationId → Session ───────────────
const sessions = new Map();

// ─── Agent UI connections: conversationId → Set<WebSocket> ─
const agentUiClients = new Map();  // conversationId → Set<ws>

// ═══════════════════════════════════════════════════════════
//  Agent UI WebSocket — browser connects here
// ═══════════════════════════════════════════════════════════
wssAgentUI.on("connection", (ws, req) => {
  const url   = new URL(req.url, "http://localhost");
  const convId = url.searchParams.get("conversationId") || "default";

  console.log(`[AgentUI] Browser connected for conversation: ${convId}`);

  if (!agentUiClients.has(convId)) {
    agentUiClients.set(convId, new Set());
  }
  agentUiClients.get(convId).add(ws);

  // Send current state if session already exists
  const session = sessions.get(convId);
  if (session) {
    ws.send(JSON.stringify({ type: "session_state", data: session.uiState }));
  }

  ws.on("close", () => {
    agentUiClients.get(convId)?.delete(ws);
  });
});

// Broadcast a message to all agent UIs for a conversation
function broadcastToAgents(conversationId, message) {
  const clients = agentUiClients.get(conversationId);
  if (!clients) return;
  const json = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

// ═══════════════════════════════════════════════════════════
//  Genesys AudioHook WebSocket
// ═══════════════════════════════════════════════════════════
wssGenesys.on("connection", (ws, req) => {
  console.log(`[AudioHook] Genesys connected from ${req.socket.remoteAddress}`);
  const session = createSession(ws);

  ws.on("message", (data, isBinary) => {
    if (isBinary) handleAudioChunk(session, data);
    else handleControlMessage(session, data.toString());
  });

  ws.on("close", () => {
    console.log(`[AudioHook][${sid(session)}] Closed`);
    finaliseSession(session);
  });

  ws.on("error", (err) => {
    console.error(`[AudioHook][${sid(session)}] Error:`, err.message);
    finaliseSession(session);
  });
});

// ─── Session ───────────────────────────────────────────────
function createSession(ws) {
  const session = {
    id             : crypto.randomUUID(),
    ws,
    conversationId : null,
    geminiSession  : null,
    geminiReady    : false,
    audioBuffer    : [],
    mediaFormat    : null,
    state          : "idle",

    // Rolling transcript (last 30 utterances)
    transcript: [],

    // What we broadcast to the Agent UI
    uiState: {
      transcript  : [],
      suggestions : [],
      crmFields   : {
        intent    : null,
        sentiment : null,
        entities  : {},
        summary   : null,
      },
    },

    cleanup() {
      if (this.geminiSession) {
        try { this.geminiSession.close(); } catch (_) {}
        this.geminiSession = null;
      }
      if (this.conversationId) sessions.delete(this.conversationId);
    },

    send(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
  };
  return session;
}

const sid = (s) => s.id.slice(0, 8);

// ─── AudioHook control messages ────────────────────────────
function handleControlMessage(session, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {
    case "probe":
      session.send({ type: "probe" });
      break;

    case "open":
      handleOpen(session, msg);
      break;

    case "ping":
      session.send({ type: "pong", seq: msg.seq, clientseq: msg.seq });
      break;

    case "pause":
      session.state = "paused";
      session.send({ type: "paused", seq: msg.seq });
      break;

    case "resume":
      session.state = "open";
      session.send({ type: "resumed", seq: msg.seq });
      break;

    case "close":
      session.state = "closing";
      session.send({ type: "closed", seq: msg.seq });
      finaliseSession(session);
      break;

    default:
      console.log(`[AudioHook][${sid(session)}] Unhandled: ${msg.type}`);
  }
}

// ─── Open handshake ────────────────────────────────────────
async function handleOpen(session, msg) {
  const params = msg.parameters || {};

  // Auth
  if (CONFIG.API_KEY !== "dev-key" && params.apiKey !== CONFIG.API_KEY) {
    session.send({ type: "error", code: 401, message: "Unauthorized", seq: msg.seq });
    session.ws.close(4001, "Unauthorized");
    return;
  }

  session.conversationId = params.conversationId || crypto.randomUUID();
  sessions.set(session.conversationId, session);

  // Media negotiation
  const offered = params.media || [];
  const selected = offered[0] || { type: "audio", format: "PCMU", rate: 8000, channels: ["external"] };
  session.mediaFormat = selected;
  session.state = "open";

  session.send({
    type      : "opened",
    seq       : msg.seq,
    parameters: { media: [selected] },
  });

  console.log(`[AudioHook][${sid(session)}] Opened conv=${session.conversationId}`);

  // Notify agent UI that a call started
  broadcastToAgents(session.conversationId, {
    type : "call_started",
    data : { conversationId: session.conversationId, timestamp: new Date().toISOString() },
  });

  // Connect to Gemini
  await connectGemini(session);
}

function finaliseSession(session) {
  // Trigger post-call summary
  if (session.transcript.length > 0) {
    generateCallSummary(session);
  }
  session.cleanup();
}

// ─── Audio handling ────────────────────────────────────────
function handleAudioChunk(session, data) {
  if (session.state !== "open") return;

  const pcm16 = convertToPcm16_16k(data, session.mediaFormat);

  if (!session.geminiReady) {
    session.audioBuffer.push(pcm16);
    return;
  }
  sendAudioToGemini(session, pcm16);
}

// ═══════════════════════════════════════════════════════════
//  Gemini Live — Agent Assist brain
// ═══════════════════════════════════════════════════════════
async function connectGemini(session) {
  try {
    const liveSession = await genai.live.connect({
      model : CONFIG.GEMINI_MODEL,
      config: {
        responseModalities: [Modality.TEXT],   // Text-only for agent assist
        systemInstruction : {
          parts: [{
            text: SYSTEM_PROMPT,
          }],
        },
        inputAudioTranscription : {},
        outputAudioTranscription: {},

        // Function declarations for structured output
        tools: [{
          functionDeclarations: [
            {
              name       : "update_agent_assist",
              description: "Send real-time suggestions and CRM updates to the agent",
              parameters : {
                type      : "object",
                properties: {
                  transcript_line: {
                    type       : "object",
                    description: "The latest transcribed line",
                    properties : {
                      speaker: { type: "string", enum: ["customer", "agent"] },
                      text   : { type: "string" },
                    },
                    required: ["speaker", "text"],
                  },
                  suggestions: {
                    type       : "array",
                    description: "2-3 actionable suggestions for the agent right now",
                    items      : {
                      type      : "object",
                      properties: {
                        type   : { type: "string", enum: ["action", "kb_article", "script", "escalate"] },
                        title  : { type: "string" },
                        detail : { type: "string" },
                        urgency: { type: "string", enum: ["low", "medium", "high"] },
                      },
                      required: ["type", "title"],
                    },
                  },
                  crm_updates: {
                    type      : "object",
                    properties: {
                      intent   : { type: "string", description: "Primary customer intent" },
                      sentiment: { type: "string", enum: ["positive", "neutral", "frustrated", "angry"] },
                      entities : {
                        type      : "object",
                        description: "Key entities: account_number, product, address, amount, etc.",
                        additionalProperties: { type: "string" },
                      },
                    },
                  },
                },
                required: ["transcript_line"],
              },
            },
          ],
        }],
      },

      callbacks: {
        onopen   : ()       => onGeminiOpen(session),
        onmessage: (msg)    => onGeminiMessage(session, msg),
        onerror  : (err)    => console.error(`[Gemini][${sid(session)}]`, err),
        onclose  : ()       => { session.geminiReady = false; },
      },
    });

    session.geminiSession = liveSession;
  } catch (err) {
    console.error(`[Gemini][${sid(session)}] Connect failed:`, err.message);
  }
}

function onGeminiOpen(session) {
  console.log(`[Gemini][${sid(session)}] Ready`);
  session.geminiReady = true;

  // Flush buffered audio
  for (const chunk of session.audioBuffer) sendAudioToGemini(session, chunk);
  session.audioBuffer = [];
}

function onGeminiMessage(session, message) {
  // Handle tool calls (structured output from Gemini)
  if (message.toolCall) {
    for (const fc of message.toolCall.functionCalls) {
      if (fc.name === "update_agent_assist") {
        processAgentAssistUpdate(session, fc.input, fc.id);
      }
    }
  }

  // Handle raw transcription fallback (if tool call didn't fire)
  if (message.serverContent?.inputTranscription?.text) {
    const text = message.serverContent.inputTranscription.text;
    if (text.trim()) {
      appendTranscript(session, "customer", text);
    }
  }

  if (message.serverContent?.outputTranscription?.text) {
    const text = message.serverContent.outputTranscription.text;
    if (text.trim()) {
      appendTranscript(session, "agent", text);
    }
  }
}

// ─── Process a structured update from Gemini ───────────────
function processAgentAssistUpdate(session, input, toolCallId) {
  const convId = session.conversationId;

  // 1. Transcript line
  if (input.transcript_line) {
    appendTranscript(session, input.transcript_line.speaker, input.transcript_line.text);
  }

  // 2. Suggestions
  if (input.suggestions?.length) {
    session.uiState.suggestions = input.suggestions;
    broadcastToAgents(convId, {
      type: "suggestions",
      data: input.suggestions,
    });
  }

  // 3. CRM updates
  if (input.crm_updates) {
    const crm = session.uiState.crmFields;
    if (input.crm_updates.intent)    crm.intent    = input.crm_updates.intent;
    if (input.crm_updates.sentiment) crm.sentiment  = input.crm_updates.sentiment;
    if (input.crm_updates.entities)  Object.assign(crm.entities, input.crm_updates.entities);

    broadcastToAgents(convId, {
      type: "crm_update",
      data: crm,
    });

    // In production: push to CRM via API
    pushToCRM(session, crm);
  }

  // Respond to Gemini (required to close the tool call)
  if (session.geminiSession && session.geminiReady) {
    session.geminiSession.sendToolResponse({
      functionResponses: [{ id: toolCallId, name: "update_agent_assist", response: { ok: true } }],
    }).catch(() => {});
  }
}

// ─── Append transcript line ─────────────────────────────────
function appendTranscript(session, speaker, text) {
  const line = { speaker, text, timestamp: new Date().toISOString() };
  session.transcript.push(line);
  if (session.transcript.length > 30) session.transcript.shift();

  session.uiState.transcript = session.transcript;
  broadcastToAgents(session.conversationId, { type: "transcript_line", data: line });

  console.log(`[Transcript][${sid(session)}] ${speaker.toUpperCase()}: "${text}"`);
}

// ─── Post-call summary ─────────────────────────────────────
async function generateCallSummary(session) {
  if (!session.transcript.length) return;

  const transcriptText = session.transcript
    .map(l => `${l.speaker}: ${l.text}`)
    .join("\n");

  try {
    // One-shot call for summary (not live)
    const result = await genai.models.generateContent({
      model   : "gemini-2.0-flash",
      contents: [{
        role : "user",
        parts: [{ text: `Summarize this call in 2-3 sentences and list the resolution:\n\n${transcriptText}` }],
      }],
    });

    const summary = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    session.uiState.crmFields.summary = summary;

    broadcastToAgents(session.conversationId, {
      type: "call_summary",
      data: { summary, crmFields: session.uiState.crmFields },
    });

    // Push final summary to CRM
    pushToCRM(session, { ...session.uiState.crmFields, summary });
  } catch (err) {
    console.error("[Summary] Error:", err.message);
  }
}

// ─── CRM integration stub ──────────────────────────────────
async function pushToCRM(session, fields) {
  // Replace with real CRM API calls:
  //   Salesforce: PATCH /services/data/v60.0/sobjects/Case/{caseId}
  //   ServiceNow: PATCH /api/now/table/incident/{sysId}
  console.log(`[CRM][${sid(session)}] Would update:`, JSON.stringify(fields));
}

// ─── Send audio to Gemini ───────────────────────────────────
function sendAudioToGemini(session, pcm16Buffer) {
  if (!session.geminiSession || !session.geminiReady) return;
  try {
    session.geminiSession.sendRealtimeInput({
      audio: {
        data    : pcm16Buffer.toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
  } catch (err) {
    console.error("[Gemini] sendRealtimeInput:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  Audio conversion utilities
// ═══════════════════════════════════════════════════════════
function convertToPcm16_16k(buffer, fmt) {
  const pcm8k = fmt?.format === "PCMU" ? decodeMuLaw(buffer) : buffer;
  return upsample8kTo16k(pcm8k);
}

function decodeMuLaw(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    let u        = buf[i] ^ 0xFF;
    const sign   = u & 0x80 ? -1 : 1;
    const exp    = (u >> 4) & 0x07;
    const mant   = u & 0x0F;
    let mag      = ((mant << 3) + 0x84) << exp;
    mag -= 0x84;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sign * mag)), i * 2);
  }
  return out;
}

function upsample8kTo16k(pcm8k) {
  const n   = pcm8k.length / 2;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s0 = pcm8k.readInt16LE(i * 2);
    const s1 = i + 1 < n ? pcm8k.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0, i * 4);
    out.writeInt16LE(Math.round((s0 + s1) / 2), i * 4 + 2);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  Gemini system prompt
// ═══════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `
You are an AI assistant helping a contact center agent in real time.

As you hear the customer speaking, call the update_agent_assist function with:
1. transcript_line: the latest sentence spoken (speaker=customer or agent)
2. suggestions: 2-3 actions the agent should take RIGHT NOW based on what was just said
3. crm_updates: any entities or intents you can extract (account numbers, addresses, products, etc.)

Suggestion types:
- "action" = something the agent should do (pull up account, offer refund, transfer call)
- "kb_article" = a knowledge base article title that would help answer the customer's question
- "script" = a specific script line the agent could say
- "escalate" = escalation recommendation with reason

Be concise. Call the function after every complete customer utterance.
Detect sentiment changes immediately — if the customer becomes frustrated, set urgency to "high".

Example: if the customer says "I've been waiting 3 weeks for my refund and nobody is helping me!"
→ suggestions: [{type:"action", title:"Initiate refund trace", urgency:"high"}, {type:"script", title:"Apologize and take ownership", detail:"I sincerely apologize for the delay. Let me personally look into your refund right now.", urgency:"high"}]
→ crm_updates: {sentiment:"frustrated", intent:"refund_inquiry"}
`;

// ─── Start ─────────────────────────────────────────────────
httpServer.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║          Agent Assist Server — Ready                     ║
╠══════════════════════════════════════════════════════════╣
║  AudioHook  : wss://localhost:${CONFIG.PORT}/api/v1/audiohook/ws  ║
║  Agent UI   : wss://localhost:${CONFIG.PORT}/agent-ui             ║
║  Health     : http://localhost:${CONFIG.PORT}/health              ║
╚══════════════════════════════════════════════════════════╝
`);
});
