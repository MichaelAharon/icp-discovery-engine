# 🎯 ICP Discovery Engine

AI-powered Ideal Customer Profile discovery tool for B2B sales teams. Paste any company URL — get instant market intelligence, structured qualification, and exportable ICP reports.

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Express](https://img.shields.io/badge/Express-4.x-blue) ![Claude AI](https://img.shields.io/badge/Claude-Sonnet_4-purple)

## Features

- **AI Company Research** — Enter a URL, get market analysis with web search
- **Structured Qualification** — Dropdown-based ICP questions (firmographics, technographics, pain points, buying committee)
- **Smart Scoring** — Automatic fit scoring with A–D grades
- **AI Narrative** — Generated ICP summary, buyer persona, sales approach, competitive positioning
- **Geography & Sector Filters** — Focus research on specific regions and verticals
- **Dual Export** — PDF download + clipboard copy for CRM/Slack
- **Secure API Proxy** — API key stays server-side, never exposed to users
- **Rate Limiting** — Built-in protection against abuse

## Quick Deploy to Railway

### 1. Push to GitHub

```bash
# Create a new repo on github.com, then:
git init
git add .
git commit -m "Initial commit - ICP Discovery Engine"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/icp-discovery-engine.git
git push -u origin main
```

### 2. Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `icp-discovery-engine` repo
4. Railway auto-detects Node.js — it will install dependencies and start the server

### 3. Set Environment Variable

In your Railway project dashboard:
1. Go to your service → **Variables** tab
2. Click **"New Variable"**
3. Add:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** Your Anthropic API key (starts with `sk-ant-...`)
4. Railway will automatically redeploy

### 4. Get Your Public URL

- Railway auto-generates a URL like `https://icp-discovery-engine-production-xxxx.up.railway.app`
- You can add a **custom domain** under Settings → Domains

## Local Development

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/icp-discovery-engine.git
cd icp-discovery-engine

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Start the server
npm start

# Open http://localhost:3000
```

## Architecture

```
icp-discovery-engine/
├── server.js          # Express server + API proxy + rate limiter
├── public/
│   └── index.html     # Full SPA (single-page app) — no build step needed
├── package.json
├── railway.toml       # Railway deployment config
├── Dockerfile         # Backup container config
├── .env.example       # Environment variable template
└── README.md
```

**Why a server proxy?**
The Express server proxies calls to the Anthropic API so the API key never reaches the browser. End users interact with `/api/research` and `/api/generate-icp` — the server adds the API key and forwards to Claude.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `PORT` | ❌ | Server port (default: 3000, Railway sets automatically) |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/research` | POST | Company research (proxied to Claude with web search) |
| `/api/generate-icp` | POST | ICP narrative generation (proxied to Claude) |

## Cost Estimate

Each full research + ICP generation uses ~2 Claude API calls. At Sonnet pricing (~$3/1M input, ~$15/1M output tokens), each full report costs approximately **$0.02–$0.05**.

## License

MIT
