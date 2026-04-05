"use strict";

/**
 * src/services/crmService.js
 *
 * CRM adapter factory + plug-in adapters.
 * Select the adapter via env var: CRM_ADAPTER=salesforce|servicenow|hubspot|mock
 *
 * Every adapter exposes a single async method:
 *   adapter.update(conversationId, fields) → Promise<void>
 *
 * Fields shape:
 *   {
 *     intent?   : string,
 *     sentiment?: "positive"|"neutral"|"frustrated"|"angry",
 *     entities? : Record<string,string>,
 *     summary?  : string,
 *   }
 */

const { config } = require("../config");
const logger     = require("../utils/logger").child("CRM");

// ──────────────────────────────────────────────────────────────────────────────
//  Salesforce Adapter
// ──────────────────────────────────────────────────────────────────────────────
class SalesforceAdapter {
  constructor() {
    this.baseUrl     = config.SF_INSTANCE_URL;
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  async _getToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry) return this.accessToken;

    const params = new URLSearchParams({
      grant_type   : "client_credentials",
      client_id    : config.SF_CLIENT_ID,
      client_secret: config.SF_CLIENT_SECRET,
    });

    const res  = await fetch(`${this.baseUrl}/services/oauth2/token`, {
      method : "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body   : params,
    });
    if (!res.ok) throw new Error(`SF token error: ${res.status}`);

    const data = await res.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  async _getOrCreateCase(conversationId, token) {
    const q = `SELECT Id FROM Case WHERE Genesys_Conversation_Id__c='${conversationId}' LIMIT 1`;
    const res = await fetch(
      `${this.baseUrl}/services/data/v60.0/query?q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.totalSize > 0) return data.records[0].Id;

    const createRes = await fetch(`${this.baseUrl}/services/data/v60.0/sobjects/Case`, {
      method : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body   : JSON.stringify({
        Subject                   : "Inbound Call",
        Genesys_Conversation_Id__c: conversationId,
        Origin                    : "Phone",
        Status                    : "In Progress",
      }),
    });
    if (!createRes.ok) throw new Error(`SF case create error: ${createRes.status}`);
    const d = await createRes.json();
    return d.id;
  }

  async update(conversationId, fields) {
    const token  = await this._getToken();
    const caseId = await this._getOrCreateCase(conversationId, token);

    const payload = {};
    if (fields.intent)    payload.Subject                = fields.intent;
    if (fields.sentiment) payload.Customer_Sentiment__c  = fields.sentiment;
    if (fields.summary)   payload.Description            = fields.summary;
    if (fields.entities?.account_number) payload.AccountId = fields.entities.account_number;
    if (fields.entities?.amount) payload.Dispute_Amount__c = parseFloat(fields.entities.amount);

    const res = await fetch(`${this.baseUrl}/services/data/v60.0/sobjects/Case/${caseId}`, {
      method : "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body   : JSON.stringify(payload),
    });
    if (!res.ok && res.status !== 204) throw new Error(`SF update error: ${res.status}`);
    logger.info("Salesforce case updated", { caseId, conversationId });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  ServiceNow Adapter
// ──────────────────────────────────────────────────────────────────────────────
class ServiceNowAdapter {
  constructor() {
    this.baseUrl = config.SNOW_INSTANCE_URL;
    this.auth    = Buffer.from(`${config.SNOW_USER}:${config.SNOW_PASSWORD}`).toString("base64");
  }

  get _headers() {
    return {
      Authorization : `Basic ${this.auth}`,
      "Content-Type": "application/json",
      Accept        : "application/json",
    };
  }

  async _getOrCreateIncident(conversationId) {
    const res = await fetch(
      `${this.baseUrl}/api/now/table/incident?sysparm_query=correlation_id=${conversationId}&sysparm_limit=1`,
      { headers: this._headers }
    );
    const data = await res.json();
    if (data.result?.length > 0) return data.result[0].sys_id;

    const createRes = await fetch(`${this.baseUrl}/api/now/table/incident`, {
      method : "POST",
      headers: this._headers,
      body   : JSON.stringify({
        short_description: "Inbound Phone Call",
        correlation_id   : conversationId,
        contact_type     : "phone",
        state            : "1",
      }),
    });
    if (!createRes.ok) throw new Error(`SNOW incident create error: ${createRes.status}`);
    const d = await createRes.json();
    return d.result.sys_id;
  }

  async update(conversationId, fields) {
    const sysId = await this._getOrCreateIncident(conversationId);
    const payload = {};
    if (fields.intent)    payload.short_description    = fields.intent;
    if (fields.sentiment) payload.u_customer_sentiment = fields.sentiment;
    if (fields.summary)   payload.description          = fields.summary;

    const res = await fetch(`${this.baseUrl}/api/now/table/incident/${sysId}`, {
      method : "PATCH",
      headers: this._headers,
      body   : JSON.stringify(payload),
    });
    if (!res.ok && res.status !== 204) throw new Error(`SNOW update error: ${res.status}`);
    logger.info("ServiceNow incident updated", { sysId, conversationId });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  HubSpot Adapter
// ──────────────────────────────────────────────────────────────────────────────
class HubSpotAdapter {
  constructor() {
    this.apiKey = config.HUBSPOT_API_KEY;
  }

  async update(conversationId, fields) {
    const notes = [
      fields.intent    ? `Intent: ${fields.intent}`       : null,
      fields.sentiment ? `Sentiment: ${fields.sentiment}` : null,
      fields.summary   ? `\nSummary:\n${fields.summary}`  : null,
    ].filter(Boolean).join("\n");

    if (!notes) return;

    const res = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
      method : "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body   : JSON.stringify({
        properties: {
          hs_note_body       : notes,
          hs_timestamp       : new Date().toISOString(),
          hs_contact_ids_meta: conversationId,
        },
      }),
    });
    if (!res.ok) throw new Error(`HubSpot note create error: ${res.status}`);
    logger.info("HubSpot note created", { conversationId });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Mock Adapter  (dev / CI)
// ──────────────────────────────────────────────────────────────────────────────
class MockAdapter {
  async update(conversationId, fields) {
    logger.debug("CRM (mock) update", { conversationId, fields });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Factory — singleton
// ──────────────────────────────────────────────────────────────────────────────
function createAdapter() {
  switch (config.CRM_ADAPTER) {
    case "salesforce" : return new SalesforceAdapter();
    case "servicenow" : return new ServiceNowAdapter();
    case "hubspot"    : return new HubSpotAdapter();
    default           : return new MockAdapter();
  }
}

const crmAdapter = createAdapter();
logger.info(`CRM adapter: ${config.CRM_ADAPTER}`);

/**
 * Push fields to CRM, swallowing errors so a CRM hiccup never crashes a call.
 * @param {string} conversationId
 * @param {object} fields
 */
async function pushToCRM(conversationId, fields) {
  try {
    await crmAdapter.update(conversationId, fields);
  } catch (err) {
    logger.error("CRM push failed", { conversationId, error: err.message });
  }
}

module.exports = { pushToCRM, crmAdapter };
