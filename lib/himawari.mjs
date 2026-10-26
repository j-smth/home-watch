// Himawari-9 wildfire product from JAXA P-Tree (free registration:
// https://www.eorc.jaxa.jp/ptree/registration_top.html). Full-disk scans every
// 10 minutes, ~2 km pixels. Served over FTP, which Node can't speak natively,
// so we use curl (installed on GitHub's runners).
//
// The CSV layout isn't formally documented, so the parser finds columns by
// name and fails loudly (with the header it saw) if it can't.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HOST = 'ftp://ftp.ptree.jaxa.jp';
const ROOT = '/pub/himawari/L2/WLF';

async function curl(path, user, pass) {
  const { stdout } = await run('curl', ['-sS', '--fail', '--max-time', '40', '--user', `${user}:${pass}`, `${HOST}${path}`],
    { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

const list = async (path, user, pass) =>
  (await curl(`${path}/`, user, pass)).split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);

// Newest product version directory: prefer a numbered release over 'bet' (beta).
export function pickVersion(dirs) {
  const numbered = dirs.filter((d) => /^\d+$/.test(d)).sort();
  return numbered.at(-1) ?? (dirs.includes('bet') ? 'bet' : dirs.sort().at(-1));
}

const pad = (n) => String(n).padStart(2, '0');

export async function himawari(user, pass, bbox, { hours = 2, now = new Date() } = {}) {
  if (!user || !pass) throw new Error('PTREE_USER / PTREE_PASS not set — register free at eorc.jaxa.jp/ptree');
  const version = pickVersion(await list(ROOT, user, pass));
  const out = [];
  for (let h = hours - 1; h >= 0; h--) {
    const t = new Date(now.getTime() - h * 3600e3);
    const dir = `${ROOT}/${version}/${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}/${pad(t.getUTCHours())}`;
    let files;
    try { files = (await list(dir, user, pass)).filter((f) => /\.csv$/i.test(f)); }
    catch { continue; } // hour not published yet
    for (const f of files) out.push(...parseWlfCsv(await curl(`${dir}/${f}`, user, pass), f, bbox));
  }
  return out;
}

// Scan time from names like H09_20261026_0130_L2WLF010_FLDK.06001_06001.csv
export function scanTime(filename) {
  const m = filename.match(/_(\d{8})_(\d{4})_/);
  if (!m) return null;
  const [d, t] = [m[1], m[2]];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2)}:00Z`;
}

export function parseWlfCsv(csv, filename, bbox) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return [];
  const head = lines[0].split(',').map((c) => c.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  const iLat = col('lat'), iLon = col('lon', 'long');
  if (iLat < 0 || iLon < 0) throw new Error(`Himawari CSV layout not recognised. Header: ${lines[0].slice(0, 200)}`);
  const iFrp = col('frp', 'fire radiative power');
  const iConf = col('confidence', 'conf', 'reliability');
  const time = scanTime(filename);
  const [w, s, e, n] = bbox;
  return lines.slice(1).map((l) => l.split(',')).map((v) => ({
    lat: Number(v[iLat]), lon: Number(v[iLon]),
    time, frp: iFrp >= 0 ? Number(v[iFrp]) : null,
    confidence: iConf >= 0 ? String(v[iConf]).trim() : 'n',
    source: 'HIMAWARI_9',
  })).filter((p) => p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e);
}
