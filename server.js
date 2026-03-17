const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '100kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
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
// ── STATS TRACKER ─────────────────────────────────────────────────────────────
const STATS_FILE = path.join(__dirname, '.stats.json');
const PRICING = { input_per_m: 3.00, output_per_m: 15.00 };

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch(e) {}
  return { totalCalls:0, cachedCalls:0, inputTokens:0, outputTokens:0, totalCostUsd:0, callsBySection:{}, callsByUrl:{}, webhooksFired:0, startedAt:new Date().toISOString(), lastCallAt:null };
}

function saveStats(s) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2)); } catch(e) {}
}

function recordUsage(section, url, inputTokens, outputTokens, cached) {
  const s = loadStats();
  s.totalCalls++;
  if (cached) { s.cachedCalls++; return saveStats(s); }
  s.inputTokens  += inputTokens  || 0;
  s.outputTokens += outputTokens || 0;
  s.totalCostUsd += ((inputTokens||0)/1_000_000 * PRICING.input_per_m) + ((outputTokens||0)/1_000_000 * PRICING.output_per_m);
  s.callsBySection[section] = (s.callsBySection[section] || 0) + 1;
  const domain = normalizeUrl(url).split('/')[0];
  s.callsByUrl[domain] = (s.callsByUrl[domain] || 0) + 1;
  s.lastCallAt = new Date().toISOString();
  saveStats(s);
}

function recordWebhook() {
  const s = loadStats(); s.webhooksFired = (s.webhooksFired||0)+1; saveStats(s);
}
// ── SOURCE EXTRACTION ─────────────────────────────────────────────────────────
function extractSources(messageContent) {
  const sources = [];
  const seen = new Set();
  for (const block of messageContent) {
    if (block.type === 'web_search_tool_result' && block.content) {
      for (const item of block.content) {
        if (item.type === 'web_search_result' && item.url && !seen.has(item.url)) {
          seen.add(item.url);
          sources.push({ url: item.url, title: item.title || item.url });
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
const SYSTEM_PROMPT = `You are a world-class market research and ICP (Ideal Customer Profile) analyst.

YOUR JOB: Given a company URL, research the company thoroughly and build their Ideal Customer Profile — meaning, who should THIS company be selling to? Who is their best-fit customer?

CRITICAL RULES — ACCURACY ABOVE ALL:
- EVERY claim must be verified by web search. Do NOT guess, assume, or fabricate.
- If you cannot verify a fact, say "Could not verify" — NEVER make something up.
- Prefer primary sources: the company's own website, press releases, SEC filings, LinkedIn, Crunchbase.
- If data is estimated (e.g. revenue range), label it explicitly as "Estimated".
- Include the source URL for every factual claim.
- Do NOT hallucinate executive names, revenue figures, employee counts, or customer examples.

OUTPUT: Always respond in valid JSON. No markdown, no code fences, no preamble. Raw JSON only.`;

// ── PROMPTS ───────────────────────────────────────────────────────────────────
function buildPrompt(section, url, context) {
  const prompts = {
    // Step 1: Deep company research
    research: `Search the web thoroughly for the company at: ${url}

CRITICAL: Search for the EXACT domain "${url}". If you cannot find a real company at this URL, respond with:
{"error": "Company not found at ${url}. Please check the URL and try again."}

If found, research and return this EXACT JSON structure. EVERY field must be backed by web search — leave empty string "" if you cannot verify:

{
  "company": {
    "name": "",
    "url": "${url}",
    "description": "",
    "founded": "",
    "headquarters": "",
    "employee_count": "",
    "employee_range": "",
    "revenue_estimate": "",
    "funding_total": "",
    "funding_stage": "",
    "business_model": "",
    "industry": "",
    "sub_industry": "",
    "products_services": [],
    "key_offerings": [],
    "value_proposition": "",
    "pricing_model": "",
    "target_markets": [],
    "geographies_served": [],
    "notable_customers": [],
    "competitors": [],
    "tech_stack_signals": [],
    "recent_news": [],
    "leadership": [{"name": "", "title": "", "source": ""}],
    "social_presence": {"linkedin": "", "twitter": "", "instagram": "", "other": ""},
    "ad_channels": [],
    "content_marketing": ""
  },
  "sources": [{"url": "", "title": ""}]
}

Search multiple times to fill every field. For notable_customers and competitors, search specifically for those. For leadership, verify names are CURRENT.`,

    // Step 2: Build ICP based on the research
    icp: `Based on this verified research about ${url}:

${context}

Now BUILD the Ideal Customer Profile for this company — who is THEIR best-fit customer?

Use industry benchmarks, the company's positioning, their pricing model, the competitive landscape, and their current customer base to determine this.

Search the web for:
1. Industry benchmarks for companies in this segment (who typically buys from companies like this?)
2. The company's own marketing — who are they targeting?
3. Case studies or testimonials — who are their actual customers?
4. Competitor customer profiles — who do similar companies sell to?

Return this EXACT JSON. Every field must be research-backed. Use "" for anything you cannot verify:

{
  "icp": {
    "summary": "2-3 sentence summary of who this company's ideal customer is",
    "firmographics": {
      "company_size": {"min_employees": 0, "max_employees": 0, "sweet_spot": "", "reasoning": ""},
      "revenue_range": {"min": "", "max": "", "sweet_spot": "", "reasoning": ""},
      "industries": [{"name": "", "fit_reason": ""}],
      "geographies": [{"region": "", "reasoning": ""}],
      "company_stage": "",
      "business_model_fit": []
    },
    "demographics": {
      "primary_buyer": {"title": "", "department": "", "seniority": "", "reasoning": ""},
      "secondary_buyers": [{"title": "", "department": "", "role_in_decision": ""}],
      "influencers": [{"title": "", "department": "", "influence_type": ""}],
      "end_users": [{"role": "", "how_they_use": ""}]
    },
    "psychographics": {
      "pain_points": [{"pain": "", "severity": "", "evidence": ""}],
      "goals": [{"goal": "", "priority": "", "evidence": ""}],
      "buying_triggers": [{"trigger": "", "timing": ""}],
      "objections": [{"objection": "", "how_to_handle": ""}]
    },
    "technographics": {
      "current_tools_they_likely_use": [{"tool": "", "category": "", "relevance": ""}],
      "tech_maturity": "",
      "integration_requirements": [],
      "data_signals": []
    },
    "behavioral": {
      "buying_process": "",
      "typical_sales_cycle": "",
      "decision_criteria": [],
      "budget_range": "",
      "preferred_channels": [],
      "content_consumed": []
    },
    "disqualifiers": [{"signal": "", "why_bad_fit": ""}],
    "look_alike_companies": [{"name": "", "why_similar": "", "source": ""}]
  },
  "methodology": "Brief explanation of how this ICP was derived — what sources and benchmarks were used",
  "confidence": "high / medium / low — based on data availability",
  "sources": [{"url": "", "title": ""}]
}`
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

  try {
    console.log(`  🔄 GENERATE: ${section} for ${normalizeUrl(url)} [web search]`);
    const t0 = Date.now();

    const params = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    };

    const message = await anthropic.messages.create(params);
    const rawContent = extractText(message.content);
    const sources = extractSources(message.content);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✓ ${section} done (${rawContent.length} chars, ${sources.length} sources, ${elapsed}s)`);
recordUsage(section, url, message.usage?.input_tokens||0, message.usage?.output_tokens||0, false);
    saveToCache(url, section, rawContent, sources);
    res.json({ success: true, content: rawContent, sources, cached: false });
  } catch (error) {
    console.error(`  ✗ ${section} error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── CLEAR CACHE ───────────────────────────────────────────────────────────────
app.post('/api/clear-cache', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  let cleared = 0;
  for (const s of ['research', 'icp']) {
    const fp = getCachePath(getCacheKey(url, s));
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); cleared++; }
  }
  res.json({ success: true, cleared });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), cache: getCacheStats(), uptime: Math.floor(process.uptime()), n8nWebhook: !!process.env.N8N_WEBHOOK_URL });
});

app.get('/api/stats', (req, res) => {
  const s = loadStats();
  const cache = getCacheStats();
  const daysSinceStart = Math.max(1,(Date.now()-new Date(s.startedAt).getTime())/(1000*60*60*24));
  const dailyRate = s.totalCostUsd / daysSinceStart;
  res.json({
    totalCostUsd:      parseFloat(s.totalCostUsd.toFixed(4)),
    monthlyProjection: parseFloat((dailyRate*30).toFixed(2)),
    inputTokens:       s.inputTokens,
    outputTokens:      s.outputTokens,
    totalTokens:       s.inputTokens + s.outputTokens,
    totalCalls:        s.totalCalls,
    cachedCalls:       s.cachedCalls,
    liveCalls:         s.totalCalls - s.cachedCalls,
    cacheHitRate:      s.totalCalls>0 ? parseFloat(((s.cachedCalls/s.totalCalls)*100).toFixed(1)) : 0,
    webhooksFired:     s.webhooksFired||0,
    cacheEntries:      cache.activeEntries,
    uniqueUrls:        cache.uniqueUrls,
    sectionBreakdown:  Object.entries(s.callsBySection||{}).sort((a,b)=>b[1]-a[1]).map(([section,count])=>({section,count})),
    topUrls:           Object.entries(s.callsByUrl||{}).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([url,count])=>({url,count})),
    startedAt:         s.startedAt,
    lastCallAt:        s.lastCallAt,
    daysSinceStart:    parseFloat(daysSinceStart.toFixed(1)),
    fixedCosts: {
      railway: parseFloat(process.env.RAILWAY_MONTHLY_USD||'20'),
      n8n:     parseFloat(process.env.N8N_MONTHLY_USD||'20'),
      hubspot: parseFloat(process.env.HUBSPOT_MONTHLY_USD||'0'),
    }
  });
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => {
  const s = getCacheStats();
  console.log(`\n  ✦ ICP Discovery Engine — port ${PORT}`);
  console.log(`  ✦ API key: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`  ✦ Cache: ${s.activeEntries} entries, ${s.uniqueUrls} URLs (24h TTL)\n`);
});
