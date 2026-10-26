// Turns fetched data into alerts. Pure functions: no network, easy to test.
import { THRESHOLDS as T, FORECAST_HOURS, FIRE_DAYS_AHEAD, HOME } from '../config.mjs';
import { distanceKm, bearingDeg, compass, pointInPolygon, isUpwind } from './geo.mjs';
import { runSeries, dangerClass } from './fwi.mjs';

export const LEVELS = ['info', 'watch', 'warning', 'urgent'];

export const PREP = {
  wind: [
    'Tie down or bring in trampolines, outdoor furniture and bins',
    'Check shelter-belt trees near the house and lines',
    'Charge phones and power banks; find torches (nor\'westers often cut power)',
    'Close and latch garage and shed doors',
  ],
  fire: [
    'No mowing, welding, grinding or burning, especially in the afternoon',
    'Clear gutters and move firewood, hay and fuel 10 m+ from the house',
    'Connect hoses at each corner and fill buckets; know where the pump is',
    'Pack a go-bag and plan two ways out of the property',
    'Check the fire season and any bans at checkitsalright.nz',
  ],
  rain: [
    'Clear gutters, downpipes and drains',
    'Move vehicles and valuables off low ground',
    'Watch Environment Canterbury river updates for the Waimakariri',
  ],
  snow: ['Shelter stock, lag exposed pipes, and fuel up the car', 'Expect road closures on SH73 and the Old West Coast Rd'],
  frost: ['Cover tender plants and lag outdoor pipes and taps'],
  heat: ['Water garden early, keep pets and stock shaded, check on vulnerable neighbours'],
  thunder: ['Get cars under cover (hail)', 'Unplug sensitive electronics'],
  quake: ['Check for gas smells, water leaks and chimney or roof damage', 'Expect aftershocks: drop, cover, hold'],
  smoke: ['Close windows and switch off ventilation systems that pull in outside air', 'Find the source: check FENZ and the hotspot map'],
};

const alert = (o) => ({ actions: PREP[o.kind] ?? [], ...o });

// ---- time helpers (Open-Meteo gives local times without an offset) ----
export function localNow(date = new Date(), tz = HOME.timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

export function futureHours(hourly, nowLocal, hours) {
  const start = hourly.time.findIndex((t) => t >= nowLocal);
  const idx = start < 0 ? [] : hourly.time.slice(start, start + hours).map((_, i) => start + i);
  return idx.map((i) => Object.fromEntries(Object.keys(hourly).map((k) => [k, hourly[k][i]])));
}

const dayOf = (t) => t.slice(0, 10);
const fmt = (t) => new Date(`${t}:00`).toLocaleString('en-NZ', { weekday: 'short', hour: 'numeric', hour12: true });

// ---- fire weather series from hourly data ----
export function fireWeather(hourly) {
  const byDay = new Map();
  hourly.time.forEach((t, i) => {
    const d = dayOf(t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(i);
  });
  const days = [];
  for (const [date, idx] of byDay) {
    const noon = idx.find((i) => hourly.time[i].endsWith('T12:00'));
    if (noon == null || hourly.temperature_2m[noon] == null) continue;
    // Rain in the 24 h ending at noon.
    let rain = 0;
    for (let k = Math.max(0, noon - 23); k <= noon; k++) rain += hourly.precipitation[k] ?? 0;
    // Afternoon peak conditions, which drive real fire behaviour on the Plains.
    const afternoon = idx.filter((i) => { const h = Number(hourly.time[i].slice(11, 13)); return h >= 12 && h <= 18; });
    days.push({
      date,
      temp: hourly.temperature_2m[noon],
      rh: hourly.relative_humidity_2m[noon],
      wind: hourly.wind_speed_10m[noon],
      rain,
      peakGust: Math.max(...afternoon.map((i) => hourly.wind_gusts_10m[i] ?? 0)),
      minRh: Math.min(...afternoon.map((i) => hourly.relative_humidity_2m[i] ?? 100)),
      maxTemp: Math.max(...afternoon.map((i) => hourly.temperature_2m[i] ?? -99)),
    });
  }
  return runSeries(days).map((d) => ({ ...d, danger: dangerClass(d.fwi) }));
}

// ---- individual rule sets ----
export function weatherAlerts(hourly, nowLocal) {
  const hrs = futureHours(hourly, nowLocal, FORECAST_HOURS);
  if (!hrs.length) return [];
  const out = [];

  const peak = hrs.reduce((a, b) => ((b.wind_gusts_10m ?? 0) > (a.wind_gusts_10m ?? 0) ? b : a));
  if (peak.wind_gusts_10m >= T.gustStrong) {
    const severe = peak.wind_gusts_10m >= T.gustSevere;
    out.push(alert({
      id: `wind-${severe ? 'severe' : 'strong'}-${dayOf(peak.time)}`, kind: 'wind', level: severe ? 'warning' : 'watch',
      title: `${severe ? 'Damaging' : 'Strong'} ${compass(peak.wind_direction_10m)} gusts to ${Math.round(peak.wind_gusts_10m)} km/h`,
      body: `Peak around ${fmt(peak.time)} at ${HOME.name}.`, at: peak.time,
    }));
  }

  // Rolling 24 h rain and snow.
  for (const [key, field, limit, kind, unit] of [['rain', 'precipitation', T.rain24hHeavy, 'rain', 'mm'], ['snow', 'snowfall', T.snow24h, 'snow', 'cm']]) {
    let best = 0, at = null;
    for (let i = 0; i < hrs.length; i++) {
      const sum = hrs.slice(i, i + 24).reduce((s, h) => s + (h[field] ?? 0), 0);
      if (sum > best) { best = sum; at = hrs[i].time; }
    }
    if (best >= limit) {
      out.push(alert({
        id: `${key}-${dayOf(at)}`, kind, level: 'warning',
        title: key === 'rain' ? `Heavy rain: ${Math.round(best)} mm in 24 h` : `Snow: ${best.toFixed(1)} cm in 24 h`,
        body: `From about ${fmt(at)}.`, at, unit,
      }));
    }
  }

  const coldest = hrs.reduce((a, b) => (b.temperature_2m < a.temperature_2m ? b : a));
  if (coldest.temperature_2m <= T.frostMin) {
    out.push(alert({ id: `frost-${dayOf(coldest.time)}`, kind: 'frost', level: 'watch',
      title: `Hard frost: ${coldest.temperature_2m.toFixed(1)} °C`, body: `Coldest around ${fmt(coldest.time)}.`, at: coldest.time }));
  }

  const hottest = hrs.reduce((a, b) => (b.temperature_2m > a.temperature_2m ? b : a));
  if (hottest.temperature_2m >= T.heatMax) {
    out.push(alert({ id: `heat-${dayOf(hottest.time)}`, kind: 'heat', level: 'watch',
      title: `Heat: ${Math.round(hottest.temperature_2m)} °C`, body: `Hottest around ${fmt(hottest.time)}.`, at: hottest.time }));
  }

  const storm = hrs.find((h) => h.weather_code >= 95 || (h.cape >= T.thunderCape && h.precipitation > 0.5));
  if (storm) {
    out.push(alert({ id: `thunder-${dayOf(storm.time)}`, kind: 'thunder', level: 'watch',
      title: 'Thunderstorms possible', body: `From about ${fmt(storm.time)}. Hail and lightning-start fires are a risk.`, at: storm.time }));
  }
  return out;
}

export function fireWeatherAlerts(series, todayLocal) {
  const ahead = series.filter((d) => d.date >= todayLocal).slice(0, FIRE_DAYS_AHEAD);
  const out = [];
  for (const d of ahead) {
    const norwest = d.minRh <= T.norwestRhMax && d.peakGust >= T.norwestGustMin && d.maxTemp >= T.norwestTempMin;
    if (d.fwi >= T.fwiHigh || norwest) {
      const extreme = d.fwi >= T.fwiExtreme || (norwest && d.fwi >= T.fwiHigh);
      out.push(alert({
        id: `fireweather-${extreme ? 'extreme' : 'high'}-${d.date}`, kind: 'fire', level: extreme ? 'urgent' : 'warning',
        title: norwest
          ? `Nor'west fire day ${new Date(d.date).toLocaleDateString('en-NZ', { weekday: 'long', timeZone: 'UTC' })}: ${Math.round(d.maxTemp)} °C, ${Math.round(d.minRh)}% humidity, gusts ${Math.round(d.peakGust)} km/h`
          : `${d.danger} fire danger ${new Date(d.date).toLocaleDateString('en-NZ', { weekday: 'long', timeZone: 'UTC' })} (FWI ${Math.round(d.fwi)})`,
        body: 'A fire that starts in these conditions spreads faster than crews can reach it. Estimated from forecast weather, not the official FENZ rating.',
        at: `${d.date}T12:00`,
      }));
    }
  }
  return out;
}

// Geostationary fire pixels are noisier (hot bare paddocks, cloud edges), so a
// Himawari detection only counts once a later or earlier scan sees heat within 3 km.
export function confirmGeostationary(hotspots) {
  return hotspots.filter((h) => h.source !== 'HIMAWARI_9' || hotspots.some((o) =>
    o !== h && o.source === 'HIMAWARI_9' && o.time !== h.time && distanceKm(o, h) <= 3));
}

export function hotspotAlerts(hotspots, wind, now = new Date()) {
  const cutoff = now.getTime() - T.fireLookbackHours * 3600e3;
  const near = confirmGeostationary(hotspots)
    .filter((h) => new Date(h.time).getTime() >= cutoff && h.confidence !== 'l' && h.confidence !== 'low')
    .map((h) => ({ ...h, km: distanceKm(HOME, h), bearing: bearingDeg(HOME, h) }))
    .filter((h) => h.km <= T.fireNotifyKm)
    .sort((a, b) => a.km - b.km);
  // One alert per fire: detections within 3 km of each other on the same day merge.
  const clusters = new Map();
  for (const h of near) {
    const day = h.time.slice(0, 10);
    const hit = [...clusters.values()].find((c) => c.time.slice(0, 10) === day && distanceKm(c, h) <= 3);
    if (hit) { hit.count += 1; continue; }
    clusters.set(`${(h.lat / 0.05).toFixed(0)}_${(h.lon / 0.05).toFixed(0)}_${day}`, { ...h, count: 1 });
  }
  return [...clusters.entries()].map(([key, h]) => {
    const upwind = wind && isUpwind(h.bearing, wind.direction);
    const urgent = h.km <= T.fireUrgentKm || (upwind && wind.speed >= 25);
    return alert({
      id: `hotspot-${key}-${urgent ? 'u' : 'w'}`, kind: 'fire', level: urgent ? 'urgent' : 'warning',
      title: `Satellite heat source ${h.km.toFixed(1)} km ${compass(h.bearing)} of home${upwind ? ' (upwind)' : ''}`,
      body: `Detected ${new Date(h.time).toLocaleString('en-NZ', { timeZone: HOME.timezone })} by ${h.source.replace(/_/g, ' ')}. `
        + (h.count > 1 ? `${h.count} detections in this area. ` : '')
        + 'Could be a controlled burn or industry. If you can see or smell smoke and are unsure, call 111.',
      at: h.time, lat: h.lat, lon: h.lon,
    });
  });
}

const CAP_LEVEL = { Extreme: 'urgent', Severe: 'warning', Moderate: 'watch', Minor: 'info', Unknown: 'info' };

// MetService colour codes outrank the CAP severity field: Red = act now,
// Orange = warning, Yellow = be ready. Plain "Watch" products stay as info.
export function capLevel(c) {
  const text = `${c.headline ?? ''} ${c.event ?? ''}`;
  if (/\bred\b/i.test(text)) return 'urgent';
  if (/\borange\b/i.test(text)) return 'warning';
  if (/\byellow\b/i.test(text)) return 'watch';
  return CAP_LEVEL[c.severity] ?? 'watch';
}

export function capAffects(cap, points) {
  return cap.areas?.some((a) =>
    a.polygons.some((poly) => points.some((p) => pointInPolygon(p, poly)))
    || (!a.polygons.length && /canterbury plains|christchurch|selwyn/i.test(a.desc ?? '')));
}

export function capAlerts(caps, places, now = new Date()) {
  return caps
    .filter((c) => !c.error && c.msgType !== 'Cancel' && (!c.expires || new Date(c.expires) > now))
    .filter((c) => capAffects(c, places))
    .map((c) => {
      const kind = /wind/i.test(c.event) ? 'wind' : /rain/i.test(c.event) ? 'rain' : /snow/i.test(c.event) ? 'snow' : /thunder/i.test(c.event) ? 'thunder' : 'wind';
      return alert({
        id: `cap-${c.id}`, kind, level: capLevel(c), official: true,
        title: `MetService: ${c.headline ?? c.event}`,
        body: [c.description, c.instruction].filter(Boolean).join(' ').slice(0, 600),
        at: c.onset, until: c.expires, url: c.web,
      });
    });
}

export function quakeAlerts(quakes, now = new Date()) {
  const cutoff = now.getTime() - T.quakeLookbackHours * 3600e3;
  return quakes
    .filter((q) => new Date(q.time).getTime() >= cutoff && q.mmi >= T.quakeMinMmi && distanceKm(HOME, q) <= T.quakeKm)
    .map((q) => alert({
      id: `quake-${q.id}`, kind: 'quake', level: q.mmi >= 6 ? 'urgent' : q.mmi >= 5 ? 'warning' : 'info',
      title: `M${q.magnitude.toFixed(1)} earthquake ${Math.round(distanceKm(HOME, q))} km ${compass(bearingDeg(HOME, q))}, ${q.locality}`,
      body: `Felt intensity MMI ${q.mmi}, depth ${Math.round(q.depth)} km.`, at: q.time, url: q.url,
    }));
}

export function smokeAlerts(aq, nowLocal) {
  if (!aq?.hourly) return [];
  const hrs = futureHours(aq.hourly, nowLocal, 24);
  const worst = hrs.reduce((a, b) => ((b.pm2_5 ?? 0) > (a?.pm2_5 ?? 0) ? b : a), null);
  if (!worst || worst.pm2_5 < T.pm25Unhealthy) return [];
  return [alert({ id: `smoke-${dayOf(worst.time)}`, kind: 'smoke', level: 'watch',
    title: `Poor air: PM2.5 ${Math.round(worst.pm2_5)} µg/m³`, body: `Worst around ${fmt(worst.time)}. Often winter woodsmoke; in summer, check for fire.`, at: worst.time })];
}

export const rank = (a) => LEVELS.indexOf(a.level);
export const sortAlerts = (list) => [...list].sort((a, b) => rank(b) - rank(a) || String(a.at).localeCompare(String(b.at)));
