"use strict";

/**
 * src/config/index.js
 * Central configuration — validated env-vars for Cloud Run + Vertex AI.
 *
 * Authentication strategy:
 *   - Vertex AI uses Application Default Credentials (ADC).
 *   - On Cloud Run the attached service account IS the credential — no key needed.
 *   - Locally: run `gcloud auth application-default login` once.
 *   - The @google/genai SDK reads three env vars automatically:
 *       GOOGLE_GENAI_USE_VERTEXAI=true
 *       GOOGLE_CLOUD_PROJECT=<project-id>
 *       GOOGLE_CLOUD_LOCATION=<region>          (default: us-central1)
 */

const config = {
  // ── Server ────────────────────────────────────────────────
  NODE_ENV  : process.env.NODE_ENV   || "development",
  PORT      : parseInt(process.env.PORT || "8080", 10),
  LOG_LEVEL : process.env.LOG_LEVEL  || "info",

  // ── Auth ──────────────────────────────────────────────────
  AUDIOHOOK_API_KEY: process.env.AUDIOHOOK_API_KEY || "dev-key",

  // ── Vertex AI ─────────────────────────────────────────────
  // These are read by the @google/genai SDK automatically when set;
  // we mirror them here so the server startup log can print them.
  GOOGLE_CLOUD_PROJECT : process.env.GOOGLE_CLOUD_PROJECT  || "",
  GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",

  // Model names — Vertex AI uses the same identifiers as the Dev API.
  GEMINI_MODEL        : process.env.GEMINI_MODEL         || "gemini-2.0-flash-live-001",
  GEMINI_SUMMARY_MODEL: process.env.GEMINI_SUMMARY_MODEL || "gemini-2.0-flash",

  // ── CRM ───────────────────────────────────────────────────
  CRM_ADAPTER: (process.env.CRM_ADAPTER || "mock").toLowerCase(),

  // Salesforce
  SF_INSTANCE_URL  : process.env.SF_INSTANCE_URL   || "",
  SF_CLIENT_ID     : process.env.SF_CLIENT_ID      || "",
  SF_CLIENT_SECRET : process.env.SF_CLIENT_SECRET  || "",

  // ServiceNow
  SNOW_INSTANCE_URL: process.env.SNOW_INSTANCE_URL || "",
  SNOW_USER        : process.env.SNOW_USER         || "",
  SNOW_PASSWORD    : process.env.SNOW_PASSWORD     || "",

  // HubSpot
  HUBSPOT_API_KEY  : process.env.HUBSPOT_API_KEY   || "",

  // ── WebSocket paths ───────────────────────────────────────
  AUDIOHOOK_PATH: "/api/v1/audiohook/ws",
  AGENT_UI_PATH : "/agent-ui",

  // Static file serving
  STATIC_PATH: "/ui",

  // ── Transcript window ─────────────────────────────────────
  TRANSCRIPT_MAX_LINES: parseInt(process.env.TRANSCRIPT_MAX_LINES || "50", 10),

  // ── Helpers ───────────────────────────────────────────────
  isProd() { return this.NODE_ENV === "production"; },
  isDev()  { return this.NODE_ENV === "development"; },
};

/**
 * Validate required env-vars. Called once at startup before anything else.
 * On Cloud Run an immediate exit here shows clearly in Cloud Logging.
 */
function validate() {
  const errors = [];

  if (config.isProd()) {
    // Project ID is always required for Vertex AI.
    if (!config.GOOGLE_CLOUD_PROJECT) errors.push("GOOGLE_CLOUD_PROJECT");

    // CRM-adapter–specific secrets
    if (config.CRM_ADAPTER === "salesforce") {
      if (!config.SF_INSTANCE_URL)  errors.push("SF_INSTANCE_URL");
      if (!config.SF_CLIENT_ID)     errors.push("SF_CLIENT_ID");
      if (!config.SF_CLIENT_SECRET) errors.push("SF_CLIENT_SECRET");
    }
    if (config.CRM_ADAPTER === "servicenow") {
      if (!config.SNOW_INSTANCE_URL) errors.push("SNOW_INSTANCE_URL");
      if (!config.SNOW_USER)         errors.push("SNOW_USER");
      if (!config.SNOW_PASSWORD)     errors.push("SNOW_PASSWORD");
    }
    if (config.CRM_ADAPTER === "hubspot") {
      if (!config.HUBSPOT_API_KEY) errors.push("HUBSPOT_API_KEY");
    }
  }

  if (errors.length) {
    throw new Error(
      `Missing required environment variable(s): ${errors.join(", ")}`
    );
  }
}

module.exports = { config, validate };
