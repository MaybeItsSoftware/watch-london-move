#!/usr/bin/env node
/**
 * Probe: is TfL's URA (Countdown) interface still a faithful stand-in for
 * /Mode/bus/Arrivals?
 *
 *   node scripts/ura-probe.js
 *
 * Fetches both feeds back to back, reduces each to canonical vehicles, and
 * reports coverage, agreement and cost. It answered "yes, migrate" once; it now
 * runs on a timer, because URA is a 2012 interface TfL no longer lists on its
 * open-data pages and periodic re-verification is the price of using it.
 *
 * This talks to TfL directly rather than to our own service, which is the point:
 * `feed-check.js` can only see that our parse of URA is self-consistent, and
 * would report a serene PASS while URA quietly stopped agreeing with the feed
 * everyone else reads. Only a second opinion catches that, so the exit code is
 * judged on coverage and agreement rather than left for someone to eyeball.
 */
// URA legitimately runs a little behind the Unified feed and a bus that has just
// passed its last stop drops out of one before the other, so exact parity is the
// wrong bar. These are set well below the observed figures (99.4% coverage,
// 99.5% route agreement) to catch a regime change, not ordinary drift.
const MIN_COVERAGE = 0.8;
const MIN_ROUTE_AGREEMENT = 0.95;
const https = require('https');
const zlib = require('zlib');

const URA = 'https://countdown.api.tfl.gov.uk/interfaces/ura/instant_V1';
const UNIFIED = 'https://api.tfl.gov.uk/Mode/bus/Arrivals?count=-1';

/**
 * URA returns the requested fields in ITS OWN canonical order, not the order
 * they were asked for — a subset preserves this sequence with the unrequested
 * entries removed. Getting this wrong silently transposes latitude and line
 * name, so the order below is the contract and must match the ReturnList.
 */
const FIELDS = ['StopPointName', 'StopID', 'StopCode1', 'StopCode2', 'Latitude', 'Longitude',
                'VisitNumber', 'LineName', 'DirectionID', 'DestinationText', 'VehicleID',
                'RegistrationNumber', 'EstimatedTime'];

// StopCode2 is the NaPTAN id — the same identifier space the Unified API uses in
// naptanId. StopID is a URA-internal code and StopCode1 is the SMS code, so
// neither joins to anything the rest of the system knows about.
const NAPTAN = 'StopCode2';

function get(url) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    https.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location));
      }
      const chunks = [];
      let wire = 0;
      const sink = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      res.on('data', (c) => { wire += c.length; });
      sink.on('data', (c) => chunks.push(c));
      sink.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        wire, ms: Date.now() - started, status: res.statusCode,
      }));
      sink.on('error', reject);
    }).on('error', reject);
  });
}

/** URA rows -> one record per vehicle, nearest stop first. */
function reduceUra(body) {
  const byVehicle = new Map();
  for (const line of body.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row[0] !== 1) continue;
    const r = {};
    FIELDS.forEach((f, i) => { r[f] = row[i + 1]; });
    // Keyed on the registration, not URA's VehicleID. The two feeds use
    // different identity spaces — URA's VehicleID is an internal fleet number
    // (16311) while the Unified API's vehicleId is the plate (LK67CYA) — and
    // URA's RegistrationNumber is that same plate. Keying on it keeps vehicle
    // identity stable across a migration, so clients do not see the whole fleet
    // vanish and reappear at cutover.
    if (!r.RegistrationNumber) continue;
    const key = String(r.RegistrationNumber);
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push(r);
  }
  const out = new Map();
  for (const [id, rows] of byVehicle) {
    rows.sort((a, b) => a.EstimatedTime - b.EstimatedTime);
    out.set(id, {
      id, fleetId: rows[0].VehicleID, line: String(rows[0].LineName),
      lat: rows[0].Latitude, lon: rows[0].Longitude,
      stop: rows[0].StopPointName, stopId: rows[0][NAPTAN], destination: rows[0].DestinationText,
      dueAt: rows[0].EstimatedTime, stops: rows.length,
    });
  }
  return out;
}

/** Unified API rows -> the same shape, using its own next-stop logic. */
function reduceUnified(body) {
  const rows = JSON.parse(body);
  const byVehicle = new Map();
  for (const r of rows) {
    if (!r.vehicleId || !r.naptanId) continue;
    if (!byVehicle.has(r.vehicleId)) byVehicle.set(r.vehicleId, []);
    byVehicle.get(r.vehicleId).push(r);
  }
  const out = new Map();
  for (const [id, list] of byVehicle) {
    // expectedArrival, not timeToStation: the whole-network endpoint omits
    // timeToStation entirely (confirmed against a live response), so sorting on
    // it silently orders by NaN and picks an arbitrary "next" stop. The server's
    // expectedArrivalMs already falls through to this field for the same reason.
    list.sort((a, b) => Date.parse(a.expectedArrival) - Date.parse(b.expectedArrival));
    out.set(String(id), {
      id: String(id), line: String(list[0].lineName), stop: list[0].stationName,
      naptan: list[0].naptanId, dueAt: Date.parse(list[0].expectedArrival),
      destination: list[0].destinationName, stops: list.length,
    });
  }
  return out;
}

const kb = (n) => (n / 1024).toFixed(0) + ' KB';

(async () => {
  const uraUrl = `${URA}?ReturnList=${FIELDS.join(',')}&Circle=51.5072,-0.1276,40000`;
  const [ura, uni] = await Promise.all([get(uraUrl), get(UNIFIED)]);

  console.log('cost');
  console.log('  URA      ', kb(ura.wire), 'wire,', kb(ura.body.length), 'parsed,', ura.ms + 'ms');
  console.log('  Unified  ', kb(uni.wire), 'wire,', kb(uni.body.length), 'parsed,', uni.ms + 'ms');
  console.log('  ratio    ', (uni.wire / ura.wire).toFixed(1) + 'x less wire,',
              (uni.body.length / ura.body.length).toFixed(1) + 'x less to parse');

  const u = reduceUra(ura.body);
  const n = reduceUnified(uni.body);
  console.log('\ncoverage');
  console.log('  vehicles  URA', u.size, '| Unified', n.size);
  const inBoth = [...u.keys()].filter((k) => n.has(k));
  console.log('  in both  ', inBoth.length,
              '(' + (100 * inBoth.length / Math.max(u.size, n.size)).toFixed(1) + '% of the larger)');

  let sameLine = 0, sameStop = 0, sameStopId = 0;
  const skew = [];
  for (const k of inBoth) {
    if (u.get(k).line === n.get(k).line) sameLine += 1;
    if (u.get(k).stop === n.get(k).stop) sameStop += 1;
    if (String(u.get(k).stopId) === String(n.get(k).naptan)) sameStopId += 1;
    const d = Math.abs(u.get(k).dueAt - n.get(k).dueAt);
    if (Number.isFinite(d)) skew.push(d);
  }
  skew.sort((a, b) => a - b);
  console.log('\nagreement on shared vehicles');
  console.log('  same route     ', sameLine, '/', inBoth.length,
              '(' + (100 * sameLine / inBoth.length).toFixed(1) + '%)');
  console.log('  same next stop ', sameStop, '/', inBoth.length,
              '(' + (100 * sameStop / inBoth.length).toFixed(1) + '%) by name');
  console.log('  same next stop ', sameStopId, '/', inBoth.length,
              '(' + (100 * sameStopId / inBoth.length).toFixed(1) + '%) by stop id');
  console.log('  ETA skew        median', (skew[Math.floor(skew.length/2)]/1000).toFixed(0) + 's,',
              'p90', (skew[Math.floor(skew.length*0.9)]/1000).toFixed(0) + 's');

  const sample = u.get(inBoth[0]);
  console.log('\nsample URA vehicle');
  console.log(' ', JSON.stringify(sample));

  // The verdict. Coverage is measured against Unified rather than against an
  // absolute count so the check holds at 3am as well as at rush hour: both feeds
  // shrink overnight together, and it is the gap between them that means
  // anything.
  const coverage = n.size > 0 ? u.size / n.size : 0;
  const routeAgreement = inBoth.length > 0 ? sameLine / inBoth.length : 0;
  const failures = [];
  if (coverage < MIN_COVERAGE) {
    failures.push(`URA carries ${(coverage * 100).toFixed(1)}% of the vehicles Unified does `
      + `(floor ${MIN_COVERAGE * 100}%) — it is no longer seeing the whole network`);
  }
  if (routeAgreement < MIN_ROUTE_AGREEMENT) {
    failures.push(`the two feeds agree on the route of ${(routeAgreement * 100).toFixed(1)}% of `
      + `shared vehicles (floor ${MIN_ROUTE_AGREEMENT * 100}%) — suspect a field-order change`);
  }

  console.log('');
  if (failures.length > 0) {
    for (const reason of failures) {
      console.error(`DRIFT: ${reason}`);
    }
    console.error('verdict: FAIL — buses have no other feed; see backend/DEPLOY.md.');
    process.exit(1);
  }
  console.log(`verdict: PASS — ${(coverage * 100).toFixed(1)}% coverage, `
    + `${(routeAgreement * 100).toFixed(1)}% route agreement.`);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
