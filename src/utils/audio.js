"use strict";

/**
 * src/utils/audio.js
 *
 * Pure audio conversion utilities (no I/O, no state).
 *
 * Pipeline:
 *   Genesys sends  → PCMU @ 8 000 Hz (G.711 µ-law, 8-bit)
 *   Gemini expects → PCM16 @ 16 000 Hz (linear 16-bit LE)
 *
 *   Step 1: decodeMuLaw   — PCMU byte[] → PCM16 @ 8 kHz
 *   Step 2: upsample8To16 — PCM16 @ 8 kHz → PCM16 @ 16 kHz (linear interpolation)
 */

/**
 * Decode G.711 µ-law (PCMU) bytes to signed 16-bit PCM @ 8 kHz.
 * @param {Buffer} buf  Raw PCMU bytes from Genesys
 * @returns {Buffer}    PCM16 LE at 8 kHz (2 bytes per sample)
 */
function decodeMuLaw(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    let u      = buf[i] ^ 0xFF;
    const sign = u & 0x80 ? -1 : 1;
    const exp  = (u >> 4) & 0x07;
    const mant = u & 0x0F;
    let mag    = ((mant << 3) + 0x84) << exp;
    mag -= 0x84;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sign * mag)), i * 2);
  }
  return out;
}

/**
 * Upsample PCM16 from 8 kHz to 16 kHz using linear interpolation.
 * @param {Buffer} pcm8k  PCM16 LE at 8 kHz
 * @returns {Buffer}      PCM16 LE at 16 kHz (4 bytes per input sample)
 */
function upsample8To16(pcm8k) {
  const n   = pcm8k.length / 2;         // number of input samples
  const out = Buffer.alloc(n * 4);      // 2× samples, 2 bytes each
  for (let i = 0; i < n; i++) {
    const s0 = pcm8k.readInt16LE(i * 2);
    const s1 = (i + 1 < n) ? pcm8k.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0, i * 4);
    out.writeInt16LE(Math.round((s0 + s1) / 2), i * 4 + 2);
  }
  return out;
}

/**
 * Convert a raw audio chunk from Genesys to PCM16 @ 16 kHz.
 * @param {Buffer} raw  Incoming buffer from Genesys
 * @param {{ format?: string }} fmt  Media format from the AudioHook `opened` handshake
 * @returns {Buffer}  PCM16 LE @ 16 kHz, ready for Gemini
 */
function convertToPcm16_16k(raw, fmt) {
  const pcm8k = (fmt?.format === "PCMU") ? decodeMuLaw(raw) : raw;
  return upsample8To16(pcm8k);
}

module.exports = { decodeMuLaw, upsample8To16, convertToPcm16_16k };
