// All the numbers that decide what counts as a threat live here.
// Change thresholds to suit the property; everything else reads from this file.

export const HOME = {
  name: 'West Melton',
  lat: -43.522,
  lon: 172.368,
  timezone: 'Pacific/Auckland',
};

// Other places shown on the dashboard. Weather is fetched for each.
export const PLACES = [
  HOME,
  { name: 'Christchurch', lat: -43.532, lon: 172.637 },
  { name: 'Darfield', lat: -43.489, lon: 172.109 },
  { name: 'Rolleston', lat: -43.596, lon: 172.383 },
];

// Waimakariri River at the SH1 / Old West Coast Rd reach, north of West Melton.
export const RIVER = { name: 'Waimakariri River', lat: -43.47, lon: 172.40 };

// Search box for satellite fire hotspots (west, south, east, north).
export const FIRE_BBOX = [171.7, -43.95, 172.95, -43.15];

export const THRESHOLDS = {
  // Satellite hotspots (NASA FIRMS), km from HOME
  fireNotifyKm: 30,
  fireUrgentKm: 10,
  fireLookbackHours: 24,

  // Fire weather (Canadian FWI method, which NZ uses)
  fwiHigh: 20,           // notify from this level
  fwiExtreme: 30,
  // A "nor'west fire day": all three at once at any hour
  norwestRhMax: 30,      // % relative humidity
  norwestGustMin: 60,    // km/h
  norwestTempMin: 24,    // °C

  // Weather, over the next 48 h
  gustSevere: 90,        // km/h
  gustStrong: 70,
  rain24hHeavy: 50,      // mm
  snow24h: 2,            // cm
  frostMin: -2,          // °C, overnight
  heatMax: 32,           // °C
  thunderCape: 1000,     // J/kg, plus a thunder weather code

  // Earthquakes (GeoNet)
  quakeKm: 150,
  quakeMinMmi: 4,
  quakeLookbackHours: 6,

  // Smoke
  pm25Unhealthy: 25,     // µg/m³, hourly
};

export const FORECAST_HOURS = 48;   // how far ahead the warning rules look
export const FIRE_DAYS_AHEAD = 3;   // days of fire-weather outlook that can trigger alerts

// Local hour (0–23) the morning summary goes out.
export const DIGEST_HOUR = 6;
