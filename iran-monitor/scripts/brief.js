#!/usr/bin/env node
/**
 * brief.js — Iran Conflict Intelligence Raw Data Fetcher
 *
 * Usage: node brief.js --type morning|evening
 *
 * Fetches raw content from news sources + OSINT posts + brief state.
 * Does NOT synthesize. Outputs structured blocks for the cron AI agent.
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const typeIdx = args.indexOf('--type');
const briefType = typeIdx !== -1 ? args[typeIdx + 1] : null;
if (!briefType || !['morning', 'evening'].includes(briefType)) {
  console.error('Usage: node brief.js --type morning|evening');
  process.exit(1);
}

// ── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const X_POSTS_PATH = path.join(DATA_DIR, 'x-latest-posts.json');
const BRIEF_STATE_PATH = path.join(DATA_DIR, 'brief-state.json');

// ── News sources ─────────────────────────────────────────────────────────────
const SOURCES = [
  {
    label: 'AL JAZEERA LIVEBLOG',
    url: 'https://www.aljazeera.com/news/liveblog/2026/3/24/iran-war-live-tehran-says-trumps-claims-of-peace-talks-fake',
  },
  {
    label: 'THE GUARDIAN LIVE',
    url: 'https://www.theguardian.com/world/live/2026/mar/23/middle-east-crisis-live-iea-chief-says-iran-war-energy-crunch-worse-than-1970s-oil-crises-and-ukraine-war-combined',
  },
  {
    label: 'NBC NEWS LIVE BLOG',
    url: 'https://www.nbcnews.com/world/middle-east/live-blog/live-updates-iran-war-trump-hormuz-deadline-energy-crisis-gulf-power-rcna264685',
  },
];

// ── Fetch helpers ─────────────────────────────────────────────────────────────
function fetchUrl(urlStr, redirectCount = 0) {
  return new Promise((resolve) => {
    if (redirectCount > 5) {
      resolve({ url: urlStr, status: 'error', error: 'Too many redirects', text: '' });
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
    } catch (e) {
      resolve({ url: urlStr, status: 'error', error: 'Invalid URL', text: '' });
      return;
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IranIntelBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection': 'close',
      },
    };

    const req = lib.request(options, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsedUrl.protocol}//${parsedUrl.hostname}${res.headers.location}`;
        res.destroy();
        fetchUrl(redirectUrl, redirectCount + 1).then(resolve);
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        // Strip HTML tags, collapse whitespace, extract readable text
        const text = stripHtml(raw);
        resolve({
          url: urlStr,
          finalUrl: parsedUrl.href,
          status: res.statusCode,
          text,
          rawLength: raw.length,
          textLength: text.length,
        });
      });
      res.on('error', (err) => {
        resolve({ url: urlStr, status: 'error', error: err.message, text: '' });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ url: urlStr, status: 'error', error: 'Request timed out', text: '' });
    });

    req.on('error', (err) => {
      resolve({ url: urlStr, status: 'error', error: err.message, text: '' });
    });

    req.end();
  });
}

function stripHtml(html) {
  // Remove scripts, styles, nav, header/footer noise
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    // Keep block-level semantics as newlines
    .replace(/<\/?(p|div|li|h[1-6]|blockquote|article|section|br)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    // Collapse excess whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Cap at 8000 chars to keep context manageable
  if (text.length > 8000) {
    text = text.slice(0, 8000) + '\n[... truncated at 8000 chars ...]';
  }
  return text;
}

// ── Read local data ───────────────────────────────────────────────────────────
function readJsonSafe(filePath, defaultVal) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return defaultVal;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const fetchedAt = new Date().toISOString();

  // 1. Fetch all news sources in parallel
  const results = await Promise.all(
    SOURCES.map((s) => fetchUrl(s.url).then((r) => ({ ...r, label: s.label })))
  );

  // 2. Read OSINT posts
  const xPosts = readJsonSafe(X_POSTS_PATH, []);

  // 3. Read brief state
  const briefState = readJsonSafe(BRIEF_STATE_PATH, {
    last_brent_price: null,
    last_wti_price: null,
    last_brief_type: null,
    last_brief_timestamp: null,
    key_developments: [],
  });

  // ── Output structured blocks ──────────────────────────────────────────────
  console.log('='.repeat(80));
  console.log(`IRAN CONFLICT INTEL RAW FEED`);
  console.log(`Brief type: ${briefType.toUpperCase()}`);
  console.log(`Fetched at: ${fetchedAt}`);
  console.log('='.repeat(80));

  // Block 1: Prior brief state (for delta comparison)
  console.log('\n--- PRIOR BRIEF STATE ---');
  console.log(JSON.stringify(briefState, null, 2));

  // Block 2: News source content
  for (const result of results) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`SOURCE: ${result.label}`);
    console.log(`URL: ${result.url}`);
    console.log(`HTTP Status: ${result.status}`);
    if (result.error) {
      console.log(`FETCH ERROR: ${result.error}`);
      console.log(`NOTE: Source unavailable — use web_search to pull latest from this outlet instead.`);
    } else {
      console.log(`Text length: ${result.textLength} chars (from ${result.rawLength} raw)`);
      console.log('--- BEGIN CONTENT ---');
      console.log(result.text);
      console.log('--- END CONTENT ---');
    }
  }

  // Block 3: X/Twitter OSINT posts
  console.log(`\n${'='.repeat(80)}`);
  console.log('OSINT: X/TWITTER LATEST POSTS');
  console.log(`Total posts: ${xPosts.length}`);
  console.log('---');
  if (xPosts.length === 0) {
    console.log('(no OSINT posts available)');
  } else {
    for (const post of xPosts) {
      console.log(`\n[@${post.handle}] ${post.created_at}`);
      console.log(`${post.text}`);
      console.log(`Likes: ${post.likes} | RT: ${post.retweets}`);
      console.log(`URL: ${post.url}`);
    }
  }

  // Block 4: Instructions for synthesis
  console.log(`\n${'='.repeat(80)}`);
  console.log('SYNTHESIS INSTRUCTIONS');
  console.log(`
Using ALL of the raw content above, write an Iran Conflict Intelligence Brief.
If any news source fetch failed, supplement with web_search queries for that outlet.
Also use web_search to get current Brent and WTI oil prices.

REQUIRED FORMAT (plain text, CAPS headers, dashes for bullets, NO markdown):

IRAN CONFLICT INTELLIGENCE BRIEF
${briefType.toUpperCase()} | [DATE] | DAY [N]

EXECUTIVE SUMMARY
[3-4 sentences. What changed since last brief. What matters for energy/markets.]

SITUATION BY THEATER
- IRAN MAINLAND: [strikes, leadership, posture]
- ISRAEL/NORTHERN FRONT: [activity, casualties]
- GULF STATES: [UAE/Saudi/Qatar exposure]
- STRAIT OF HORMUZ: [traffic %, vessels, incidents]
- IRAQ/PROXY THEATER: [PMF, US bases]

DIPLOMATIC TRACK
[Talks status, mediators, pause window, credibility assessment]

ENERGY INFRASTRUCTURE
- Brent: $X (vs $Y at last brief, +Z% since pre-war)
- WTI: $X
- Hormuz: [traffic status]
- Qatar LNG: [status]
- Primorsk: [if relevant]

MARKET IMPLICATIONS
[2-3 bullets. Specific to oil, rates, equities.]

SEMICONDUCTOR / SUPPLY CHAIN
[Helium, Qatar LNG, chipmaker exposure]

CONFIDENCE ASSESSMENT
HIGH CONFIDENCE: [known facts]
MEDIUM CONFIDENCE: [corroborated but unverified]
LOW CONFIDENCE: [rumors, single-source]

WHAT TO WATCH (NEXT 12H)
[5 specific signals with rationale]

SOURCES
[All URLs used, one per line]

RULES:
- Include actual news URLs for every major claim
- Call out DELTA vs prior brief explicitly (e.g. "up from $X in morning brief")
- Prior brief state is shown above in PRIOR BRIEF STATE block — use it for deltas
- Written at Goldman/Bridgewater geopolitical risk note quality
- 600-900 words total, dense not padded
- Send final report via Telegram to BOTH: -5208788616 (group) AND 1493302943 (Arjun personal)
- After sending, update /home/ubuntu/.openclaw/workspace/iran-monitor/data/brief-state.json with current Brent/WTI prices, brief type="${briefType}", timestamp, and top 3 key developments
`);
  console.log('='.repeat(80));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
