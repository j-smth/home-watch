#!/usr/bin/env node
// One monitoring pass: fetch every source, work out alerts, push the new ones,
// and write data/status.json for the dashboard.
//
//   node scripts/run.mjs              live run (pushes if NTFY_TOPIC is set)
//   node scripts/run.mjs --dry-run    live fetch, print alerts, push nothing
//   node scripts/run.mjs --fixtures test/fixtures --dry-run   offline
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { HOME, PLACES, RIVER, FIRE_BBOX, THRESHOLDS, DIGEST_HOUR } from '../config.mjs';
import * as src from '../lib/sources.mjs';
import * as rules from '../lib/rules.mjs';
import { distanceKm, bearingDeg, compass } from '../lib/geo.mjs';
import { push, heartbeat } from '../lib/notify.mjs';
import { himawari } from '../lib/himawari.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FIX = args.includes('--fixtures') ? args[args.indexOf('--fixtures') + 1] : null;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const env = process.env;

const fixture = async (name) => JSON.parse(await readFile(path.join(FIX, `${name}.json`), 'utf8'));

async function collect() {
  const jobs = {
    weather: () => FIX ? fixture('weather') : src.openMeteo(HOME, { pastDays: 92 }),
    places: () => FIX ? fixture('places') : Promise.all(PLACES.slice(1).map((p) => src.openMeteo(p))),
    air: () => FIX ? fixture('air') : src.airQuality(HOME),
    river: () => FIX ? fixture('river') : src.riverFlow(RIVER),
    metservice: () => FIX ? fixture('metservice') : src.metserviceCap(),
    firms: () => FIX ? fixture('firms') : src.firms(env.FIRMS_MAP_KEY, FIRE_BBOX, 2),
    geonet: () => FIX ? fixture('geonet') : src.geonetQuakes(3),
    himawari: () => FIX ? Promise.resolve([]) : himawari(env.PTREE_USER, env.PTREE_PASS, FIRE_BBOX),
  };
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(names.map((n) => jobs[n]()));
  const data = {}, sources = {};
  settled.forEach((r, i) => {
    const n = names[i];
    data[n] = r.status === 'fulfilled' ? r.value : null;
    sources[n] = r.status === 'fulfilled' ? { ok: true } : { ok: false, error: String(r.reason?.message ?? r.reason) };
  });
  return { data, sources };
}

async function loadState() {
  try { return JSON.parse(await readFile(path.join(DATA, 'state.json'), 'utf8')); }
  catch { return { sent: {}, failures: {}, lastDigest: null }; }
}

function digest(status) {
  const today = status.fire.find((d) => d.date === status.today);
  const days = status.daily.slice(0, 3).map((d) =>
    `${d.label}: ${Math.round(d.min)}–${Math.round(d.max)} °C, rain ${d.rain.toFixed(0)} mm, gusts ${Math.round(d.gust)} km/h ${d.gustDir}`);
  const active = status.alerts.filter((a) => a.level !== 'info');
  return {
    id: `digest-${status.today}`, kind: 'house', level: active.some((a) => a.level === 'urgent') ? 'warning' : 'info',
    title: `${HOME.name} today: ${today ? `${today.danger.toLowerCase()} fire danger, ` : ''}${active.length ? `${active.length} alert${active.length > 1 ? 's' : ''}` : 'no alerts'}`,
    body: [...days, ...active.slice(0, 3).map((a) => `⚠ ${a.title}`)].join('\n'),
    actions: [],
  };
}

async function main() {
  const now = new Date();
  const nowLocal = rules.localNow(now);
  const todayLocal = nowLocal.slice(0, 10);
  const { data, sources } = await collect();

  const w = data.weather;
  const fire = w ? rules.fireWeather(w.hourly) : [];
  const wind = w?.current ? { speed: w.current.wind_speed_10m, direction: w.current.wind_direction_10m } : null;
  const nearbyPoints = PLACES.map(({ lat, lon }) => ({ lat, lon }));

  const alerts = rules.sortAlerts([
    ...(data.metservice ? rules.capAlerts(data.metservice, nearbyPoints, now) : []),
    ...rules.hotspotAlerts([...(data.firms ?? []), ...(data.himawari ?? [])], wind, now),
    ...rules.fireWeatherAlerts(fire, todayLocal),
    ...(w ? rules.weatherAlerts(w.hourly, nowLocal) : []),
    ...(data.geonet ? rules.quakeAlerts(data.geonet, now) : []),
    ...rules.smokeAlerts(data.air, nowLocal),
  ]);

  const d = w?.daily;
  const firstFuture = d ? Math.max(0, d.time.indexOf(todayLocal)) : 0;
  const status = {
    generatedAt: now.toISOString(),
    today: todayLocal,
    home: HOME,
    current: w?.current ?? null,
    alerts,
    sources,
    daily: d ? d.time.slice(firstFuture).map((t, k) => {
      const i = firstFuture + k;
      return {
        date: t, label: new Date(t).toLocaleDateString('en-NZ', { weekday: 'short', timeZone: 'UTC' }),
        code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i],
        rain: d.precipitation_sum[i] ?? 0, snow: d.snowfall_sum[i] ?? 0, gust: d.wind_gusts_10m_max[i],
        gustDir: compass(d.wind_direction_10m_dominant[i] ?? 0), uv: d.uv_index_max[i],
      };
    }) : [],
    hourly: w ? rules.futureHours(w.hourly, nowLocal, 48) : [],
    fire: fire.filter((x) => x.date >= addDays(todayLocal, -14)),
    places: (data.places ?? []).map((p, i) => ({ name: PLACES[i + 1].name, current: p.current, today: {
      max: p.daily.temperature_2m_max[0], min: p.daily.temperature_2m_min[0], rain: p.daily.precipitation_sum[0], gust: p.daily.wind_gusts_10m_max[0] } })),
    hotspots: [...(data.firms ?? []), ...rules.confirmGeostationary(data.himawari ?? [])].map((h) => ({ ...h, km: distanceKm(HOME, h), dir: compass(bearingDeg(HOME, h)) }))
      .filter((h) => h.km <= 60).sort((a, b) => a.km - b.km).slice(0, 50),
    quakes: (data.geonet ?? []).map((q) => ({ ...q, km: distanceKm(HOME, q), dir: compass(bearingDeg(HOME, q)) }))
      .filter((q) => q.km <= THRESHOLDS.quakeKm).slice(0, 10),
    river: data.river?.daily ? { name: RIVER.name, ...data.river.daily } : null,
    air: data.air?.hourly ? rules.futureHours(data.air.hourly, nowLocal, 24) : [],
  };

  // ---- notifications ----
  const state = await loadState();
  const toSend = alerts.filter((a) => !state.sent[a.id]);
  const localHour = Number(nowLocal.slice(11, 13));
  if (localHour >= DIGEST_HOUR && state.lastDigest !== todayLocal) toSend.push(digest(status));

  for (const [name, s] of Object.entries(sources)) {
    state.failures[name] = s.ok ? 0 : (state.failures[name] ?? 0) + 1;
    if (state.failures[name] === 12) {
      toSend.push({ id: `down-${name}-${todayLocal}`, kind: 'house', level: 'watch', actions: [],
        title: `Home watch: ${name} feed down for ~6 hours`, body: `${s.error}\nAlerts from this source will be missed until it recovers.` });
    }
  }

  for (const a of toSend) {
    console.log(`[${a.level.toUpperCase()}] ${a.title}`);
    if (DRY || !env.NTFY_TOPIC) continue;
    try {
      await push(env.NTFY_TOPIC, a, { server: env.NTFY_SERVER || undefined, dashboardUrl: env.DASHBOARD_URL || undefined });
      if (a.id.startsWith('digest-')) state.lastDigest = todayLocal; else state.sent[a.id] = now.toISOString();
    } catch (e) { console.error(`push failed: ${e.message}`); }
  }
  if (!toSend.length) console.log('No new alerts.');

  // Forget alerts older than 10 days.
  for (const [id, t] of Object.entries(state.sent)) if (now - new Date(t) > 10 * 864e5) delete state.sent[id];

  for (const [n, s] of Object.entries(sources)) if (!s.ok) console.warn(`source ${n} failed: ${s.error}`);

  if (!DRY) {
    await mkdir(DATA, { recursive: true });
    await writeFile(path.join(DATA, 'status.json'), JSON.stringify(status));
    await writeFile(path.join(DATA, 'state.json'), JSON.stringify(state, null, 1));
  } else if (FIX) {
    await writeFile(path.join(FIX, '..', 'status.preview.json'), JSON.stringify(status));
  }
  await heartbeat(env.HEALTHCHECK_URL, sources.weather.ok && sources.metservice.ok);
}

function addDays(date, n) {
  const t = new Date(`${date}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

main().catch((e) => { console.error(e); heartbeat(env.HEALTHCHECK_URL, false).finally(() => process.exit(1)); });
