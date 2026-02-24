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

// Email JSON report via SMTP
app.post('/api/send-report', async (req, res) => {
  const { to, subject, company_name, json_data } = req.body;
  if (!to || !json_data) return res.status(400).json({ error: 'Missing required fields' });

  // Use environment variables for SMTP config
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || smtpUser;

  if (!smtpHost || !smtpUser || !smtpPass) {
    return res.status(500).json({ error: 'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in environment variables.' });
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const date = new Date().toISOString().split('T')[0];
    const filename = `ICP_${(company_name || 'Company').replace(/\s+/g, '_')}_${date}.json`;
    const jsonStr = JSON.stringify(json_data, null, 2);

    // Build a clean HTML email body
    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
        <div style="background:#0f172a;color:#fff;padding:24px 30px;border-radius:12px 12px 0 0">
          <h1 style="margin:0;font-size:20px">🎯 ICP Discovery Engine</h1>
          <p style="margin:6px 0 0;color:#94a3b8;font-size:14px">New Report Generated</p>
        </div>
        <div style="background:#f8fafc;padding:24px 30px;border:1px solid #e2e8f0;border-top:none">
          <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b">${company_name || 'Company'}</h2>
          <table style="width:100%;font-size:13px;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#64748b;width:120px">Sector</td><td style="padding:6px 0;font-weight:600">${json_data.company?.sector || 'N/A'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Employees</td><td style="padding:6px 0;font-weight:600">${json_data.company?.estimated_employees || 'N/A'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Revenue</td><td style="padding:6px 0;font-weight:600">${json_data.company?.estimated_revenue || 'N/A'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">TAM</td><td style="padding:6px 0;font-weight:600">${json_data.market?.tam || 'N/A'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Competitors</td><td style="padding:6px 0;font-weight:600">${(json_data.competitors || []).map(c => c.name).join(', ') || 'N/A'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">ICP Industries</td><td style="padding:6px 0;font-weight:600">${(json_data.suggested_icp?.target_industries || []).join(', ') || 'N/A'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Agent Tasks</td><td style="padding:6px 0;font-weight:600">${(json_data.agent_tasks || []).length} tasks ready</td></tr>
          </table>
          <p style="margin:18px 0 6px;font-size:13px;color:#64748b">The full JSON file is attached. Feed it to your LLM agent to execute the suggested tasks.</p>
        </div>
        <div style="background:#f1f5f9;padding:14px 30px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;border-top:none;font-size:12px;color:#94a3b8;text-align:center">
          ICP Discovery Engine · Auto-generated report · ${date}
        </div>
      </div>`;

    await transporter.sendMail({
      from: `"ICP Discovery Engine" <${smtpFrom}>`,
      to,
      subject: subject || `ICP Report: ${company_name} — ${date}`,
      html: htmlBody,
      attachments: [{
        filename,
        content: jsonStr,
        contentType: 'application/json',
      }],
    });

    console.log('Report emailed to:', to);
    res.json({ success: true, message: 'Report sent to ' + to });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('ICP Discovery Engine v2 running on port ' + PORT);
});
