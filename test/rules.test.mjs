import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../lib/fwi.mjs';
import { distanceKm, bearingDeg, pointInPolygon, isUpwind } from '../lib/geo.mjs';
import { parseCap, parseFirmsCsv } from '../lib/sources.mjs';
import * as R from '../lib/rules.mjs';
import { HOME } from '../config.mjs';
import { synthWeather, CAP_XML, FIRMS_CSV } from './make-fixtures.mjs';

test('FWI matches the Van Wagner & Pickett reference day', () => {
  // T 17 °C, RH 42%, wind 25 km/h, no rain, April, northern-hemisphere tables.
  const ffmc = F.ffmcNext(85, 17, 42, 25, 0);
  const dmc = F.dmcNext(6, 17, 42, 0, 3, 'north');
  const dc = F.dcNext(15, 17, 0, 3, 'north');
  const isi = F.isi(ffmc, 25), bui = F.bui(dmc, dc);
  assert.ok(Math.abs(ffmc - 87.69) < 0.05, `ffmc ${ffmc}`);
  assert.ok(Math.abs(dmc - 8.55) < 0.05, `dmc ${dmc}`);
  assert.ok(Math.abs(dc - 19.01) < 0.05, `dc ${dc}`);
  assert.ok(Math.abs(isi - 10.85) < 0.05, `isi ${isi}`);
  assert.ok(Math.abs(bui - 8.49) < 0.05, `bui ${bui}`);
  assert.ok(Math.abs(F.fwi(isi, bui) - 10.10) < 0.05);
});

test('geo helpers', () => {
  const chch = { lat: -43.532, lon: 172.637 };
  assert.ok(Math.abs(distanceKm(HOME, chch) - 21.8) < 1);
  assert.ok(Math.abs(bearingDeg(HOME, chch) - 90) < 5);
  assert.ok(isUpwind(315, 310));       // fire NW of home in a nor'wester
  assert.ok(!isUpwind(135, 310));      // fire downwind
  const sq = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }];
  assert.ok(pointInPolygon({ lat: 0.5, lon: 0.5 }, sq));
  assert.ok(!pointInPolygon({ lat: 1.5, lon: 0.5 }, sq));
});

test('MetService CAP warning covering West Melton becomes an official alert', () => {
  const cap = parseCap(CAP_XML);
  assert.equal(cap.event, 'Strong Wind');
  assert.equal(cap.areas[0].polygons[0].length, 5);
  const [a] = R.capAlerts([cap], [HOME]);
  assert.equal(a.level, 'watch');
  assert.equal(a.official, true);
  assert.equal(R.capAlerts([cap], [{ lat: -36.85, lon: 174.76 }]).length, 0); // Auckland: not affected
});

test('hotspot near home is urgent; hotspot far away is a warning', () => {
  const hs = parseFirmsCsv(FIRMS_CSV, 'VIIRS_SNPP_NRT');
  const alerts = R.hotspotAlerts(hs, { speed: 30, direction: 315 });
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].level, 'urgent');      // ~5 km NW, upwind
  assert.match(alerts[0].title, /upwind/);
  assert.equal(alerts[1].level, 'warning');     // ~22 km SW
});

test("nor'west day two days out triggers fire and wind alerts", () => {
  const w = synthWeather();
  const now = R.localNow();
  const fire = R.fireWeather(w.hourly);
  assert.ok(fire.length > 90);
  const fa = R.fireWeatherAlerts(fire, now.slice(0, 10));
  assert.ok(fa.some((a) => /Nor'west fire day/.test(a.title)), JSON.stringify(fa.map((a) => a.title)));
  const wa = R.weatherAlerts(w.hourly, now);
  assert.ok(wa.some((a) => a.kind === 'wind' && a.level === 'warning'));
});

test('quiet weather gives no alerts', () => {
  const w = synthWeather();
  w.hourly.wind_gusts_10m = w.hourly.wind_gusts_10m.map(() => 20);
  w.hourly.temperature_2m = w.hourly.temperature_2m.map(() => 12);
  w.hourly.relative_humidity_2m = w.hourly.relative_humidity_2m.map(() => 70);
  assert.equal(R.weatherAlerts(w.hourly, R.localNow()).length, 0);
  assert.equal(R.fireWeatherAlerts(R.fireWeather(w.hourly), R.localNow().slice(0, 10)).length, 0);
});

test('MetService colour codes set the alert level', () => {
  assert.equal(R.capLevel({ headline: 'Strong Wind Warning - Orange', severity: 'Moderate' }), 'warning');
  assert.equal(R.capLevel({ headline: 'Heavy Rain Warning - Red', severity: 'Severe' }), 'urgent');
  assert.equal(R.capLevel({ headline: 'Strong Wind Watch', severity: 'Minor' }), 'info');
});

test('nearby detections of one fire make one alert', () => {
  const t = new Date(Date.now() - 3600e3).toISOString().slice(0, 19) + 'Z';
  const pts = [[-43.52, 172.505], [-43.52, 172.52], [-43.525, 172.53]].map(([lat, lon]) =>
    ({ lat, lon, time: t, confidence: 'n', frp: 5, source: 'VIIRS_NOAA21_NRT' }));
  const a = R.hotspotAlerts(pts, null);
  assert.equal(a.length, 1);
  assert.match(a[0].body, /3 detections/);
});
