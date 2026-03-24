/**
 * Diplomatic Flight Tracker
 * Monitors key airports for government/diplomatic aircraft activity
 * using OpenSky Network free API (no key required)
 *
 * Airports watched:
 *   OPKC - Islamabad (Pakistan)
 *   OOMS - Muscat (Oman, primary mediation hub)
 *   OIII - Tehran Mehrabad (Iran)
 *   LSGG - Geneva (Switzerland, talks venue)
 *   LIRF - Rome Fiumicino (Italy, talks venue)
 *   OTBH - Doha (Qatar, mediator)
 *   LLBG - Tel Aviv Ben Gurion (Israel)
 *   OMDB - Dubai (UAE)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { sendAlert } = require('./email-alert');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'flight-tracker-state.json');

const AIRPORTS = {
  OPKC: { name: 'Islamabad',  country: 'Pakistan',     context: 'Pakistan back-channel / ISI diplomacy hub',      bbox: [33.55, 72.75, 33.70, 73.15] },
  OOMS: { name: 'Muscat',     country: 'Oman',          context: 'Primary US-Iran mediation hub (Omani FM)',        bbox: [23.55, 58.20, 23.65, 58.35] },
  OIII: { name: 'Tehran',     country: 'Iran',          context: 'Iranian capital — inbound = foreign delegation',  bbox: [35.65, 51.30, 35.75, 51.45] },
  LSGG: { name: 'Geneva',     country: 'Switzerland',   context: 'Neutral ground — previous US-Iran talks venue',   bbox: [46.22, 6.08, 46.25, 6.13]  },
  LIRF: { name: 'Rome',       country: 'Italy',         context: 'Earlier talks venue (Feb 2026)',                  bbox: [41.78, 12.22, 41.82, 12.28] },
  OTBH: { name: 'Doha',       country: 'Qatar',         context: 'Qatar active mediator; also US CENTCOM base',     bbox: [25.26, 51.56, 25.32, 51.62] },
  LLBG: { name: 'Tel Aviv',   country: 'Israel',        context: 'Israeli capital — senior arrivals = ceasefire talks', bbox: [32.00, 34.87, 32.02, 34.91] },
  OMDB: { name: 'Dubai',      country: 'UAE',           context: 'UAE back-channel; regional financial hub',        bbox: [25.24, 55.35, 25.26, 55.39] },
};

// Callsign prefixes indicating government/military/diplomatic aircraft
const DIPLOMATIC_CALLSIGNS = [
  'SAM',   // US Special Air Mission (Air Force One family, SecState)
  'VENUS', // US State Dept
  'EXEC',  // US executive fleet
  'IRON',  // UK RAF VIP
  'GAF',   // German Air Force
  'FAF',   // French Air Force
  'QAF',   // Qatar Air Force
  'PAF',   // Pakistan Air Force
  'IRAF',  // Iranian Air Force
  'SHB',   // Saudi gov
  'UAE',   // UAE government
  'RFO',   // Russian government
  'CCA',   // Chinese CAAC state
  'CSH',   // Chinese state
  'SVR',   // Sovereign
  'RSD',   // Russian state delegation
  'TCG',   // Turkish government
  'IFC',   // Iranian state
  'OAF',   // Omani Air Force
];

// Government registration prefixes
const GOV_REG_PREFIXES = ['EP-', 'A4O-', 'A7-', 'A6-', 'AP-'];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seen: {}, alerts: [], lastRun: 0 }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isDiplomatic(callsign) {
  if (!callsign) return false;
  const cs = callsign.trim().toUpperCase();
  return DIPLOMATIC_CALLSIGNS.some(p => cs.startsWith(p));
}

async function checkAirport(code, airport) {
  const { bbox } = airport;
  const url = `https://opensky-network.org/api/states/all?lamin=${bbox[0]}&lomin=${bbox[1]}&lamax=${bbox[2]}&lomax=${bbox[3]}`;

  try {
    const { status, body } = await httpsGet(url);
    if (status === 429) { process.stderr.write(`Rate limited on ${code}\n`); return []; }
    if (!body || !body.states) return [];

    const results = [];
    for (const s of body.states) {
      const [icao24, callsign, originCountry, , , , , alt, onGround] = s;
      // Only on-ground or very low altitude (arriving/departing)
      if (!onGround && alt && alt > 2000) continue;
      if (!isDiplomatic(callsign)) continue;

      results.push({
        icao24,
        callsign: (callsign || 'UNKNOWN').trim(),
        originCountry: originCountry || 'Unknown',
        onGround: !!onGround,
        altitude: alt,
        airport: code,
        airportName: airport.name,
        country: airport.country,
        context: airport.context,
      });
    }
    return results;
  } catch (e) {
    process.stderr.write(`Error checking ${code}: ${e.message}\n`);
    return [];
  }
}

function formatAlertText(alerts) {
  const lines = ['DIPLOMATIC FLIGHT ALERT', '========================', ''];
  const byAirport = {};
  for (const a of alerts) {
    if (!byAirport[a.airport]) byAirport[a.airport] = [];
    byAirport[a.airport].push(a);
  }
  for (const [code, flights] of Object.entries(byAirport)) {
    const ap = AIRPORTS[code];
    lines.push(`${ap.name} (${code}) — ${ap.country}`);
    lines.push(`Context: ${ap.context}`);
    for (const f of flights) {
      const status = f.onGround ? 'on ground' : `low altitude ${Math.round(f.altitude || 0)}m`;
      lines.push(`  • ${f.callsign} | Origin: ${f.originCountry} | ${status}`);
    }
    lines.push('');
  }
  lines.push(`Detected: ${new Date().toUTCString()}`);
  lines.push('Source: OpenSky Network ADS-B');
  return lines.join('\n');
}

function formatAlertHtml(alerts) {
  const byAirport = {};
  for (const a of alerts) {
    if (!byAirport[a.airport]) byAirport[a.airport] = [];
    byAirport[a.airport].push(a);
  }

  let rows = '';
  for (const [code, flights] of Object.entries(byAirport)) {
    const ap = AIRPORTS[code];
    rows += `<tr style="background:#1a1a2e"><td colspan="4" style="padding:10px 12px;font-weight:bold;color:#00ff88;font-size:14px">
      ${ap.name} (${code}) — ${ap.country}
      <br><span style="font-size:11px;color:#aaa;font-weight:normal">${ap.context}</span>
    </td></tr>`;
    for (const f of flights) {
      const status = f.onGround ? 'On ground' : `Low alt ${Math.round(f.altitude || 0)}m`;
      rows += `<tr>
        <td style="padding:8px 12px;font-family:monospace;color:#fff">${f.callsign}</td>
        <td style="padding:8px 12px;color:#ccc">${f.originCountry}</td>
        <td style="padding:8px 12px;color:#ffaa00">${status}</td>
      </tr>`;
    }
  }

  return `<!DOCTYPE html><html><body style="background:#0a0a0a;color:#e0e0e0;font-family:Arial,sans-serif;padding:24px;max-width:600px">
  <div style="background:#111;border:1px solid #333;border-radius:8px;overflow:hidden">
    <div style="background:#0d0d0d;padding:16px 20px;border-bottom:1px solid #333">
      <h2 style="margin:0;color:#00ff88;font-family:monospace;letter-spacing:2px;font-size:16px">DIPLOMATIC FLIGHT ALERT</h2>
      <p style="margin:4px 0 0;color:#888;font-size:12px">${new Date().toUTCString()} — Iran Conflict Monitor</p>
    </div>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <div style="padding:12px 16px;border-top:1px solid #333;font-size:11px;color:#666">
      Source: OpenSky Network ADS-B &nbsp;|&nbsp; Government/diplomatic callsigns only
    </div>
  </div>
</body></html>`;
}

async function main() {
  const state = loadState();
  const now = Date.now();
  const newAlerts = [];

  for (const [code, airport] of Object.entries(AIRPORTS)) {
    const flights = await checkAirport(code, airport);

    for (const f of flights) {
      const key = `${f.icao24}:${code}`;
      const lastSeen = state.seen[key];
      // Only alert if not seen in last 6 hours
      if (!lastSeen || (now - lastSeen) > 6 * 60 * 60 * 1000) {
        newAlerts.push(f);
        state.seen[key] = now;
      }
    }

    await new Promise(r => setTimeout(r, 600)); // polite delay
  }

  // Clean stale state (>24h)
  for (const key of Object.keys(state.seen)) {
    if (now - state.seen[key] > 24 * 60 * 60 * 1000) delete state.seen[key];
  }

  state.lastRun = now;

  if (newAlerts.length === 0) {
    console.log('NO_NEW_ACTIVITY');
    saveState(state);
    return;
  }

  // Save alert history (keep last 100)
  if (!state.alerts) state.alerts = [];
  state.alerts.unshift({ ts: now, flights: newAlerts });
  if (state.alerts.length > 100) state.alerts = state.alerts.slice(0, 100);
  saveState(state);

  // Send email directly
  try {
    const subject = `Diplomatic Flight Alert — ${newAlerts.map(a => a.airportName).filter((v,i,arr) => arr.indexOf(v)===i).join(', ')}`;
    await sendAlert({
      subject,
      text: formatAlertText(newAlerts),
      html: formatAlertHtml(newAlerts),
    });
    process.stderr.write(`Email sent to recipients\n`);
  } catch (e) {
    process.stderr.write(`Email failed: ${e.message}\n`);
  }

  // Print for cron agent to relay to Telegram
  console.log(`NEW_ACTIVITY_COUNT:${newAlerts.length}`);
  const byAirport = {};
  for (const a of newAlerts) {
    if (!byAirport[a.airport]) byAirport[a.airport] = [];
    byAirport[a.airport].push(a);
  }
  for (const [code, flights] of Object.entries(byAirport)) {
    const ap = AIRPORTS[code];
    console.log(`\nAIRPORT:${code} (${ap.name}, ${ap.country})`);
    console.log(`CONTEXT: ${ap.context}`);
    for (const f of flights) {
      const status = f.onGround ? 'on ground' : `altitude ${Math.round(f.altitude || 0)}m`;
      console.log(`  FLIGHT: ${f.callsign} | Origin: ${f.originCountry} | ${status}`);
    }
  }
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(1);
});
