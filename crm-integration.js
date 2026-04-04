/**
 * crm-integration.js
 * ──────────────────
 * Plug-in CRM adapters for the Agent Assist server.
 * Swap the active adapter in server.js by setting CRM_ADAPTER env var.
 *
 * Supported:
 *   - salesforce   (Salesforce CRM via REST API)
 *   - servicenow   (ServiceNow Incident table)
 *   - hubspot      (HubSpot CRM)
 *   - mock         (logs to console — default for dev)
 */

"use strict";

// ═══════════════════════════════════════════════════════════
//  Salesforce Adapter
// ═══════════════════════════════════════════════════════════
class SalesforceAdapter {
  constructor() {
    this.baseUrl     = process.env.SF_INSTANCE_URL;  // e.g. https://myorg.salesforce.com
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  // OAuth 2.0 Connected App — Client Credentials flow
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry) return this.accessToken;

    const params = new URLSearchParams({
      grant_type   : "client_credentials",
      client_id    : process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
    });

    const res = await fetch(`${this.baseUrl}/services/oauth2/token`, {
      method : "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body   : params,
    });

    const data = await res.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  // Find or create a Case for this conversation
  async getOrCreateCase(conversationId) {
    const token = await this.getAccessToken();

    // Search for existing case by external ID
    const query = `SELECT Id FROM Case WHERE Genesys_Conversation_Id__c='${conversationId}' LIMIT 1`;
    const searchRes = await fetch(
      `${this.baseUrl}/services/data/v60.0/query?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();

    if (searchData.totalSize > 0) {
      return searchData.records[0].Id;
    }

    // Create new Case
    const createRes = await fetch(`${this.baseUrl}/services/data/v60.0/sobjects/Case`, {
      method : "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type" : "application/json",
      },
      body: JSON.stringify({
        Subject                    : "Inbound Call",
        Genesys_Conversation_Id__c : conversationId,
        Origin                     : "Phone",
        Status                     : "In Progress",
      }),
    });

    const createData = await createRes.json();
    return createData.id;
  }

  // Update Case with AI-extracted fields
  async update(conversationId, fields) {
    const token  = await this.getAccessToken();
    const caseId = await this.getOrCreateCase(conversationId);

    const payload = {};
    if (fields.intent)    payload.Subject          = fields.intent;
    if (fields.sentiment) payload.Customer_Sentiment__c = fields.sentiment;
    if (fields.summary)   payload.Description      = fields.summary;

    // Map extracted entities to Salesforce fields
    if (fields.entities) {
      if (fields.entities.account_number) payload.AccountId  = fields.entities.account_number;
      if (fields.entities.amount)         payload.Dispute_Amount__c = parseFloat(fields.entities.amount);
    }

    await fetch(`${this.baseUrl}/services/data/v60.0/sobjects/Case/${caseId}`, {
      method : "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type" : "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log(`[CRM][Salesforce] Updated Case ${caseId}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  ServiceNow Adapter
// ═══════════════════════════════════════════════════════════
class ServiceNowAdapter {
  constructor() {
    this.baseUrl  = process.env.SNOW_INSTANCE_URL;  // e.g. https://myorg.service-now.com
    this.user     = process.env.SNOW_USER;
    this.password = process.env.SNOW_PASSWORD;
    this.auth     = Buffer.from(`${this.user}:${this.password}`).toString("base64");
  }

  async getOrCreateIncident(conversationId) {
    const res = await fetch(
      `${this.baseUrl}/api/now/table/incident?sysparm_query=correlation_id=${conversationId}&sysparm_limit=1`,
      { headers: { Authorization: `Basic ${this.auth}`, Accept: "application/json" } }
    );
    const data = await res.json();

    if (data.result?.length > 0) return data.result[0].sys_id;

    const createRes = await fetch(`${this.baseUrl}/api/now/table/incident`, {
      method : "POST",
      headers: {
        Authorization : `Basic ${this.auth}`,
        "Content-Type": "application/json",
        Accept        : "application/json",
      },
      body: JSON.stringify({
        short_description: "Inbound Phone Call",
        correlation_id   : conversationId,
        contact_type     : "phone",
        state            : "1",  // New
      }),
    });

    const createData = await createRes.json();
    return createData.result.sys_id;
  }

  async update(conversationId, fields) {
    const sysId = await this.getOrCreateIncident(conversationId);

    const payload = {};
    if (fields.intent)    payload.short_description = fields.intent;
    if (fields.sentiment) payload.u_customer_sentiment = fields.sentiment;
    if (fields.summary)   payload.description = fields.summary;

    await fetch(`${this.baseUrl}/api/now/table/incident/${sysId}`, {
      method : "PATCH",
      headers: {
        Authorization : `Basic ${this.auth}`,
        "Content-Type": "application/json",
        Accept        : "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log(`[CRM][ServiceNow] Updated Incident ${sysId}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  HubSpot Adapter
// ═══════════════════════════════════════════════════════════
class HubSpotAdapter {
  constructor() {
    this.apiKey = process.env.HUBSPOT_API_KEY;
  }

  async update(conversationId, fields) {
    const notes = [
      fields.intent    ? `Intent: ${fields.intent}` : null,
      fields.sentiment ? `Sentiment: ${fields.sentiment}` : null,
      fields.summary   ? `\nSummary:\n${fields.summary}` : null,
    ].filter(Boolean).join("\n");

    if (!notes) return;

    await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
      method : "POST",
      headers: {
        Authorization : `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          hs_note_body         : notes,
          hs_timestamp         : new Date().toISOString(),
          hs_contact_ids_meta  : conversationId,
        },
      }),
    });

    console.log(`[CRM][HubSpot] Created note for conversation ${conversationId}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  Mock Adapter (dev/testing)
// ═══════════════════════════════════════════════════════════
class MockAdapter {
  async update(conversationId, fields) {
    console.log(`[CRM][Mock] conversationId=${conversationId}`, JSON.stringify(fields, null, 2));
  }
}

// ═══════════════════════════════════════════════════════════
//  Factory
// ═══════════════════════════════════════════════════════════
function createCRMAdapter() {
  const adapter = (process.env.CRM_ADAPTER || "mock").toLowerCase();

  switch (adapter) {
    case "salesforce" : return new SalesforceAdapter();
    case "servicenow" : return new ServiceNowAdapter();
    case "hubspot"    : return new HubSpotAdapter();
    default           : return new MockAdapter();
  }
}

const crmAdapter = createCRMAdapter();
console.log(`[CRM] Adapter: ${process.env.CRM_ADAPTER || "mock"}`);

module.exports = { crmAdapter };
