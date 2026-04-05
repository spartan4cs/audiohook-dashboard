# Agent Assist — Genesys AudioHook + Gemini Live

Real-time AI-powered agent assist for contact centres.  
Genesys streams audio → Gemini Live transcribes + suggests → agents see it live in their browser.

## Architecture

```
Genesys Cloud
  └─ AudioHook WSS ──────────► /api/v1/audiohook/ws
                                      │
                               server.js (entry point)
                                      │
                    ┌─────────────────┼──────────────────┐
                    │                 │                  │
          audiohookHandler    geminiService        crmService
                    │                 │                  │
                    └──────► agentBroadcaster ◄──────────┘
                                      │
                            /agent-ui WebSocket
                                      │
                             Agent browser (UI)
```

## Module Structure

```
server.js                    ← Entry point (bootstrap only, no logic)
src/
  config/index.js            ← Central config + env-var validation
  utils/
    logger.js                ← Structured JSON logger (Cloud Logging)
    audio.js                 ← PCMU → PCM16 @ 16kHz conversion
  services/
    sessionStore.js          ← In-memory call session store
    agentBroadcaster.js      ← Agent UI WebSocket registry + broadcast
    geminiService.js         ← Gemini Live connection, audio, tool calls
    crmService.js            ← Pluggable CRM adapters (SF/SNOW/HubSpot/Mock)
  handlers/
    audiohookHandler.js      ← Genesys AudioHook protocol FSM
    agentUiHandler.js        ← Agent browser WebSocket handler
  routes/
    health.js                ← GET /health, GET /ui
agent-ui.html                ← Agent browser dashboard (served at /ui)
```

## Authentication — Vertex AI (ADC)

This server uses **Vertex AI** via **Application Default Credentials (ADC)**.
- **No API key is stored, rotated, or managed.**
- On Cloud Run: the attached **service account** is the credential automatically.
- Locally: run `gcloud auth application-default login` once.

The [`@google/genai`](https://github.com/google/genai-node) SDK picks up Vertex AI
when these three env vars are set:

```
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-central1
```

## Local Development

```bash
# 1. Install
npm install

# 2. Authenticate with Vertex AI (one-time)
gcloud auth application-default login

# 3. Configure
cp .env.example .env
# Edit .env — set GOOGLE_CLOUD_PROJECT to your GCP project ID

# 4. Run
npm run dev

# Endpoints
# ws://localhost:8080/api/v1/audiohook/ws   ← Genesys
# ws://localhost:8080/agent-ui              ← Browser
# http://localhost:8080/health              ← Health check
# http://localhost:8080/ui                  ← Agent dashboard
```

## Docker

```bash
# Build
npm run docker:build

# Run
npm run docker:run
# (reads .env from current directory)
```

## Cloud Run Deployment

### One-time setup

```bash
PROJECT_ID=your-project
REGION=us-central1

# Enable APIs
gcloud services enable run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  aiplatform.googleapis.com

# Create Artifact Registry repo
gcloud artifacts repositories create audiohook \
  --repository-format=docker --location=$REGION

# Create a dedicated service account for Cloud Run
gcloud iam service-accounts create audiohook-sa \
  --display-name="AudioHook Cloud Run SA"

# Grant Vertex AI access (no API key needed!)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:audiohook-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# Store the Genesys secret (only non-AI secret)
echo -n "YOUR_AUDIOHOOK_KEY" | gcloud secrets create audiohook-api-key --data-file=-
```

### Deploy manually

```bash
IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/audiohook/audiohook-server:latest

docker build -t $IMAGE .
docker push $IMAGE

gcloud run deploy audiohook-server \
  --image=$IMAGE \
  --region=$REGION \
  --allow-unauthenticated \
  --service-account=audiohook-sa@${PROJECT_ID}.iam.gserviceaccount.com \
  --min-instances=1 \
  --max-instances=10 \
  --memory=512Mi \
  --timeout=3600 \
  --set-secrets=AUDIOHOOK_API_KEY=audiohook-api-key:latest \
  --set-env-vars=NODE_ENV=production,CRM_ADAPTER=mock,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$REGION
```

### CI/CD via Cloud Build

Connect your repo in the Cloud Build console and the included `cloudbuild.yaml` will:
1. Build the Docker image
2. Push to Artifact Registry
3. Deploy to Cloud Run

## CRM Integration

Set `CRM_ADAPTER` env var to one of:

| Value        | System     | Additional env vars required              |
|--------------|------------|-------------------------------------------|
| `mock`       | Console log| —                                         |
| `salesforce` | Salesforce | `SF_INSTANCE_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET` |
| `servicenow` | ServiceNow | `SNOW_INSTANCE_URL`, `SNOW_USER`, `SNOW_PASSWORD`     |
| `hubspot`    | HubSpot    | `HUBSPOT_API_KEY`                         |

## Environment Variables

| Variable                  | Required (prod) | Default                      | Description                           |
|---------------------------|-----------------|------------------------------|---------------------------------------|
| `GOOGLE_CLOUD_PROJECT`    | **yes**         | —                            | GCP project ID (Vertex AI)            |
| `GOOGLE_CLOUD_LOCATION`   | no              | `us-central1`                | Vertex AI region                      |
| `GOOGLE_GENAI_USE_VERTEXAI`| no             | `true` (set in code)         | Switches SDK to Vertex AI             |
| `AUDIOHOOK_API_KEY`       | no              | `dev-key`                    | Genesys auth key                      |
| `PORT`                    | no              | `8080`                       | HTTP listen port                      |
| `NODE_ENV`                | no              | `development`                | `production` enables JSON logs        |
| `LOG_LEVEL`               | no              | `info`                       | `debug\|info\|warn\|error`            |
| `CRM_ADAPTER`             | no              | `mock`                       | CRM backend                           |
| `GEMINI_MODEL`            | no              | `gemini-2.0-flash-live-001`  | Live model                            |
| `GEMINI_SUMMARY_MODEL`    | no              | `gemini-2.0-flash`           | Summary model                         |
| `TRANSCRIPT_MAX_LINES`    | no              | `50`                         | Rolling transcript window             |
