// Builds synthetic offline fixtures shaped like the real API responses, with a
// nor'west fire day two days out and a hotspot near home. Used by the tests and
// for previewing the dashboard without network access.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseCap, parseFirmsCsv } from '../lib/sources.mjs';
import { localNow } from '../lib/rules.mjs';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

export function synthWeather(now = new Date(), pastDays = 92) {
  const today = localNow(now).slice(0, 10);
  const start = new Date(`${today}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - pastDays);
  const h = { time: [], temperature_2m: [], relative_humidity_2m: [], precipitation: [], snowfall: [],
    wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: [], weather_code: [], cape: [] };
  const hours = (pastDays + 7) * 24;
  for (let i = 0; i < hours; i++) {
    const t = new Date(start.getTime() + i * 3600e3);
    const day = Math.floor(i / 24), hr = i % 24;
    const daysFromToday = day - pastDays;
    const diurnal = Math.sin(((hr - 9) / 24) * 2 * Math.PI);
    const norwest = daysFromToday === 2 && hr >= 10 && hr <= 19;
    h.time.push(t.toISOString().slice(0, 16));
    h.temperature_2m.push(+(14 + 7 * diurnal + (norwest ? 12 : 0)).toFixed(1));
    h.relative_humidity_2m.push(Math.round(norwest ? 18 : 65 - 20 * diurnal));
    h.precipitation.push(day % 9 === 0 && hr < 6 ? 2.5 : 0);
    h.snowfall.push(0);
    h.wind_speed_10m.push(norwest ? 45 : 12 + 6 * diurnal);
    h.wind_direction_10m.push(norwest ? 315 : 60);
    h.wind_gusts_10m.push(norwest ? 95 : 25 + 10 * diurnal);
    h.weather_code.push(norwest ? 1 : 3);
    h.cape.push(0);
  }
  const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [],
    snowfall_sum: [], wind_gusts_10m_max: [], wind_direction_10m_dominant: [], uv_index_max: [] };
  for (let d = 0; d < pastDays + 7; d++) {
    const s = d * 24, e = s + 24;
    daily.time.push(h.time[s].slice(0, 10));
    daily.weather_code.push(h.weather_code[s + 12]);
    daily.temperature_2m_max.push(Math.max(...h.temperature_2m.slice(s, e)));
    daily.temperature_2m_min.push(Math.min(...h.temperature_2m.slice(s, e)));
    daily.precipitation_sum.push(h.precipitation.slice(s, e).reduce((a, b) => a + b, 0));
    daily.snowfall_sum.push(0);
    daily.wind_gusts_10m_max.push(Math.max(...h.wind_gusts_10m.slice(s, e)));
    daily.wind_direction_10m_dominant.push(h.wind_direction_10m[s + 14]);
    daily.uv_index_max.push(7);
  }
  return {
    current: { time: localNow(now), temperature_2m: 17, relative_humidity_2m: 48, wind_speed_10m: 22, wind_direction_10m: 310, wind_gusts_10m: 41, weather_code: 2, precipitation: 0 },
    hourly: h, daily,
  };
}

export const CAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>2.49.0.1.554.0.TEST.1</identifier>
  <sent>2026-10-26T09:00:00+13:00</sent>
  <msgType>Alert</msgType>
  <info>
    <event>Strong Wind</event>
    <urgency>Expected</urgency><severity>Moderate</severity><certainty>Likely</certainty>
    <onset>2026-10-28T10:00:00+13:00</onset>
    <expires>2099-10-28T22:00:00+13:00</expires>
    <headline>Strong Wind Watch for Canterbury Plains</headline>
    <description>Northwest winds may approach severe gale in exposed places.</description>
    <web>https://www.metservice.com/warnings/home</web>
    <area>
      <areaDesc>Canterbury Plains and Christchurch</areaDesc>
      <polygon>-43.2,171.9 -43.2,172.9 -43.9,172.9 -43.9,171.9 -43.2,171.9</polygon>
    </area>
  </info>
</alert>`;

const ago = (h) => new Date(Date.now() - h * 3600e3);
const firmsRow = (lat, lon, t) => `${lat},${lon},330.1,0.4,0.4,${t.toISOString().slice(0, 10)},${t.toISOString().slice(11, 16).replace(':', '')},N,VIIRS,n,2.0NRT,290.1,8.4,D`;
export const FIRMS_CSV = [
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
  firmsRow(-43.49, 172.31, ago(3)),
  firmsRow(-43.65, 172.15, ago(5)),
].join('\n');

if (import.meta.url === `file://${process.argv[1]}`) {
  await mkdir(DIR, { recursive: true });
  const w = synthWeather();
  const write = (n, v) => writeFile(path.join(DIR, `${n}.json`), JSON.stringify(v));
  await write('weather', w);
  const short = synthWeather(new Date(), 0);
  await write('places', [short, short, short]);
  await write('air', { hourly: { time: w.hourly.time, pm2_5: w.hourly.time.map(() => 6), pm10: w.hourly.time.map(() => 11) } });
  const days = [...Array(21)].map((_, i) => w.daily.time[w.daily.time.length - 21 + i] ?? w.daily.time.at(-1));
  await write('river', { daily: { time: days, river_discharge: days.map((_, i) => 120 + 60 * Math.sin(i / 3)), river_discharge_max: days.map((_, i) => 180 + 60 * Math.sin(i / 3)) } });
  await write('metservice', [parseCap(CAP_XML)]);
  await write('firms', parseFirmsCsv(FIRMS_CSV, 'VIIRS_SNPP_NRT'));
  await write('geonet', [{ id: '2026p000001', time: ago(2).toISOString(), magnitude: 4.3, depth: 9, mmi: 4,
    locality: '10 km south-west of Darfield', lat: -43.55, lon: 172.05, url: 'https://www.geonet.org.nz/earthquake/2026p000001' }]);
  console.log(`fixtures written to ${DIR}`);
}
