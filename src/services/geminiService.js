"use strict";

/**
 * src/services/geminiService.js
 *
 * Authentication: Vertex AI via Application Default Credentials (ADC).
 * The @google/genai SDK auto-detects Vertex AI when these env vars are set:
 *   GOOGLE_GENAI_USE_VERTEXAI=true
 *   GOOGLE_CLOUD_PROJECT=<project-id>
 *   GOOGLE_CLOUD_LOCATION=<region>   (default: us-central1)
 *
 * On Cloud Run the service account attached to the revision IS the credential.
 * Locally run: gcloud auth application-default login
 *
 * Encapsulates all interaction with the Gemini Live API.
 * Responsibilities:
 *   - Connect a live session (one per Genesys call)
 *   - Send real-time audio chunks
 *   - Handle tool calls → process structured agent-assist updates
 *   - Generate post-call summary (one-shot REST call)
 *   - Return a clean interface the AudioHook handler uses
 */

"use strict";

const { GoogleGenAI, Modality } = require("@google/genai");
const { config }         = require("../config");

// Ensure the SDK uses Vertex AI. These env vars are also set in .env.example
// and injected automatically by Cloud Run via the service definition.
process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
// GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are already in env
const logger             = require("../utils/logger").child("Gemini");
const agentBroadcaster   = require("./agentBroadcaster");
const { pushToCRM }      = require("./crmService");
const sessionStore       = require("./sessionStore");

// GoogleGenAI with no arguments picks up the three Vertex AI env vars above
// and uses Application Default Credentials — no API key required.
const genai = new GoogleGenAI({
  vertexai: true,
  project : config.GOOGLE_CLOUD_PROJECT  || undefined,
  location: config.GOOGLE_CLOUD_LOCATION || "us-central1",
});

// ──────────────────────────────────────────────────────────────────────────────
//  System prompt
// ──────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are an AI assistant helping a contact center agent in real time.

As you hear the customer speaking, call the update_agent_assist function with:
1. transcript_line: the latest sentence spoken (speaker=customer or agent)
2. suggestions: 2-3 actions the agent should take RIGHT NOW based on what was just said
3. crm_updates: any entities or intents you can extract (account numbers, addresses, products, etc.)

Suggestion types:
- "action"     = something the agent should do now (pull up account, offer refund, transfer call)
- "kb_article" = a knowledge base article title that would help answer the customer's question
- "script"     = a specific script line the agent could say verbatim
- "escalate"   = escalation recommendation with reason

Be concise. Call the function after every complete customer utterance.
Detect sentiment changes immediately — if the customer becomes frustrated, set urgency to "high".

Example: if customer says "I've been waiting 3 weeks for my refund and nobody is helping me!"
→ suggestions: [{type:"action", title:"Initiate refund trace", urgency:"high"}, {type:"script", title:"Apologize and take ownership", detail:"I sincerely apologize for the delay. Let me personally look into your refund right now.", urgency:"high"}]
→ crm_updates: {sentiment:"frustrated", intent:"refund_inquiry"}
`.trim();

// ──────────────────────────────────────────────────────────────────────────────
//  Tool declaration
// ──────────────────────────────────────────────────────────────────────────────
const AGENT_ASSIST_TOOL = {
  functionDeclarations: [{
    name       : "update_agent_assist",
    description: "Send real-time suggestions and CRM updates to the agent",
    parameters : {
      type      : "object",
      properties: {
        transcript_line: {
          type      : "object",
          description: "The latest transcribed line",
          properties : {
            speaker: { type: "string", enum: ["customer", "agent"] },
            text   : { type: "string" },
          },
          required: ["speaker", "text"],
        },
        suggestions: {
          type : "array",
          description: "2-3 actionable suggestions for the agent right now",
          items: {
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
  }],
};

// ──────────────────────────────────────────────────────────────────────────────
//  Session shape (owned by AudioHook handler, passed in here)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * @typedef {object} Session
 * @property {string}  id
 * @property {string|null} conversationId
 * @property {object|null} geminiSession      Live session handle
 * @property {boolean}     geminiReady
 * @property {Buffer[]}    audioBuffer
 * @property {object|null} mediaFormat
 * @property {object[]}    transcript
 * @property {object}      uiState
 */

// ──────────────────────────────────────────────────────────────────────────────
//  Connect
// ──────────────────────────────────────────────────────────────────────────────
async function connectGemini(session) {
  const sid = session.id.slice(0, 8);
  try {
    const liveSession = await genai.live.connect({
      model : config.GEMINI_MODEL,
      config: {
        responseModalities      : [Modality.TEXT],
        systemInstruction       : { parts: [{ text: SYSTEM_PROMPT }] },
        inputAudioTranscription : {},
        outputAudioTranscription: {},
        tools                   : [AGENT_ASSIST_TOOL],
      },
      callbacks: {
        onopen   : ()    => {
          session.geminiReady = true;
          _onOpen(session);
        },
        onmessage: (msg) => _onMessage(session, msg),
        onerror  : (err) => logger.error("Gemini error", { sid, errorId: err?.id, error: err?.message, details: err }),
        onclose  : ()    => { session.geminiReady = false; logger.info("Gemini closed", { sid }); },
      },
    });

    session.geminiSession = liveSession;
    logger.info("Vertex AI Gemini session created", {
      sid,
      project : config.GOOGLE_CLOUD_PROJECT,
      location: config.GOOGLE_CLOUD_LOCATION,
      model   : config.GEMINI_MODEL,
    });
  } catch (err) {
    logger.error("Gemini connect failed", { sid, error: err.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Send audio
// ──────────────────────────────────────────────────────────────────────────────
function sendAudio(session, pcm16Buffer) {
  if (!session.geminiSession || !session.geminiReady) return;
  try {
    // Trying 'media' key as suggested by the error "Media is required."
    session.geminiSession.sendRealtimeInput({
      media: [{
        mimeType: "audio/pcm;rate=16000",
        data: pcm16Buffer.toString("base64")
      }]
    });
  } catch (err) {
    logger.error("sendRealtimeInput failed", { sid: session.id.slice(0, 8), error: err.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Post-call summary
// ──────────────────────────────────────────────────────────────────────────────
async function generateSummary(session) {
  if (!session.transcript.length) return;
  const sid = session.id.slice(0, 8);

  const transcriptText = session.transcript
    .map(l => `${l.speaker}: ${l.text}`)
    .join("\n");

  try {
    const result = await genai.models.generateContent({
      model   : config.GEMINI_SUMMARY_MODEL,  // one-shot REST call, not live
      contents: [{
        role : "user",
        parts: [{ text: `Summarize this call in 2-3 sentences and list the resolution:\n\n${transcriptText}` }],
      }],
    });

    const summary = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    session.uiState.crmFields.summary = summary;

    agentBroadcaster.broadcast(session.conversationId, {
      type: "call_summary",
      data: { summary, crmFields: session.uiState.crmFields },
    });

    await pushToCRM(session.conversationId, { ...session.uiState.crmFields, summary });
    logger.info("Call summary generated", { sid });
  } catch (err) {
    logger.error("Summary generation failed", { sid, error: err.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Internal callbacks
// ──────────────────────────────────────────────────────────────────────────────
async function _onOpen(session) {
  const sid = session.id.slice(0, 8);
  
  // Wait up to 2s for geminiSession to be assigned by the caller (race condition fix)
  let attempts = 0;
  while (!session.geminiSession && attempts < 20) {
    await new Promise(r => setTimeout(r, 100));
    attempts++;
  }

  if (!session.geminiSession) {
    logger.error("Gemini session never initialized (timeout)", { sid });
    return;
  }

  logger.info("Gemini ready — flushing audio buffer", { sid, buffered: session.audioBuffer.length });
  for (const chunk of session.audioBuffer) sendAudio(session, chunk);
  session.audioBuffer = [];
}

function _onMessage(session, message) {
  // Structured tool-call output
  if (message.toolCall) {
    for (const fc of message.toolCall.functionCalls) {
      if (fc.name === "update_agent_assist") {
        _processAssistUpdate(session, fc.input, fc.id);
      }
    }
  }

  // Raw transcription fallback (fires when the tool call doesn't)
  const inputText = message.serverContent?.inputTranscription?.text;
  if (inputText?.trim()) _appendTranscript(session, "customer", inputText.trim());

  const outputText = message.serverContent?.outputTranscription?.text;
  if (outputText?.trim()) _appendTranscript(session, "agent", outputText.trim());
}

function _processAssistUpdate(session, input, toolCallId) {
  const convId = session.conversationId;

  if (input.transcript_line) {
    _appendTranscript(session, input.transcript_line.speaker, input.transcript_line.text);
  }

  if (input.suggestions?.length) {
    session.uiState.suggestions = input.suggestions;
    agentBroadcaster.broadcast(convId, { type: "suggestions", data: input.suggestions });
  }

  if (input.crm_updates) {
    const crm = session.uiState.crmFields;
    if (input.crm_updates.intent)    crm.intent    = input.crm_updates.intent;
    if (input.crm_updates.sentiment) crm.sentiment = input.crm_updates.sentiment;
    if (input.crm_updates.entities)  Object.assign(crm.entities, input.crm_updates.entities);

    agentBroadcaster.broadcast(convId, { type: "crm_update", data: crm });
    pushToCRM(convId, crm);   // fire-and-forget; errors logged inside pushToCRM
  }

  // Close the tool-call loop (required by Gemini SDK)
  if (session.geminiSession && session.geminiReady) {
    session.geminiSession.sendToolResponse({
      functionResponses: [{ id: toolCallId, name: "update_agent_assist", response: { ok: true } }],
    }).catch((err) => logger.warn("sendToolResponse failed", { error: err.message }));
  }
}

function _appendTranscript(session, speaker, text) {
  const line = { speaker, text, timestamp: new Date().toISOString() };
  session.transcript.push(line);
  if (session.transcript.length > config.TRANSCRIPT_MAX_LINES) session.transcript.shift();

  session.uiState.transcript = session.transcript;
  agentBroadcaster.broadcast(session.conversationId, { type: "transcript_line", data: line });
  logger.debug(`${speaker.toUpperCase()}: "${text}"`, { conversationId: session.conversationId });
}

module.exports = { connectGemini, sendAudio, generateSummary };
