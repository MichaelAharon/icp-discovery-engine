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
// Convert any markdown that slips through to HTML
function markdownToHTML(text) {
  return text
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$1. $2</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => '<ul>' + match + '</ul>')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hupoltdb])/gm, (match, offset, str) => {
      const before = str.substring(Math.max(0, offset - 5), offset);
      if (before.match(/<\/?[a-z]/)) return match;
      return match;
    });
}
function extractSources(messageContent) {
  const sources = [];
  const seen = new Set();

  for (const block of messageContent) {
    // Extract from web search result blocks
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
const SYSTEM_PROMPT = `You are a senior B2B sales intelligence analyst for Askit.ai. You have deep knowledge of the MEDDIC sales qualification methodology and Askit.ai's product, ICP, and value proposition.

ASKIT.AI PRODUCT: AI-powered consumer behavior simulation and creative testing platform. Predicts how real audiences will respond to messages, creatives, and concepts BEFORE launch.

VALUE PROP: Choose winning ideas and creatives in hours instead of weeks, reducing wasted ad spend and failed launches.

THREE PROBLEMS SOLVED:
1. WASTED AD SPEND — $50K-100K+/mo on underperforming creative. Askit improves hit rate 30-50%.
2. SLOW VALIDATION — 6-8 weeks, $15-30K/project → hours, $500-1K/test.
3. POOR AUDIENCE UNDERSTANDING — Generic personas (2-3% conversion) → behavioral modeling (4-5%).

USE CASES: Ad creative testing, positioning/messaging validation, landing page optimization, launch/campaign planning.

ICP: 50-2000 employees, consumer brands/fintech/media, $100K+ marketing budget, active paid acquisition, digitally mature.

ICP SCORING (10 dims, 0-3 each, max 30): Company Size, Industry Fit, Marketing Budget, Experimentation Maturity, Pain Intensity, Urgency/Timing, AI Openness, Active Paid Media, Recent Rebrand/Launch, DTC/Ecommerce. 25-30=Strong, 15-24=Medium, 0-14=Low.

MEDDIC: M=Metrics(quantify in $), E=Economic Buyer(CMO/VP), D=Decision Criteria(speed/accuracy/cost), D=Decision Process(Discovery→Demo→Pilot→Contract), I=Identify Pain(operational→executive→business impact), C=Champion(performance marketer with pain+influence).

CRITICAL SOURCING RULES:
- ALWAYS search the web for current information before making claims.
- EVERY factual claim (revenue, employee count, executive name, product launch, campaign, funding, etc.) MUST include an inline citation.
- Use this format for inline citations: <span class="cite" data-source="URL">[Source: Domain Name]</span>
- Example: "The company reported $500M in revenue <span class="cite" data-source="https://example.com/article">[ Source: example.com]</span>"
- If you cannot find a source for a claim, explicitly label it as "Estimated" or "Industry benchmark" — never present unverified claims as facts.
- When citing executive names and titles, always search to verify they are current.
- Prefer primary sources (company websites, SEC filings, press releases) over secondary sources.
- Include the date of the information when available.

OUTPUT RULES:
- CRITICAL: Output ONLY valid HTML. NEVER use markdown syntax (no ##, ###, **, -, ```). ONLY use HTML tags.
- Use <h3> for section headers, <h4> for sub-headers, <p> for paragraphs, <ul>/<li> for lists, <table> for data, <blockquote> for quotes, <strong> for bold, <em> for emphasis.
- NEVER start your response with preamble like "Based on my research..." — go straight into the HTML content starting with <h3>.
- Be ACTIONABLE — talk tracks, questions, pile-on statements.
- Use <div class="action-box"><h4>Sales Rep Actions</h4>...</div> for actions.
- Cite specific facts, dates, numbers with inline source citations. No filler.`;

// ── PROMPT BUILDER ────────────────────────────────────────────────────────────
function buildPrompt(section, url, context) {
  const ctx = context || '';

  const CITE_REMINDER = `\n\nREMINDER: Search the web for current data. Every factual claim MUST have an inline citation using <span class="cite" data-source="URL">[Source: Domain]</span>. Mark unverified claims as "Estimated".`;

  const prompts = {
    research: `Search the web for the EXACT company at this URL: ${url}

CRITICAL URL VALIDATION:
- Search for the exact domain "${url}" first.
- If you cannot find a real company website at this exact URL, respond ONLY with: <h3>Company Not Found</h3><p>Could not verify a company at <strong>${url}</strong>. Please check the URL and try again.</p>
- Do NOT guess, do NOT research a similarly-named company, do NOT continue if the URL doesn't match a real business.

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

    metrics: `Research ${url} on the web to find current financial data, ad spend signals, and competitive landscape.

Based on your research AND this prior analysis:\n${ctx}\n\nGenerate MEDDIC METRICS in this exact structure:

<h3>1. Estimated Ad &amp; Marketing Spend</h3>
What does this company likely spend monthly/annually on paid media and marketing? Cite sources. If estimates, label clearly.

<h3>2. Quantifiable Pain — Wasted Budget</h3>
Based on their spend, how much are they likely wasting on underperforming creative or slow validation? Calculate specific dollar amounts. Example: "At $X/month ad spend with industry-average 30% creative failure rate, they waste ~$Y/month."

<h3>3. ROI Framework for Askit</h3>
Build a simple ROI calculation:
<ul>
<li>Current waste: $X</li>
<li>Askit improvement: 30-50% better hit rate</li>
<li>Projected savings: $Y/month</li>
<li>Askit cost: ~$Z/month</li>
<li>Net ROI: X:1 return</li>
</ul>

<h3>4. Key Metrics to Surface on the Call</h3>
Which specific KPIs should the sales rep ask about? What numbers make the economic buyer care? List 4-5 specific metrics with why each matters.

<h3>5. Competitive Benchmarks</h3>
How does this company's marketing performance compare to competitors? What benchmarks can you reference to create urgency?

<div class="action-box"><h4>Sales Rep Actions</h4>
<p><strong>Discovery Questions:</strong></p>
<ul>
<li>[Question 1 with specific $ reference]</li>
<li>[Question 2 about their current testing process]</li>
<li>[Question 3 about their KPI targets]</li>
</ul>
<p><strong>Pile-On Statement:</strong></p>
<p>[A statement that adds urgency using the specific numbers above]</p>
</div>

Cite every financial figure with <span class="cite" data-source="URL">[Source: Domain]</span>.${CITE_REMINDER}`,

    economic: `Search for current leadership at ${url} — look for CEO, CMO, VP Marketing, VP Growth, Head of Digital on LinkedIn, press releases, and company about pages.

Based on your research AND this prior analysis:\n${ctx}\n\nGenerate MEDDIC ECONOMIC BUYER in this exact structure:

<h3>1. Who Is the Economic Buyer?</h3>
Name, title, and how long in role. Cite source for every name. If multiple candidates, list them ranked by likelihood.

<h3>2. What Do They Care About?</h3>
Map their stated priorities (from interviews, press, LinkedIn posts) directly to Askit's value. Be specific — quote or reference their own words.

<h3>3. Path to Reach Them</h3>
Champion → Director → VP → C-suite path. Who do you go through? What's the internal org structure?

<h3>4. Messaging That Resonates at Their Level</h3>
Specific talking points tied to their public statements and priorities. Not generic — tailored to THIS person.

<div class="action-box"><h4>Sales Rep Actions</h4>
<p><strong>30-Second Opener:</strong></p>
<p>[Personalized opener referencing something specific about this buyer]</p>
<p><strong>Qualification Questions:</strong></p>
<ul>
<li>[Question 1]</li>
<li>[Question 2]</li>
</ul>
<p><strong>Red Flags:</strong></p>
<ul>
<li>[Red flag 1]</li>
<li>[Red flag 2]</li>
</ul>
</div>

Cite every name and title with source.${CITE_REMINDER}`,

    criteria: `Search for how ${url} currently evaluates marketing tools, what platforms they use, and any public procurement or vendor selection signals.

Based on your research AND this prior analysis:\n${ctx}\n\nGenerate MEDDIC DECISION CRITERIA in this exact structure:

<h3>1. Likely Evaluation Criteria</h3>
Based on their tech stack, company size, and marketing maturity — what criteria will they use to evaluate Askit?

<h3>2. How Askit Wins on Each Criterion</h3>
For each criterion above, explain specifically how Askit competes. Use a table if helpful.

<h3>3. How to Shape Criteria Early</h3>
What questions and positioning should the rep use to shape criteria in Askit's favor before formal evaluation?

<h3>4. Disqualification Risks</h3>
What criteria could disqualify Askit? How to preempt each one.

<div class="action-box"><h4>Sales Rep Actions</h4>
<p><strong>Criteria-Shaping Questions:</strong></p>
<ul>
<li>[Question 1]</li>
<li>[Question 2]</li>
<li>[Question 3]</li>
</ul>
<p><strong>Positioning Statement:</strong></p>
<p>[A statement that positions Askit favorably against their likely criteria]</p>
</div>${CITE_REMINDER}`,

    process: `Search for ${url}'s company size, procurement processes, and any signals about how they buy software.

Based on your research AND this prior analysis:\n${ctx}\n\nGenerate MEDDIC DECISION PROCESS in this exact structure:

<h3>1. Likely Buying Process</h3>
Step-by-step stages from first contact to signed contract, tailored to this company's size and type.

<h3>2. Estimated Timeline</h3>
How long from discovery call to contract? Break down by stage with estimated days/weeks.

<h3>3. Key Stakeholders at Each Stage</h3>
Who is involved at each buying stage? Use verified names where found. Use a table.

<h3>4. Potential Blockers</h3>
What could stall or kill the deal? How to mitigate each.

<h3>5. Urgency Drivers</h3>
Specific upcoming events, deadlines, or business pressures that create urgency. Reference findings from research.

<div class="action-box"><h4>Sales Rep Actions</h4>
<p><strong>Process-Mapping Questions:</strong></p>
<ul>
<li>[Question 1]</li>
<li>[Question 2]</li>
<li>[Question 3]</li>
</ul>
<p><strong>Ideal Next Step:</strong></p>
<p>[Specific next action to propose]</p>
<p><strong>Urgency Statement:</strong></p>
<p>[A statement tied to their specific business timeline]</p>
</div>${CITE_REMINDER}`,

    pain: `Search for recent challenges, complaints, competitive pressures, and industry headwinds affecting ${url}.

Based on your research AND this prior analysis:\n${ctx}\n\nGenerate MEDDIC IDENTIFY PAIN in this exact structure:

<h3>1. Operational Pain</h3>
What's broken day-to-day in their marketing/product testing process? Cite specific evidence from your research.

<h3>2. Executive Pain</h3>
What does leadership publicly worry about? Reference interviews, earnings calls, LinkedIn posts. What keeps the CMO/VP up at night?

<h3>3. Business Impact</h3>
What's the strategic risk if they don't fix these problems? Revenue impact, competitive threat, market position.

<h3>4. Evidence-Based Pain Signals</h3>
Direct quotes or paraphrases from public sources that prove the pain exists. Cite each one.

<div class="action-box"><h4>Sales Rep Actions</h4>
<p><strong>"Magic Moment" Questions:</strong></p>
<ul>
<li>[Question referencing a specific company fact]</li>
<li>[Question referencing a specific company fact]</li>
<li>[Question referencing a specific company fact]</li>
</ul>
<p><strong>Pile-On Statements:</strong></p>
<ul>
<li>[Statement with specific numbers that adds to their problem]</li>
<li>[Statement with specific numbers that adds to their problem]</li>
</ul>
<p><strong>Parallel Story:</strong></p>
<p>[Brief story of a similar company and how Askit helped]</p>
</div>${CITE_REMINDER}`,

    champion: `Search for ${url} team members who work in performance marketing, growth, product marketing, or digital marketing.

Based on your research AND this prior analysis:\n${ctx}\n\nGenerate MEDDIC CHAMPION in this exact structure:

<h3>1. Ideal Champion Profile</h3>
Title/role and specific person if identifiable from public sources. Why this role is the right champion.

<h3>2. Why They'd Champion Askit</h3>
What's in it for them personally? Career wins, solving their daily pain, looking innovative to leadership.

<h3>3. Champion Qualification Test</h3>
How to test if they're a REAL champion vs just interested. Specific questions and signals to look for.

<h3>4. Internal Selling Ammunition</h3>
What to arm them with to sell internally. Tailored to this company's priorities and language.

<h3>5. Red Flags — Not a Real Champion</h3>
Signs they can't or won't champion. When to multi-thread to other contacts.

<div class="action-box"><h4>Sales Rep Actions</h4>
<p><strong>Champion Qualification Questions:</strong></p>
<ul>
<li>[Question 1]</li>
<li>[Question 2]</li>
<li>[Question 3]</li>
</ul>
<p><strong>Arming Statement:</strong></p>
<p>[A one-liner the champion can use internally to pitch Askit]</p>
<p><strong>Multi-Threading Trigger:</strong></p>
<p>[When and how to engage additional stakeholders]</p>
</div>${CITE_REMINDER}`,
  };
  return prompts[section] || '';
}

// ── API ENDPOINT ──────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { section, url, context } = req.body;
  if (!section || !url) return res.status(400).json({ error: 'Missing section or url' });

  // Check cache
  const cached = getFromCache(url, section);
  if (cached) {
    console.log(`  ⚡ CACHE HIT: ${section} for ${normalizeUrl(url)}`);
    return res.json({ success: true, content: cached.content, sources: cached.sources || [], cached: true });
  }

  const prompt = buildPrompt(section, url, context);

  // Web search enabled on ALL sections (except ICP which is JSON-only)
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

    // Extract text content and convert any markdown to HTML
    const rawContent = extractText(message.content);
    const content = markdownToHTML(rawContent);

    // Extract source URLs from web search results
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

// ── N8N WEBHOOK INTEGRATION ───────────────────────────────────────────────────
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

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

// Called by frontend after ICP report completes
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
  const sections = ['research','icp','metrics','economic','criteria','process','pain','champion'];
  const cached = {}; let allCached = true;
  for (const s of sections) { cached[s] = !!getFromCache(url, s); if (!cached[s]) allCached = false; }
  res.json({ url: normalizeUrl(url), cached, allCached });
});

// ── FORCE REFRESH ─────────────────────────────────────────────────────────────
app.post('/api/clear-cache', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const sections = ['research','icp','metrics','economic','criteria','process','pain','champion'];
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
  console.log(`\n  ✦ MEDDIC Intelligence Engine v2 — port ${PORT}`);
  console.log(`  ✦ API key: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`  ✦ Web search: ALL sections`);
  console.log(`  ✦ n8n webhook: ${N8N_WEBHOOK_URL || '✗ NOT SET (set N8N_WEBHOOK_URL env var)'}`);
  console.log(`  ✦ Cache: ${s.activeEntries} entries, ${s.uniqueUrls} URLs (24h TTL)\n`);
});
