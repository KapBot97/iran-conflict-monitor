/**
 * Diplomatic Flight Tracker — Enhanced v2
 *
 * Three detection layers:
 *   1. Callsign pattern matching (original)
 *   2. Military registration pattern + ICAO hex watchlist (NEW)
 *   3. "Track the other end" — diplomatic jets departing hub airports toward Iran (NEW)
 *
 * Airports watched:
 *   OPKC - Islamabad     OOMS - Muscat       OIII - Tehran
 *   LSGG - Geneva        LIRF - Rome          OTBH - Doha
 *   LLBG - Tel Aviv      OMDB - Dubai         OERK - Riyadh (added)
 *   LTFM - Istanbul      HECA - Cairo         OAKB - Kabul
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { sendAlert } = require('./email-alert');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'flight-tracker-state.json');

const CREDS_FILE = path.join(__dirname, '..', '.adsbx-credentials.json');
let ADSBX_KEY = null;
try { ADSBX_KEY = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')).rapidapi_key; } catch {}

// ── AIRPORTS ──────────────────────────────────────────────────────────────
const AIRPORTS = {
  OPKC: { name:'Islamabad',  country:'Pakistan',     lat:33.617, lon:73.099,  context:'Active US-Iran back-channel hub; Pakistan FM hosting talks' },
  OOMS: { name:'Muscat',     country:'Oman',          lat:23.593, lon:58.284,  context:'Primary US-Iran mediation hub (Omani FM)' },
  OIII: { name:'Tehran',     country:'Iran',          lat:35.689, lon:51.314,  context:'Iranian capital — inbound foreign delegation is major signal' },
  LSGG: { name:'Geneva',     country:'Switzerland',   lat:46.238, lon:6.109,   context:'Neutral ground — previous US-Iran nuclear talks venue' },
  LIRF: { name:'Rome',       country:'Italy',         lat:41.800, lon:12.239,  context:'Earlier talks venue (Feb 2026)' },
  OTBH: { name:'Doha',       country:'Qatar',         lat:25.273, lon:51.608,  context:'Qatar active mediator; US CENTCOM base' },
  LLBG: { name:'Tel Aviv',   country:'Israel',        lat:32.011, lon:34.887,  context:'Israeli capital — arrivals could signal ceasefire talks' },
  OMDB: { name:'Dubai',      country:'UAE',           lat:25.252, lon:55.364,  context:'UAE back-channel and regional financial hub' },
  OERK: { name:'Riyadh',     country:'Saudi Arabia',  lat:24.957, lon:46.698,  context:'Saudi FM active in regional diplomacy; MBS hosting leaders' },
  LTFM: { name:'Istanbul',   country:'Turkey',        lat:41.262, lon:28.727,  context:'Turkey passing messages between US and Iran' },
  HECA: { name:'Cairo',      country:'Egypt',         lat:30.122, lon:31.406,  context:'Egypt mediating; FM Abdelatty active in US-Iran track' },
};

// Hub airports — "track the other end" source airports
// Any diplomatic aircraft here heading toward Iran/Gulf theater = alert
const HUB_AIRPORTS = {
  KIAD: { name:'Washington Dulles', country:'USA',    lat:38.944, lon:-77.456, context:'US State Dept / NSC departures' },
  KJFK: { name:'New York JFK',      country:'USA',    lat:40.641, lon:-73.778, context:'UN-related diplomatic flights' },
  EGLL: { name:'London Heathrow',   country:'UK',     lat:51.477, lon:-0.461,  context:'UK government / FCO departures' },
  LFPB: { name:'Paris Le Bourget',  country:'France', lat:48.969, lon:2.441,   context:'French government flights (Le Bourget = VIP terminal)' },
  EDDB: { name:'Berlin Brandenburg',country:'Germany',lat:52.366, lon:13.503,  context:'German government flights' },
  UUWW: { name:'Moscow Vnukovo',    country:'Russia', lat:55.591, lon:37.261,  context:'Russian government — IL-96, Tu-214 state fleet' },
  ZBAA: { name:'Beijing Capital',   country:'China',  lat:40.080, lon:116.584, context:'Chinese state flights — potential Iran back-channel' },
};

// ── LAYER 1: CALLSIGN RULES ───────────────────────────────────────────────
const CALLSIGN_RULES = [
  { prefix:'SAM',   suffix:/^\d{1,4}$/, note:'US Special Air Mission' },
  { prefix:'VENUS', suffix:/^\d+$/,     note:'US State Dept charter' },
  { prefix:'EXEC',  suffix:/^\d+$/,     note:'US executive fleet' },
  { prefix:'IRON',  suffix:/^\d+$/,     note:'UK RAF VIP' },
  { prefix:'RRR',   suffix:/^\d+$/,     note:'UK Royal Air Force state' },
  { prefix:'GAF',   suffix:/^\d+$/,     note:'German Air Force' },
  { prefix:'FAF',   suffix:/^\d+$/,     note:'French Air Force' },
  { prefix:'QAF',   suffix:/^\d+$/,     note:'Qatar Air Force' },
  { prefix:'PAF',   suffix:/^\d+$/,     note:'Pakistan Air Force' },
  { prefix:'IRAF',  suffix:/^\d+$/,     note:'Iranian Air Force' },
  { prefix:'OAF',   suffix:/^\d+$/,     note:'Omani Air Force' },
  { prefix:'SHB',   suffix:/^\d+$/,     note:'Saudi government' },
  { prefix:'RFO',   suffix:/^\d+$/,     note:'Russian government' },
  { prefix:'TCG',   suffix:/^\d+$/,     note:'Turkish government' },
  { prefix:'UAEG',  suffix:/^\d+$/,     note:'UAE Government' },
  { prefix:'SVR',   suffix:/^\d+$/,     note:'Sovereign/state' },
  { prefix:'RSD',   suffix:/^\d+$/,     note:'Russian state delegation' },
];

const CALLSIGN_EXCLUSIONS = [
  /^SAMU\d/i, /^SAMA\d/i, /^UAE\d/i, /^QTR\d/i,
  /^PIA\d/i,  /^IRA\d/i,  /^THY\d/i, /^DLH\d/i,
  /^AFR\d/i,  /^BAW\d/i,  /^FIN\d/i,
];

// ── LAYER 2A: MILITARY REGISTRATION PATTERNS ─────────────────────────────
// Registrations matching these patterns = likely military/gov even without callsign
const MIL_REG_PATTERNS = [
  { re:/^\d{2}-\d{4,5}$/,  country:'USA',     note:'US military serial (e.g. 58-0030, 18-46048)' },
  { re:/^\d{3}-\d{4,5}$/,  country:'USA',     note:'US military serial (3-digit prefix)' },
  { re:/^ZZ-/,             country:'UK',      note:'UK military registration' },
  { re:/^ZJ-/,             country:'UK',      note:'UK RAF special ops' },
  { re:/^ZH-/,             country:'UK',      note:'UK RAF' },
  { re:/^ZK-[A-Z]{3}$/,    country:'UK',      note:'UK military' },
  { re:/^F-[A-Z]{2}\d+$/,  country:'France',  note:'French military/gov' },
  { re:/^15\+\d{2}$/,      country:'Germany', note:'German Air Force' },
  { re:/^16\+\d{2}$/,      country:'Germany', note:'German Air Force' },
  { re:/^17\+\d{2}$/,      country:'Germany', note:'German Air Force' },
  { re:/^A7-/,             country:'Qatar',   note:'Qatar government/military' },
  { re:/^A6-/,             country:'UAE',     note:'UAE government' },
  { re:/^AP-/,             country:'Pakistan',note:'Pakistani government' },
  { re:/^EP-/,             country:'Iran',    note:'Iranian government' },
  { re:/^A4O-/,            country:'Oman',    note:'Omani government' },
  { re:/^HZ-/,             country:'Saudi',   note:'Saudi government' },
  { re:/^RA-/,             country:'Russia',  note:'Russian state aircraft' },
];

// ── LAYER 2B: ICAO HEX WATCHLIST ─────────────────────────────────────────
// Known diplomatic/VIP aircraft hex codes
const HEX_WATCHLIST = {
  'AE0401': 'US Air Force One (VC-25A)',
  'AE04CB': 'US E-4B Nightwatch (doomsday plane)',
  'AE0400': 'US Air Force One (VC-25A alt)',
  'AE067D': 'US C-32A (Air Force Two)',
  'AE4C8D': 'US C-32A State Dept',
  'AE01CE': 'US E-3 Sentry AWACS',
  'AE0536': 'US RC-135 Rivet Joint',
  '43C154': 'UK RAF Voyager (VIP)',
  '43C6C3': 'UK RAF Voyager (VIP)',
  '3C7580': 'German Air Force A340',
  '3C759D': 'German Air Force A321',
  '738E94': 'Qatar Amiri Flight',
};

// ── LAYER 2C: DIPLOMATIC AIRCRAFT TYPES ──────────────────────────────────
// These types at diplomatic airports = always flag (even without matching callsign/reg)
const DIPLOMATIC_TYPES = [
  'VC25', 'C32',  'C40',  'C17',  'C5',   'C130', 'E4',   'E3',
  'RC135','KC135','B742', 'B752', 'B762', 'B772', // common gov/mil widebodies
  'IL96', 'TU214','IL62', // Russian state
  'A319', // common gov VIP config (Merkel's plane was A319)
  'F900', 'GL5T', 'GLEX', 'G650', 'G550', 'G500', // bizjets used by foreign ministries
];

// Commercial aircraft types — never flag these regardless of other signals
const COMMERCIAL_EXCLUSIONS = [
  'B738','B737','B739','B38M','B39M','A320','A20N','A319','A21N','A321',
  'A332','A333','A338','A339','A35K','B77W','B788','B789','B78X',
  'EC45','EC35','H145','H135','R44', // EMS helicopters
];

// ── LAYER 3: TRACK-THE-OTHER-END ─────────────────────────────────────────
// Bounding box for the Iran / Gulf theater
// Any diplomatic aircraft departing hub airports and currently inside this box = alert
const THEATER_BBOX = { latMin:20, latMax:40, lonMin:44, lonMax:65 };

function inTheaterBox(lat, lon) {
  if (!lat || !lon) return false;
  return lat >= THEATER_BBOX.latMin && lat <= THEATER_BBOX.latMax &&
         lon >= THEATER_BBOX.lonMin && lon <= THEATER_BBOX.lonMax;
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout:12000, ...options }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status:res.statusCode, body:JSON.parse(data) }); }
        catch { resolve({ status:res.statusCode, body:null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function adsbxQuery(lat, lon, distNm = 40) {
  const url = `https://adsbexchange-com1.p.rapidapi.com/v2/lat/${lat}/lon/${lon}/dist/${distNm}/`;
  return httpsGet(url, { headers:{
    'x-rapidapi-key': ADSBX_KEY,
    'x-rapidapi-host': 'adsbexchange-com1.p.rapidapi.com',
  }});
}

// Military-only endpoint — returns military traffic globally
function adsbxMilQuery(lat, lon, distNm = 60) {
  const url = `https://adsbexchange-com1.p.rapidapi.com/v2/mil/lat/${lat}/lon/${lon}/dist/${distNm}/`;
  return httpsGet(url, { headers:{
    'x-rapidapi-key': ADSBX_KEY,
    'x-rapidapi-host': 'adsbexchange-com1.p.rapidapi.com',
  }});
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seen:{}, alerts:[], lastRun:0 }; }
}

function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null,2)); }

// ── DETECTION LOGIC ───────────────────────────────────────────────────────
function classifyAircraft(ac) {
  const callsign = (ac.flight || '').trim().toUpperCase();
  const reg      = (ac.r     || '').trim().toUpperCase();
  const type     = (ac.t     || '').trim().toUpperCase();
  const hex      = (ac.hex   || '').trim().toLowerCase();

  // Hard exclusions
  if (COMMERCIAL_EXCLUSIONS.includes(type)) return null;
  if (CALLSIGN_EXCLUSIONS.some(re => re.test(callsign))) return null;

  // Layer 2b: ICAO hex watchlist — highest confidence
  if (HEX_WATCHLIST[hex]) {
    return { layer:2, signal:'hex-watchlist', note:HEX_WATCHLIST[hex], confidence:'HIGH' };
  }

  // Layer 1: callsign rules
  if (callsign) {
    for (const rule of CALLSIGN_RULES) {
      if (!callsign.startsWith(rule.prefix)) continue;
      const suffix = callsign.slice(rule.prefix.length);
      if (rule.suffix && !rule.suffix.test(suffix)) continue;
      if (suffix.length === 0) continue;
      return { layer:1, signal:'callsign', note:rule.note, confidence:'HIGH' };
    }
  }

  // Layer 2a: military registration pattern
  if (reg) {
    for (const pat of MIL_REG_PATTERNS) {
      if (pat.re.test(reg)) {
        return { layer:2, signal:'mil-reg', note:pat.note+' ('+pat.country+')', confidence:'MEDIUM' };
      }
    }
  }

  // Layer 2c: diplomatic aircraft type at a watched airport
  if (DIPLOMATIC_TYPES.includes(type)) {
    return { layer:2, signal:'diplo-type', note:'Diplomatic aircraft type: '+type, confidence:'MEDIUM' };
  }

  return null;
}

function buildFlightRecord(ac, airportCode, airportInfo, detection, layer3=false) {
  const onGround = ac.gnd === true || ac.alt_baro === 'ground' ||
                   (typeof ac.alt_baro === 'number' && ac.alt_baro < 500);
  return {
    icao24:      (ac.hex || '').toLowerCase(),
    callsign:    (ac.flight || '').trim() || (ac.r || 'UNKNOWN'),
    registration:(ac.r || ''),
    type:        (ac.t || ''),
    country:     ac.cou || ac.ownop || 'Unknown',
    onGround,
    altitude:    typeof ac.alt_baro === 'number' ? ac.alt_baro : 0,
    lat:         ac.lat, lon: ac.lon,
    airport:     airportCode,
    airportName: airportInfo.name,
    airportCountry: airportInfo.country,
    context:     airportInfo.context,
    detection:   detection.note,
    confidence:  detection.confidence,
    signal:      detection.signal,
    layer3,
  };
}

// ── LAYER 3: SCAN HUB AIRPORTS FOR OUTBOUND DIPLO FLIGHTS ────────────────
async function scanHubAirports() {
  const found = [];
  for (const [code, hub] of Object.entries(HUB_AIRPORTS)) {
    try {
      const { status, body } = await adsbxQuery(hub.lat, hub.lon, 50);
      if (status !== 200 || !body?.ac) continue;
      for (const ac of body.ac) {
        const det = classifyAircraft(ac);
        if (!det) continue;
        // Only interested if the aircraft is airborne and heading toward theater
        const onGround = ac.gnd === true || ac.alt_baro === 'ground';
        if (onGround) continue;
        // Check if current position is inside theater box (already en-route)
        // OR if track heading (ac.track) roughly points toward theater from hub
        const heading = ac.track;
        const hubLon  = hub.lon;
        // Simple heuristic: hub is west of theater (lon < 44); heading 60-160 = toward theater
        const headingTowardTheater = hubLon < 30
          ? (heading >= 60 && heading <= 160)   // Western hubs: east/southeast
          : (heading >= 100 && heading <= 200);  // Eastern hubs: southeast

        if (inTheaterBox(ac.lat, ac.lon) || headingTowardTheater) {
          found.push(buildFlightRecord(ac, code, {
            ...hub,
            context: hub.context + ' → heading toward Iran/Gulf theater',
          }, { ...det, note: det.note + ' (outbound from '+hub.name+')' }, true));
        }
      }
      await new Promise(r => setTimeout(r, 700));
    } catch (e) {
      process.stderr.write(`Hub scan error ${code}: ${e.message}\n`);
    }
  }
  return found;
}

// ── MAIN AIRPORT SCAN ─────────────────────────────────────────────────────
async function scanAirport(code, airport) {
  if (!ADSBX_KEY) return [];
  const found = [];

  // Standard civilian ADS-B feed
  try {
    const { status, body } = await adsbxQuery(airport.lat, airport.lon, 30);
    if (status === 200 && body?.ac) {
      for (const ac of body.ac) {
        const det = classifyAircraft(ac);
        if (!det) continue;
        const onGround = ac.gnd === true || ac.alt_baro === 'ground' ||
                         (typeof ac.alt_baro === 'number' && ac.alt_baro < 500);
        if (!onGround && (ac.alt_baro || 0) > 5000) continue; // skip high overflights
        found.push(buildFlightRecord(ac, code, airport, det));
      }
    }
    await new Promise(r => setTimeout(r, 700));
  } catch (e) {
    process.stderr.write(`Scan error ${code}: ${e.message}\n`);
  }

  // Military-only endpoint (catches callsign-dark military traffic)
  try {
    const { status, body } = await adsbxMilQuery(airport.lat, airport.lon, 50);
    if (status === 200 && body?.ac) {
      const existingHexes = new Set(found.map(f => f.icao24));
      for (const ac of body.ac) {
        if (existingHexes.has((ac.hex||'').toLowerCase())) continue; // already found
        const det = classifyAircraft(ac);
        // Military endpoint — if no other match, flag as mil-traffic
        const detection = det || { layer:2, signal:'mil-endpoint', note:'Military traffic (ADS-B mil feed)', confidence:'MEDIUM' };
        const onGround = ac.gnd === true || ac.alt_baro === 'ground' ||
                         (typeof ac.alt_baro === 'number' && ac.alt_baro < 500);
        if (!onGround && (ac.alt_baro || 0) > 8000) continue;
        found.push(buildFlightRecord(ac, code, airport, detection));
      }
    }
    await new Promise(r => setTimeout(r, 700));
  } catch (e) {
    // Military endpoint may not be available on all tiers — silently skip
  }

  return found;
}

// ── FORMAT OUTPUT ─────────────────────────────────────────────────────────
function formatOutput(alerts) {
  const byAirport = {};
  for (const a of alerts) {
    const key = a.layer3 ? `HUB:${a.airport}` : a.airport;
    if (!byAirport[key]) byAirport[key] = [];
    byAirport[key].push(a);
  }

  let out = `NEW_ACTIVITY_COUNT:${alerts.length}\n`;
  for (const [key, flights] of Object.entries(byAirport)) {
    const f0 = flights[0];
    out += `\nAIRPORT:${key} (${f0.airportName}, ${f0.airportCountry})\n`;
    out += `CONTEXT: ${f0.context}\n`;
    for (const f of flights) {
      const status = f.onGround ? 'on ground' : `altitude ${Math.round(f.altitude)}ft`;
      out += `  FLIGHT: ${f.callsign} | Reg: ${f.registration} | Type: ${f.type} | ${f.country} | ${status} | [${f.confidence}] ${f.detection}\n`;
    }
  }
  return out;
}

// ── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  const state = loadState();
  const now   = Date.now();
  const newAlerts = [];

  // Scan watched diplomatic airports
  for (const [code, airport] of Object.entries(AIRPORTS)) {
    const flights = await scanAirport(code, airport);
    for (const f of flights) {
      const key = `${f.icao24}:${code}`;
      if (!state.seen[key] || (now - state.seen[key]) > 4 * 3600000) {
        newAlerts.push(f);
        state.seen[key] = now;
      }
    }
  }

  // Layer 3: scan hub airports for outbound diplomatic flights toward theater
  const hubFlights = await scanHubAirports();
  for (const f of hubFlights) {
    const key = `hub:${f.icao24}`;
    if (!state.seen[key] || (now - state.seen[key]) > 4 * 3600000) {
      newAlerts.push(f);
      state.seen[key] = now;
    }
  }

  // Clean stale state (>48h)
  for (const key of Object.keys(state.seen)) {
    if (now - state.seen[key] > 48 * 3600000) delete state.seen[key];
  }

  state.lastRun = now;

  if (newAlerts.length === 0) {
    console.log('NO_NEW_ACTIVITY');
    saveState(state);
    return;
  }

  if (!state.alerts) state.alerts = [];
  state.alerts.unshift({ ts:now, flights:newAlerts });
  if (state.alerts.length > 100) state.alerts = state.alerts.slice(0,100);
  saveState(state);

  console.log(formatOutput(newAlerts));
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(1);
});
