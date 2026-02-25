const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please wait a minute.' },
});
app.use('/api/', limiter);
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

// ── CACHE ─────────────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_TTL = 24 * 60 * 60 * 1000;
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function normalizeUrl(url) {
  return url.toLowerCase().trim().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/+$/, '');
}
function getCacheKey(url, section) {
  return normalizeUrl(url).replace(/[^a-z0-9.-]/g, '_').slice(0, 100) + '__' + section;
}
function getCachePath(key) { return path.join(CACHE_DIR, `${key}.json`); }

function getFromCache(url, section) {
  const fp = getCachePath(getCacheKey(url, section));
  try {
    if (!fs.existsSync(fp)) return null;
    const c = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Date.now() - c.timestamp > CACHE_TTL) { fs.unlinkSync(fp); return null; }
    return c;
  } catch (e) { return null; }
}

function saveToCache(url, section, content, sources) {
  const fp = getCachePath(getCacheKey(url, section));
  try {
    fs.writeFileSync(fp, JSON.stringify({
      url: normalizeUrl(url), section, content, sources: sources || [],
      timestamp: Date.now(), expires: new Date(Date.now() + CACHE_TTL).toISOString(),
    }));
  } catch (e) { console.error('Cache write error:', e.message); }
}

function getCacheStats() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
    let active = 0, expired = 0; const urls = new Set();
    for (const file of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
        if (Date.now() - c.timestamp > CACHE_TTL) { expired++; fs.unlinkSync(path.join(CACHE_DIR, file)); }
        else { active++; urls.add(c.url); }
      } catch (e) { expired++; }
    }
    return { activeEntries: active, uniqueUrls: urls.size, expiredCleaned: expired };
  } catch (e) { return { activeEntries: 0, uniqueUrls: 0, expiredCleaned: 0 }; }
}

// ── SOURCE EXTRACTION ─────────────────────────────────────────────────────────
function markdownToHTML(text) {
  return text
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hupoltd])/gm, (m) => m ? `<p>${m}` : m);
}

function extractSources(messageContent) {
  const sources = [];
  const seen = new Set();
  for (const block of messageContent) {
    if (block.type === 'web_search_tool_result' && block.content) {
      for (const item of block.content) {
        if (item.type === 'web_search_result' && item.url && !seen.has(item.url)) {
          seen.add(item.url);
          sources.push({
            url: item.url,
            title: item.title || item.url,
            snippet: item.snippet || '',
          });
        }
      }
    }
  }
  return sources;
}

function extractText(messageContent) {
  return messageContent.filter(b => b.type === 'text').map(b => b.text).join('');
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior B2B sales intelligence analyst for Askit.ai. You specialize in ICP (Ideal Customer Profile) analysis and company research.

ASKIT.AI PRODUCT: AI-powered consumer behavior simulation and creative testing platform. Predicts how real audiences will respond to messages, creatives, and concepts BEFORE launch.

VALUE PROP: Choose winning ideas and creatives in hours instead of weeks, reducing wasted ad spend and failed launches.

THREE PROBLEMS SOLVED:
1. WASTED AD SPEND — $50K-100K+/mo on underperforming creative. Askit improves hit rate 30-50%.
2. SLOW VALIDATION — 6-8 weeks, $15-30K/project → hours, $500-1K/test.
3. POOR AUDIENCE UNDERSTANDING — Generic personas (2-3% conversion) → behavioral modeling (4-5%).

USE CASES: Ad creative testing, positioning/messaging validation, landing page optimization, launch/campaign planning.

ICP: 50-2000 employees, consumer brands/fintech/media, $100K+ marketing budget, active paid acquisition, digitally mature.

ICP SCORING (10 dims, 0-3 each, max 30): Company Size, Industry Fit, Marketing Budget, Experimentation Maturity, Pain Intensity, Urgency/Timing, AI Openness, Active Paid Media, Recent Rebrand/Launch, DTC/Ecommerce. 25-30=Strong, 15-24=Medium, 0-14=Low.

CRITICAL SOURCING RULES:
- ALWAYS search the web for current information before making claims.
- EVERY factual claim MUST include an inline citation.
- Use: <span class="cite" data-source="URL">[Source: Domain Name]</span>
- If you cannot find a source, label as "Estimated" or "Industry benchmark".
- Prefer primary sources (company websites, SEC filings, press releases).

OUTPUT RULES:
- Output ONLY valid HTML. NEVER use markdown syntax.
- Use <h3>, <h4>, <p>, <ul>/<li>, <table>, <blockquote>, <strong>, <em>.
- NEVER start with preamble — go straight into HTML.
- Cite specific facts with inline source citations.`;

// ── PROMPT BUILDER ────────────────────────────────────────────────────────────
function buildPrompt(section, url, context) {
  const ctx = context || '';
  const CITE_REMINDER = `\n\nREMINDER: Search the web for current data. Every factual claim MUST have an inline citation using <span class="cite" data-source="URL">[Source: Domain]</span>. Mark unverified claims as "Estimated".`;

  const prompts = {
    research: `Search the web for the EXACT company at this URL: ${url}

CRITICAL URL VALIDATION:
- Search for the exact domain "${url}" first.
- If you cannot find a real company website at this exact URL, respond ONLY with: <h3>Company Not Found</h3><p>Could not verify a company at <strong>${url}</strong>. Please check the URL and try again.</p>
- Do NOT guess, do NOT research a similarly-named company.

If the company IS found, research thoroughly:

<h3>Company Overview</h3>
What they do, business model (DTC/wholesale/hybrid), product categories, founding year, HQ.

<h3>Size &amp; Financials</h3>
Employee count, revenue estimates, funding history.

<h3>Last 12 Months — Key Events</h3>
Product launches, campaigns, rebrands, market expansions, leadership changes, partnerships, awards.

<h3>Marketing &amp; Ad Signals</h3>
Ad channels used, creative strategies, public ad spend data, social media presence.

<h3>Tech Stack</h3>
Ecommerce platform, marketing tools, analytics.

<h3>Competitive Landscape &amp; Pain Points</h3>
Challenges in press, competitive pressures, industry headwinds.

<h3>Key Executives</h3>
CEO, CMO, VP Marketing, Head of Growth — verify current titles.

For EVERY fact, cite with: <span class="cite" data-source="URL">[Source: Domain]</span>${CITE_REMINDER}`,

    icp: `Based on this research about ${url}:\n\n${ctx}\n\nSearch the web to verify any claims you're unsure about. Score against Askit.ai ICP — 10 dimensions, 0-3 each.\n\nRESPOND IN EXACT JSON ONLY (no markdown, no fences):\n{"dimensions":[{"name":"Company Size","score":0,"reason":"..."},{"name":"Industry Fit","score":0,"reason":"..."},{"name":"Marketing Budget","score":0,"reason":"..."},{"name":"Experimentation Maturity","score":0,"reason":"..."},{"name":"Pain Intensity","score":0,"reason":"..."},{"name":"Urgency / Timing","score":0,"reason":"..."},{"name":"AI Openness","score":0,"reason":"..."},{"name":"Active Paid Media","score":0,"reason":"..."},{"name":"Recent Rebrand / Launch","score":0,"reason":"..."},{"name":"DTC / Ecommerce","score":0,"reason":"..."}],"total":0,"verdict":"Strong Fit / Medium Fit / Low Fit","summary":"2-3 sentences"}\n\nBe strict: 3 only with clear evidence. 0-1 if unknown. Include source URLs in reason fields where possible.`,
  };
  return prompts[section] || '';
}

// ── API ENDPOINT ──────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { section, url, context } = req.body;
  if (!section || !url) return res.status(400).json({ error: 'Missing section or url' });

  const cached = getFromCache(url, section);
  if (cached) {
    console.log(`  ⚡ CACHE HIT: ${section} for ${normalizeUrl(url)}`);
    return res.json({ success: true, content: cached.content, sources: cached.sources || [], cached: true });
  }

  const prompt = buildPrompt(section, url, context);
  const useSearch = (section !== 'icp');

  try {
    console.log(`  🔄 GENERATE: ${section} for ${normalizeUrl(url)}${useSearch ? ' [web search]' : ''}`);
    const t0 = Date.now();

    const params = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    };
    if (useSearch) params.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    const message = await anthropic.messages.create(params);
    const rawContent = extractText(message.content);
    const content = markdownToHTML(rawContent);
    const sources = extractSources(message.content);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✓ ${section} done (${content.length} chars, ${sources.length} sources, ${elapsed}s)`);

    saveToCache(url, section, content, sources);
    res.json({ success: true, content, sources, cached: false });
  } catch (error) {
    console.error(`  ✗ ${section} error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── N8N WEBHOOK INTEGRATION ──────────────────────────────────────────────────
async function fireN8nWebhook(url, icpData, researchContent) {
  if (!N8N_WEBHOOK_URL) {
    console.log('  ⚠ N8N_WEBHOOK_URL not set — skipping webhook');
    return { fired: false, reason: 'no_webhook_url' };
  }
  try {
    console.log(`  🔗 Firing n8n webhook for ${normalizeUrl(url)}...`);
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        icp: icpData,
        research: researchContent,
        timestamp: new Date().toISOString(),
        source: 'icp-discovery-engine'
      })
    });
    const status = resp.status;
    console.log(`  ✓ Webhook fired (HTTP ${status})`);
    return { fired: true, status };
  } catch (e) {
    console.error(`  ✗ Webhook failed:`, e.message);
    return { fired: false, error: e.message };
  }
}

app.post('/api/fire-webhook', async (req, res) => {
  const { url, icp, research } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!icp) return res.status(400).json({ error: 'Missing icp data' });
  const result = await fireN8nWebhook(url, icp, research || '');
  res.json({ success: result.fired, ...result });
});

// ── CACHE STATUS ──────────────────────────────────────────────────────────────
app.get('/api/cache-status', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const sections = ['research', 'icp'];
  const cached = {}; let allCached = true;
  for (const s of sections) { cached[s] = !!getFromCache(url, s); if (!cached[s]) allCached = false; }
  res.json({ url: normalizeUrl(url), cached, allCached });
});

app.post('/api/clear-cache', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const sections = ['research', 'icp'];
  let cleared = 0;
  for (const s of sections) {
    const fp = getCachePath(getCacheKey(url, s));
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); cleared++; }
  }
  res.json({ success: true, cleared });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), cache: getCacheStats() });
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => {
  const s = getCacheStats();
  console.log(`\n  ✦ Askit ICP Discovery Engine — port ${PORT}`);
  console.log(`  ✦ API key: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`  ✦ Web search: research section`);
  console.log(`  ✦ n8n webhook: ${N8N_WEBHOOK_URL || '✗ NOT SET (set N8N_WEBHOOK_URL env var)'}`);
  console.log(`  ✦ Cache: ${s.activeEntries} entries, ${s.uniqueUrls} URLs (24h TTL)\n`);
});
