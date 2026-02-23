const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rate limiter
const rateLimit = new Map();
// URL research cache — same URL only calls Claude API once
const researchCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
function checkRate(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);
  if (!entry || now - entry.start > 60000) {
    rateLimit.set(ip, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit) {
    if (now - entry.start > 120000) rateLimit.delete(ip);
  }
}, 60000);

// Claude API proxy - company research
app.post('/api/research', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!checkRate(req.ip)) return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });

  try {
    const { messages, system, tools } = req.body;

    // Extract URL from the message for caching
    const msgText = messages?.[0]?.content || '';
    const urlMatch = msgText.match(/https?:\/\/[^\s]+/);
    const cacheKey = urlMatch ? urlMatch[0].replace(/\/+$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase() : null;

    // Check cache
    if (cacheKey && researchCache.has(cacheKey)) {
      const cached = researchCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('Cache hit for:', cacheKey);
        return res.json(cached.data);
      }
      researchCache.delete(cacheKey);
    }

    const body = { model: 'claude-sonnet-4-20250514', max_tokens: 4096, messages };
    if (system) body.system = system;
    if (tools) body.tools = tools;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });

    // Cache successful result
    if (cacheKey) {
      researchCache.set(cacheKey, { data, timestamp: Date.now() });
      console.log('Cached result for:', cacheKey);
    }

    res.json(data);
  } catch (err) {
    console.error('Research error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Claude API proxy - ICP strategy generation
app.post('/api/generate-icp', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!checkRate(req.ip)) return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });

  try {
    const { messages } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, messages }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });
    res.json(data);
  } catch (err) {
    console.error('ICP generation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('ICP Discovery Engine v2 running on port ' + PORT);
});
