// Fetchers for each free public source. Each returns plain data or throws;
// the runner records failures per source so one outage doesn't hide the rest.

const UA = 'home-watch (home hazard monitor)';

async function get(url, { type = 'json', headers = {}, timeoutMs = 25000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return type === 'json' ? res.json() : res.text();
}

// ---------- Open-Meteo: forecast + 92 days of history for fire weather ----------
const HOURLY = [
  'temperature_2m', 'relative_humidity_2m', 'precipitation', 'snowfall',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'weather_code', 'cape',
].join(',');
const DAILY = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum',
  'snowfall_sum', 'wind_gusts_10m_max', 'wind_direction_10m_dominant', 'uv_index_max',
].join(',');

export async function openMeteo(place, { pastDays = 0 } = {}) {
  const q = new URLSearchParams({
    latitude: place.lat, longitude: place.lon, timezone: 'Pacific/Auckland',
    hourly: HOURLY, daily: DAILY, forecast_days: 7, past_days: pastDays,
    current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,precipitation',
  });
  return get(`https://api.open-meteo.com/v1/forecast?${q}`);
}

export async function airQuality(place) {
  const q = new URLSearchParams({
    latitude: place.lat, longitude: place.lon, timezone: 'Pacific/Auckland',
    hourly: 'pm2_5,pm10', forecast_days: 3,
  });
  return get(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`);
}

// GloFAS river discharge model. Coarse (5 km grid) — a trend, not a gauge reading.
export async function riverFlow(river) {
  const q = new URLSearchParams({
    latitude: river.lat, longitude: river.lon,
    daily: 'river_discharge,river_discharge_max', past_days: 7, forecast_days: 14,
  });
  return get(`https://flood-api.open-meteo.com/v1/flood?${q}`);
}

// ---------- MetService CAP warnings (official) ----------
export async function metserviceCap() {
  const rss = await get('https://alerts.metservice.com/cap/rss', { type: 'text' });
  const links = [...rss.matchAll(/<link>\s*([^<]+?)\s*<\/link>/g)].map((m) => m[1])
    .filter((l) => /cap\/alert|\.xml|id=/.test(l));
  const alerts = [];
  for (const link of links) {
    try { alerts.push(parseCap(await get(link, { type: 'text' }), link)); }
    catch (e) { alerts.push({ error: String(e.message || e), link }); }
  }
  return alerts;
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
};
const tags = (xml, name) =>
  [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g'))].map((m) => m[1].trim());

export function parseCap(xml, link = null) {
  const info = tag(xml, 'info') ?? xml;
  const areas = tags(info, 'area').map((a) => ({
    desc: tag(a, 'areaDesc'),
    polygons: tags(a, 'polygon').map((p) =>
      p.split(/\s+/).filter(Boolean).map((pair) => {
        const [lat, lon] = pair.split(',').map(Number);
        return { lat, lon };
      })),
  }));
  return {
    id: tag(xml, 'identifier'),
    sent: tag(xml, 'sent'),
    msgType: tag(xml, 'msgType'),
    event: tag(info, 'event'),
    headline: tag(info, 'headline'),
    description: tag(info, 'description'),
    instruction: tag(info, 'instruction'),
    severity: tag(info, 'severity'),
    urgency: tag(info, 'urgency'),
    certainty: tag(info, 'certainty'),
    onset: tag(info, 'onset') ?? tag(info, 'effective'),
    expires: tag(info, 'expires'),
    web: tag(info, 'web') ?? link,
    areas,
  };
}

// ---------- NASA FIRMS satellite fire hotspots (free MAP_KEY) ----------
const FIRMS_SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'];

export async function firms(mapKey, bbox, days = 1) {
  if (!mapKey) throw new Error('FIRMS_MAP_KEY not set — get a free key at firms.modaps.eosdis.nasa.gov/api/map_key');
  const out = [];
  for (const src of FIRMS_SOURCES) {
    const csv = await get(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${src}/${bbox.join(',')}/${days}`, { type: 'text' });
    out.push(...parseFirmsCsv(csv, src));
  }
  return out;
}

export function parseFirmsCsv(csv, source) {
  const [head, ...rows] = csv.trim().split(/\r?\n/);
  if (!head || !head.includes('latitude')) {
    if (head && /invalid|error/i.test(head)) throw new Error(`FIRMS: ${head}`);
    return [];
  }
  const cols = head.split(',');
  return rows.filter(Boolean).map((r) => {
    const v = Object.fromEntries(r.split(',').map((x, i) => [cols[i], x]));
    const t = String(v.acq_time).padStart(4, '0');
    return {
      lat: Number(v.latitude), lon: Number(v.longitude),
      time: `${v.acq_date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`,
      confidence: v.confidence, frp: Number(v.frp), daynight: v.daynight, source,
    };
  });
}

// ---------- GeoNet earthquakes ----------
export async function geonetQuakes(minMmi = 3) {
  const j = await get(`https://api.geonet.org.nz/quake?MMI=${minMmi}`, { headers: { Accept: 'application/vnd.geo+json;version=2' } });
  return j.features.map((f) => ({
    id: f.properties.publicID,
    time: f.properties.time,
    magnitude: f.properties.magnitude,
    depth: f.properties.depth,
    mmi: f.properties.mmi,
    locality: f.properties.locality,
    lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
    url: `https://www.geonet.org.nz/earthquake/${f.properties.publicID}`,
  }));
}
