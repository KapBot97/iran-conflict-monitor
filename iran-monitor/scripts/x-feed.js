const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MAP_FILE = path.join(__dirname, '..', 'map', 'index.html');
const DEPLOY_DIR = path.join(__dirname, '..');

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAIyw8QEAAAAAUytBcKek%2F9JHgO07%2FL4P2dpu%2Fv8%3D0ntmGmjiYvCb9Ze8ZHq7FQ3n0RwFydTL4Ls7CVPpVdWYBoO1t0';

// Curated high-quality accounts
const OSINT_QUERIES = [
  '(from:sentdefender OR from:OSINTdefender OR from:ELINTNews) (Iran OR Hormuz OR oil OR strike OR Gulf OR refinery)',
  '(from:JavierBlas OR from:TankerTrackers) (Iran OR oil OR Hormuz OR tanker OR crude OR Brent)',
  '(from:CENTCOM OR from:RALee85 OR from:BabakTaghvaee1) (Iran OR strike OR attack OR military)',
  '(from:aurora_intel OR from:IntelCrab) (Iran OR missile OR drone OR Gulf)'
];

function xApiSearch(query) {
  return new Promise((resolve, reject) => {
    const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=created_at,author_id,text,public_metrics&expansions=author_id&user.fields=username,name`;
    const options = {
      headers: { 'Authorization': `Bearer ${BEARER_TOKEN}` }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ data: [] }); }
      });
    }).on('error', reject);
  });
}

async function collectPosts() {
  const allPosts = [];
  const userMap = {};

  for (const query of OSINT_QUERIES) {
    try {
      const result = await xApiSearch(query);
      if (result.includes && result.includes.users) {
        for (const u of result.includes.users) {
          userMap[u.id] = u.username;
        }
      }
      if (result.data) {
        for (const tweet of result.data) {
          allPosts.push({
            id: tweet.id,
            text: tweet.text,
            handle: userMap[tweet.author_id] || 'unknown',
            created_at: tweet.created_at,
            likes: tweet.public_metrics?.like_count || 0,
            retweets: tweet.public_metrics?.retweet_count || 0,
            url: `https://x.com/${userMap[tweet.author_id] || 'i'}/status/${tweet.id}`
          });
        }
      }
      await new Promise(r => setTimeout(r, 1100)); // rate limit
    } catch (e) {
      console.log(`Query failed: ${e.message}`);
    }
  }

  // Deduplicate and sort by engagement
  const seen = new Set();
  const unique = allPosts
    .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
    .sort((a, b) => (b.likes + b.retweets * 3) - (a.likes + a.retweets * 3));

  return unique;
}

function isRecent(post, hoursAgo) {
  var postTime = new Date(post.created_at).getTime();
  var cutoff = Date.now() - (hoursAgo * 3600000);
  return postTime > cutoff;
}

function classifyPost(post) {
  const text = post.text.toLowerCase();
  const rumorSignals = ['unconfirmed', 'reports', 'reportedly', 'according to', 'sources say', 
    'claims', 'alleged', 'appears to show', 'could not confirm'];
  const confirmedSignals = ['confirmed', 'officially', 'released footage', 'announced', 
    'has said', 'ministry said', 'statement'];
  
  const isRumor = rumorSignals.some(s => text.includes(s));
  const isConfirmed = confirmedSignals.some(s => text.includes(s));
  
  // All accounts we actively query are credible — treat them all equally
  const credibleAccount = [
    'sentdefender','JavierBlas','CENTCOM','RALee85','ELINTNews',
    'BabakTaghvaee1','TankerTrackers','aurora_intel','IntelCrab',
    'OSINTdefender','ABORASHEED_EN','IntelCrab'
  ].includes(post.handle);

  let confidence = 'low';
  if (isConfirmed && credibleAccount) confidence = 'high';
  else if (credibleAccount && highEngagement) confidence = 'high';
  else if (credibleAccount) confidence = 'medium';
  else if (highEngagement) confidence = 'medium';

  let status = 'MONITORING';
  if (isConfirmed) status = 'CONFIRMED';
  else if (isRumor) status = 'UNCONFIRMED';

  // Determine energy relevance
  const energyKeywords = {
    critical: ['kharg', 'hormuz', 'ras laffan', 'abqaiq', 'yanbu', 'strait', 'oil export', 'lng'],
    high: ['refinery', 'oil', 'pipeline', 'tanker', 'crude', 'brent', 'gas field', 'south pars'],
    medium: ['drone', 'missile', 'infrastructure', 'energy', 'helium'],
    low: ['military', 'troops', 'navy', 'air force', 'f-35']
  };

  let energyRelevance = 'low';
  for (const [level, keywords] of Object.entries(energyKeywords)) {
    if (keywords.some(kw => text.includes(kw))) {
      energyRelevance = level;
      break;
    }
  }

  return { confidence, status, energyRelevance };
}

function updateMapRumors(posts) {
  // Read current HTML
  let html = fs.readFileSync(MAP_FILE, 'utf8');

  // Build new rumors array from X posts
  // Only posts from last 6 hours go on map as active rumors
  const recentPosts = posts.filter(p => isRecent(p, 6));
  const olderPosts = posts.filter(p => !isRecent(p, 6));
  console.log('Recent posts (last 6h):', recentPosts.length);
  console.log('Older posts (skipped for map):', olderPosts.length);

  const rumors = recentPosts.slice(0, 15).map((post, i) => {
    const classification = classifyPost(post);
    return {
      id: `xrum${String(i).padStart(3, '0')}`,
      date: post.created_at.split('T')[0],
      type: 'rumor',
      source: `@${post.handle} (X) -- ${post.likes} likes, ${post.retweets} RTs`,
      lat: 29 + (Math.random() - 0.5) * 8, // approximate -- will refine with NER later
      lng: 52 + (Math.random() - 0.5) * 10,
      target: post.text.substring(0, 80).replace(/"/g, '\\"'),
      description: post.text.substring(0, 300).replace(/"/g, '\\"').replace(/\n/g, ' ') + ' -- ' + post.url,
      energyRelevance: classification.energyRelevance,
      status: classification.status,
      confidence: classification.confidence
    };
  });

  // Replace rumors variable in HTML
  const rumorsJs = 'var rumors = ' + JSON.stringify(rumors, null, 2)
    .replace(/\\\\"/g, '\\"') + ';';
  
  html = html.replace(/var rumors = \[[\s\S]*?\];/, rumorsJs);

  fs.writeFileSync(MAP_FILE, html);
  console.log(`Updated map with ${rumors.length} X-sourced rumors`);
  return rumors;
}

function pushToGithub() {
  try {
    const timestamp = new Date().toISOString();
    execSync(`cd ${DEPLOY_DIR} && git add map/index.html data/ && git commit -m "Auto-update: X intel feed ${timestamp}" && git push origin main`,
      { stdio: 'pipe' });
    console.log('Pushed to GitHub');
    return true;
  } catch (e) {
    console.log('Git push failed:', e.message.substring(0, 200));
    return false;
  }
}

const SENT_STATE_FILE = path.join(DATA_DIR, 'x-sent-state.json');

function loadSentState() {
  try {
    return JSON.parse(fs.readFileSync(SENT_STATE_FILE, 'utf8'));
  } catch (e) {
    return { sent_ids: [], last_sent_at: null };
  }
}

function saveSentState(state) {
  fs.writeFileSync(SENT_STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  console.log(`Iran Monitor X Feed - ${new Date().toISOString()}`);
  console.log('='.repeat(50));

  const posts = await collectPosts();
  console.log(`Collected ${posts.length} unique posts from OSINT accounts\n`);

  // Load which post IDs were already sent
  const sentState = loadSentState();
  const alreadySent = new Set(sentState.sent_ids || []);

  // Filter to only NEW posts not yet sent
  const newPosts = posts.filter(p => p.id && !alreadySent.has(p.id));
  console.log(`New posts not yet sent: ${newPosts.length} (${posts.length - newPosts.length} already sent, skipped)`);

  // Show top new posts
  newPosts.slice(0, 5).forEach(p => {
    const c = classifyPost(p);
    console.log(`@${p.handle} | ${c.status} | ${c.confidence} conf | ${c.energyRelevance} energy`);
    console.log(`  ${p.text.substring(0, 150)}`);
    console.log(`  ${p.url}\n`);
  });

  // Save raw posts (all, for map)
  fs.writeFileSync(path.join(DATA_DIR, 'x-latest-posts.json'), JSON.stringify(posts, null, 2));

  // Update map (uses all recent posts, not just new ones)
  const rumors = updateMapRumors(posts);

  // Push to GitHub
  pushToGithub();

  // Update sent state with all IDs now known
  const allIds = posts.map(p => p.id).filter(Boolean);
  sentState.sent_ids = [...new Set([...alreadySent, ...allIds])];
  // Keep state file from growing unbounded — keep last 500 IDs
  if (sentState.sent_ids.length > 500) {
    sentState.sent_ids = sentState.sent_ids.slice(-500);
  }
  sentState.last_sent_at = new Date().toISOString();
  saveSentState(sentState);

  console.log('\nDone.');

  // Output new posts for the cron alert (cron runner reads stdout)
  if (newPosts.length === 0) {
    console.log('\nNO_NEW_POSTS');
  } else {
    console.log(`\nNEW_POSTS_COUNT:${newPosts.length}`);
    newPosts.forEach(p => {
      const c = classifyPost(p);
      console.log(`NEW_POST|${c.energyRelevance}|@${p.handle}|${p.text.substring(0, 200)}|${p.url}`);
    });
  }
}

main().catch(console.error);
