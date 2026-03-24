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

// ADS-B Exchange API (RapidAPI) — unfiltered, includes gov/military aircraft
const CREDS_FILE = path.join(__dirname, '..', '.adsbx-credentials.json');
let ADSBX_KEY = null;
try {
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  ADSBX_KEY = creds.rapidapi_key;
} catch { /* fall back to OpenSky */ }

const AIRPORTS = {
  OPKC: { name: 'Islamabad',  country: 'Pakistan',     lat: 33.617, lon: 73.099, context: 'Pakistan back-channel / ISI diplomacy hub',      bbox: [33.55, 72.75, 33.70, 73.15] },
  OOMS: { name: 'Muscat',     country: 'Oman',          lat: 23.593, lon: 58.284, context: 'Primary US-Iran mediation hub (Omani FM)',        bbox: [23.55, 58.20, 23.65, 58.35] },
  OIII: { name: 'Tehran',     country: 'Iran',          lat: 35.689, lon: 51.314, context: 'Iranian capital — inbound = foreign delegation',  bbox: [35.65, 51.30, 35.75, 51.45] },
  LSGG: { name: 'Geneva',     country: 'Switzerland',   lat: 46.238, lon: 6.109,  context: 'Neutral ground — previous US-Iran talks venue',   bbox: [46.22, 6.08, 46.25, 6.13]  },
  LIRF: { name: 'Rome',       country: 'Italy',         lat: 41.800, lon: 12.239, context: 'Earlier talks venue (Feb 2026)',                  bbox: [41.78, 12.22, 41.82, 12.28] },
  OTBH: { name: 'Doha',       country: 'Qatar',         lat: 25.273, lon: 51.608, context: 'Qatar active mediator; also US CENTCOM base',     bbox: [25.26, 51.56, 25.32, 51.62] },
  LLBG: { name: 'Tel Aviv',   country: 'Israel',        lat: 32.011, lon: 34.887, context: 'Israeli capital — senior arrivals = ceasefire talks', bbox: [32.00, 34.87, 32.02, 34.91] },
  OMDB: { name: 'Dubai',      country: 'UAE',           lat: 25.252, lon: 55.364, context: 'UAE back-channel; regional financial hub',        bbox: [25.24, 55.35, 25.26, 55.39] },
};

// Callsign patterns for government/military/diplomatic aircraft.
// Each entry: { prefix: string, minLen?: number, maxLen?: number, note: string }
// minLen/maxLen constrain the digits/suffix after the prefix.
// ALL matches also run against CALLSIGN_EXCLUSIONS before passing.
const DIPLOMATIC_CALLSIGN_RULES = [
  // US Special Air Mission: SAM + 1-4 digits (e.g. SAM001, SAM8640)
  // NOT: SAMU (French air ambulance), SAMA, SAMOS, etc.
  { prefix: 'SAM', suffixPattern: /^\d{1,4}$/, note: 'US Special Air Mission' },
  // US State Dept / DoD charters
  { prefix: 'VENUS', suffixPattern: /^\d+$/, note: 'US State Dept charter' },
  { prefix: 'EXEC',  suffixPattern: /^\d+$/, note: 'US executive fleet' },
  // Allied air forces
  { prefix: 'IRON',  suffixPattern: /^\d+$/, note: 'UK RAF VIP' },
  { prefix: 'GAF',   suffixPattern: /^\d+$/, note: 'German Air Force' },
  { prefix: 'FAF',   suffixPattern: /^\d+$/, note: 'French Air Force' },
  { prefix: 'QAF',   suffixPattern: /^\d+$/, note: 'Qatar Air Force' },
  { prefix: 'PAF',   suffixPattern: /^\d+$/, note: 'Pakistan Air Force' },
  { prefix: 'IRAF',  suffixPattern: /^\d+$/, note: 'Iranian Air Force' },
  { prefix: 'OAF',   suffixPattern: /^\d+$/, note: 'Omani Air Force' },
  // Government/diplomatic callsigns
  { prefix: 'SHB',   suffixPattern: /^\d+$/, note: 'Saudi government' },
  { prefix: 'RFO',   suffixPattern: /^\d+$/, note: 'Russian government' },
  { prefix: 'CCA',   suffixPattern: /^\d+$/, note: 'Chinese state' },
  { prefix: 'CSH',   suffixPattern: /^\d+$/, note: 'Chinese state' },
  { prefix: 'SVR',   suffixPattern: /^\d+$/, note: 'Sovereign' },
  { prefix: 'RSD',   suffixPattern: /^\d+$/, note: 'Russian state delegation' },
  { prefix: 'TCG',   suffixPattern: /^\d+$/, note: 'Turkish government' },
  { prefix: 'IFC',   suffixPattern: /^\d+$/, note: 'Iranian state' },
  { prefix: 'UAEG',  suffixPattern: /^\d+$/, note: 'UAE Government' },
  // Iranian government flights observed at Muscat (no strict suffix required)
  { prefix: 'JJ',    suffixPattern: /^\d{2,3}$/, note: 'Iranian gov (Muscat pattern)' },
];

// Callsigns that must never pass regardless of prefix match
const CALLSIGN_EXCLUSIONS = [
  /^SAMU\d/i,    // French air ambulance (SAMU = Service d'Aide Médicale Urgente)
  /^SAMA\d/i,    // Saudi Arabian Medical Aircraft
  /^UAE\d/i,     // Emirates Airlines commercial
  /^QTR\d/i,     // Qatar Airways commercial
  /^PIA\d/i,     // Pakistan International Airlines
  /^IRA\d/i,     // Iran Air commercial
  /^FIN\d/i,     // Finnair
  /^THY\d/i,     // Turkish Airlines
  /^DLH\d/i,     // Lufthansa
  /^AFR\d/i,     // Air France
  /^BAW\d/i,     // British Airways
];

// Aircraft types that are never diplomatic (hard exclusions by ICAO type code)
const EXCLUDED_AIRCRAFT_TYPES = [
  'EC45', 'EC35', 'H145', 'H135', 'AS50', 'R44', 'R22', // helicopters (mostly EMS/police)
  'B738', 'B737', 'A320', 'A319', 'A321', 'A20N', 'B77W', 'A332', 'A333', // narrowbody/widebody commercial
];

// Government registration prefixes by country (used as secondary signal)
const GOV_REG_PREFIXES = ['EP-', 'A4O-', 'A7-', 'A6-', 'AP-'];

// Government registration prefixes
const GOV_REG_PREFIXES = ['EP-', 'A4O-', 'A7-', 'A6-', 'AP-'];

function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000, ...options }, (res) => {
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

function isDiplomatic(callsign, aircraftType) {
  if (!callsign) return false;
  const cs = callsign.trim().toUpperCase();

  // Hard exclusion: known non-diplomatic callsign patterns
  if (CALLSIGN_EXCLUSIONS.some(re => re.test(cs))) return false;

  // Hard exclusion: known commercial/EMS aircraft types
  if (aircraftType && EXCLUDED_AIRCRAFT_TYPES.includes(aircraftType.toUpperCase())) return false;

  // Match against diplomatic callsign rules
  for (const rule of DIPLOMATIC_CALLSIGN_RULES) {
    if (!cs.startsWith(rule.prefix)) continue;
    const suffix = cs.slice(rule.prefix.length);
    // If a suffix pattern is required, it must match
    if (rule.suffixPattern && !rule.suffixPattern.test(suffix)) continue;
    // If no suffix at all after prefix, skip (bare prefix is too ambiguous)
    if (suffix.length === 0) continue;
    return true;
  }

  return false;
}

async function checkAirportADSBX(code, airport) {
  // ADS-B Exchange API: query by lat/lon/radius (25nm)
  const url = `https://adsbexchange-com1.p.rapidapi.com/v2/lat/${airport.lat}/lon/${airport.lon}/dist/25/`;
  const options = {
    headers: {
      'x-rapidapi-key': ADSBX_KEY,
      'x-rapidapi-host': 'adsbexchange-com1.p.rapidapi.com',
    }
  };
  try {
    const { status, body } = await httpsGet(url, options);
    if (status === 429) { process.stderr.write(`Rate limited on ${code}\n`); return []; }
    if (!body || !body.ac) return [];

    const results = [];
    for (const ac of body.ac) {
      const callsign = (ac.flight || ac.r || '').trim();
      const onGround = ac.gnd === true || ac.alt_baro === 'ground' || (typeof ac.alt_baro === 'number' && ac.alt_baro < 500);
      const alt = typeof ac.alt_baro === 'number' ? ac.alt_baro : 0;

      // Only on ground or low altitude
      if (!onGround && alt > 3000) continue;
      if (!isDiplomatic(callsign, ac.t)) continue;

      results.push({
        icao24: ac.hex || '',
        callsign: callsign || 'UNKNOWN',
        registration: ac.r || '',
        originCountry: ac.cou || ac.ownop || 'Unknown',
        type: ac.t || '',
        onGround,
        altitude: alt,
        airport: code,
        airportName: airport.name,
        country: airport.country,
        context: airport.context,
      });
    }
    return results;
  } catch (e) {
    process.stderr.write(`ADSBx error on ${code}: ${e.message}\n`);
    return [];
  }
}

async function checkAirportOpenSky(code, airport) {
  // Fallback: OpenSky free API
  const { bbox } = airport;
  const url = `https://opensky-network.org/api/states/all?lamin=${bbox[0]}&lomin=${bbox[1]}&lamax=${bbox[2]}&lomax=${bbox[3]}`;
  try {
    const { status, body } = await httpsGet(url);
    if (status === 429) { process.stderr.write(`Rate limited on ${code}\n`); return []; }
    if (!body || !body.states) return [];
    const results = [];
    for (const s of body.states) {
      const [icao24, callsign, originCountry, , , , , alt, onGround] = s;
      if (!onGround && alt && alt > 2000) continue;
      if (!isDiplomatic(callsign, null)) continue;
      results.push({
        icao24, callsign: (callsign || 'UNKNOWN').trim(),
        originCountry: originCountry || 'Unknown', onGround: !!onGround, altitude: alt,
        airport: code, airportName: airport.name, country: airport.country, context: airport.context,
      });
    }
    return results;
  } catch (e) {
    process.stderr.write(`OpenSky error on ${code}: ${e.message}\n`);
    return [];
  }
}

async function checkAirport(code, airport) {
  if (ADSBX_KEY) return checkAirportADSBX(code, airport);
  return checkAirportOpenSky(code, airport);
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

  // Output alerts for cron agent to enrich with news context and send email
  // The cron agent will add diplomatic context, implications, and what-to-watch before emailing
  console.log('ENRICH_AND_EMAIL:true');

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
