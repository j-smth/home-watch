# Home Watch

A free monitor for a home in West Melton, Canterbury. Every 30 minutes it checks
official warnings, forecast weather, fire weather, satellite fire hotspots,
earthquakes, river flow and smoke. It sends new alerts to your phone and
publishes a dashboard.

**This supplements official warnings; it does not replace them.** Keep
Emergency Mobile Alerts on, follow MetService and FENZ, and call 111 if you see
fire.

## What it watches

| Threat | Source (free) | Alerts when |
|---|---|---|
| Official weather warnings | MetService CAP feed | A warning or watch polygon covers West Melton, Christchurch, Darfield or Rolleston |
| Wildfire nearby | NASA FIRMS satellite hotspots (VIIRS ×3, MODIS) | Heat source within 30 km in the last 24 h. Urgent if within 10 km, or upwind in wind over 25 km/h |
| Fire weather | Open-Meteo, Fire Weather Index computed locally | FWI 20+ in the next 3 days, or a nor'west fire day (≤30% humidity, gusts ≥60 km/h, ≥24 °C) |
| Wind | Open-Meteo | Gusts ≥70 km/h (watch) or ≥90 km/h (warning) in the next 48 h |
| Heavy rain / snow | Open-Meteo | ≥50 mm or ≥2 cm in any 24 h |
| Frost / heat / thunder | Open-Meteo | ≤−2 °C, ≥32 °C, thunder codes or high CAPE |
| Earthquakes | GeoNet | MMI 4+ within 150 km, last 6 h |
| Smoke | Open-Meteo air quality | PM2.5 ≥25 µg/m³ |
| Waimakariri River | Open-Meteo / GloFAS model | Dashboard only (model trend, not a gauge) |

Every alert comes with a short "prepare the home" checklist. A morning summary
goes out at 6 am. If a feed is down for about 6 hours you get a notice, so a
silent feed is not mistaken for "all clear". All thresholds are in
`config.mjs`.

## Set up (about 15 minutes, all free)

1. **Create a GitHub repo** and push this folder to it. Make the repo private if you
   like; Pages for private repos needs a paid plan, so public is simplest. The data
   holds no personal information, only the house's approximate coordinates (set in
   `config.mjs`, currently the village centre).
2. **Phone alerts:** install the **ntfy** app (iOS/Android). Subscribe to a long random
   topic name, for example `wm-home-7f3k9q2xv8`. Anyone who knows the name can read it.
   Subscribe both homeowners' phones.
3. **Fire hotspots:** get a free FIRMS map key at
   <https://firms.modaps.eosdis.nasa.gov/api/map_key/>.
4. **Dead-man's switch (recommended):** create a free check at
   <https://healthchecks.io> with a 30-minute period and 30-minute grace. It emails you
   if the monitor stops running.
5. In the repo, go to **Settings → Secrets and variables → Actions** and add the secrets
   `NTFY_TOPIC`, `FIRMS_MAP_KEY` and `HEALTHCHECK_URL`. Then add a variable
   `DASHBOARD_URL` with your Pages address.
6. **Settings → Pages:** deploy from branch `main`, folder `/`. The dashboard appears at `https://<your-username>.github.io/home-watch/`. It carries a `noindex` tag so search engines leave it out, but anyone with the link can open it.
7. **Actions → Home watch → Run workflow** to test. You should get the morning summary
   if it is after 6 am.

## Run locally

```sh
npm test            # unit tests (FWI reference values, geo, CAP and FIRMS parsing, rules)
npm run demo        # offline run on synthetic data with a nor'wester and a nearby hotspot
npx serve .         # then open http://localhost:3000/?demo
npm run check       # live fetch, prints alerts, sends nothing
```

## Limits to know about

- **Satellite hotspots lag.** Satellites pass a few times a day and data arrives
  about 3 hours later. A grass fire in a nor'wester can cross several kilometres in
  that time. Hotspots are confirmation, not early warning; the fire-weather outlook
  is the early warning.
- **The fire danger here is an estimate** from model weather using the same FWI
  equations FENZ's system builds on. It does not account for grass curing, which
  matters a lot on the Plains. The official rating is at checkitsalright.nz.
- **GitHub's scheduler can run late** by 5–20 minutes, and it disables schedules
  in repos with no activity for 60 days. The bot's own commits count as activity,
  and the healthchecks.io ping catches any gap.
- **The river panel is a coarse model.** Use ECan gauges for real flood decisions.
- FENZ does not publish a public incidents API, so live incidents are linked rather
  than monitored.
