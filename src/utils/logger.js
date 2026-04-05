"use strict";

/**
 * src/utils/logger.js
 *
 * Structured logger designed for Google Cloud Logging:
 *   - Production  → JSON to stdout (Cloud Run picks it up natively)
 *   - Development → human-readable coloured output
 *
 * Severity levels match Cloud Logging's enum so Log Explorer filters work.
 */

const { config } = require("../config");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.LOG_LEVEL] ?? LEVELS.info;

// ANSI colour helpers (dev only)
const COLOURS = {
  debug: "\x1b[36m",   // cyan
  info : "\x1b[32m",   // green
  warn : "\x1b[33m",   // yellow
  error: "\x1b[31m",   // red
  reset: "\x1b[0m",
};

function log(level, message, extra = {}) {
  if ((LEVELS[level] ?? 99) < currentLevel) return;

  if (config.isProd()) {
    // Google Cloud Logging structured format
    // https://cloud.google.com/logging/docs/structured-logging
    const entry = {
      severity : level.toUpperCase(),
      message,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
  } else {
    const c      = COLOURS[level] || "";
    const reset  = COLOURS.reset;
    const ts     = new Date().toISOString().replace("T", " ").slice(0, 23);
    const lbl    = level.toUpperCase().padEnd(5);
    const extras = Object.keys(extra).length
      ? "\n  " + JSON.stringify(extra, null, 2).replace(/\n/g, "\n  ")
      : "";
    process.stdout.write(`${c}[${ts}] ${lbl}${reset} ${message}${extras}\n`);
  }
}

const logger = {
  debug : (msg, extra) => log("debug", msg, extra),
  info  : (msg, extra) => log("info",  msg, extra),
  warn  : (msg, extra) => log("warn",  msg, extra),
  error : (msg, extra) => log("error", msg, extra),

  /**
   * Convenience: create a child logger with a fixed label prepended.
   * Usage: const log = logger.child("AudioHook");  log.info("Connected");
   */
  child(label) {
    return {
      debug : (msg, extra) => log("debug", `[${label}] ${msg}`, extra),
      info  : (msg, extra) => log("info",  `[${label}] ${msg}`, extra),
      warn  : (msg, extra) => log("warn",  `[${label}] ${msg}`, extra),
      error : (msg, extra) => log("error", `[${label}] ${msg}`, extra),
    };
  },
};

module.exports = logger;
