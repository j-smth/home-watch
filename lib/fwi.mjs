// Canadian Forest Fire Weather Index system (Van Wagner 1987), which NZ's
// fire danger system is built on. Inputs are noon readings: temp °C, RH %,
// wind km/h, rain mm in the 24 h to noon.
//
// This is an estimate from model weather, not the official FENZ rating.

// Effective day length (DMC) and day-length factor (DC) by month.
const LE = {
  north: [6.5, 7.5, 9, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8, 7, 6],
  south: [11.5, 10.5, 9.2, 7.9, 6.8, 6.2, 6.5, 7.4, 8.7, 10, 11.2, 11.8],
};
const LF = {
  north: [-1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5, 2.4, 0.4, -1.6, -1.6],
  south: [6.4, 5, 2.4, 0.4, -1.6, -1.6, -1.6, -1.6, -1.6, 0.9, 3.8, 5.8],
};

export const STARTUP = { ffmc: 85, dmc: 6, dc: 15 };

export function ffmcNext(ffmc0, T, H, W, rain) {
  let mo = (147.2 * (101 - ffmc0)) / (59.5 + ffmc0);
  if (rain > 0.5) {
    const rf = rain - 0.5;
    let add = 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf));
    if (mo > 150) add += 0.0015 * (mo - 150) ** 2 * Math.sqrt(rf);
    mo = Math.min(mo + add, 250);
  }
  const ed = 0.942 * H ** 0.679 + 11 * Math.exp((H - 100) / 10) + 0.18 * (21.1 - T) * (1 - Math.exp(-0.115 * H));
  let m;
  if (mo > ed) {
    const ko = 0.424 * (1 - (H / 100) ** 1.7) + 0.0694 * Math.sqrt(W) * (1 - (H / 100) ** 8);
    const kd = ko * 0.581 * Math.exp(0.0365 * T);
    m = ed + (mo - ed) * 10 ** -kd;
  } else {
    const ew = 0.618 * H ** 0.753 + 10 * Math.exp((H - 100) / 10) + 0.18 * (21.1 - T) * (1 - Math.exp(-0.115 * H));
    if (mo < ew) {
      const k1 = 0.424 * (1 - ((100 - H) / 100) ** 1.7) + 0.0694 * Math.sqrt(W) * (1 - ((100 - H) / 100) ** 8);
      const kw = k1 * 0.581 * Math.exp(0.0365 * T);
      m = ew - (ew - mo) * 10 ** -kw;
    } else {
      m = mo;
    }
  }
  return Math.max(0, Math.min(101, (59.5 * (250 - m)) / (147.2 + m)));
}

export function dmcNext(dmc0, T, H, rain, month, hemi = 'south') {
  let pr = dmc0;
  if (rain > 1.5) {
    const rw = 0.92 * rain - 1.27;
    const wmi = 20 + 280 / Math.exp(0.023 * dmc0);
    const b = dmc0 <= 33 ? 100 / (0.5 + 0.3 * dmc0)
      : dmc0 <= 65 ? 14 - 1.3 * Math.log(dmc0)
      : 6.2 * Math.log(dmc0) - 17.2;
    const wmr = wmi + (1000 * rw) / (48.77 + b * rw);
    pr = Math.max(0, 43.43 * (5.6348 - Math.log(wmr - 20)));
  }
  const t = Math.max(T, -1.1);
  const rk = 1.894 * (t + 1.1) * (100 - H) * LE[hemi][month] * 1e-4;
  return Math.max(0, pr + rk);
}

export function dcNext(dc0, T, rain, month, hemi = 'south') {
  let dr = dc0;
  if (rain > 2.8) {
    const rd = 0.83 * rain - 1.27;
    const qr = 800 * Math.exp(-dc0 / 400) + 3.937 * rd;
    dr = Math.max(0, 400 * Math.log(800 / qr));
  }
  const t = Math.max(T, -2.8);
  const pe = Math.max(0, (0.36 * (t + 2.8) + LF[hemi][month]) / 2);
  return dr + pe;
}

export function isi(ffmc, W) {
  const m = (147.2 * (101 - ffmc)) / (59.5 + ffmc);
  const fF = 91.9 * Math.exp(-0.1386 * m) * (1 + m ** 5.31 / 4.93e7);
  return 0.208 * Math.exp(0.05039 * W) * fF;
}

export function bui(dmc, dc) {
  if (dmc === 0 && dc === 0) return 0;
  const v = dmc <= 0.4 * dc
    ? (0.8 * dmc * dc) / (dmc + 0.4 * dc)
    : dmc - (1 - (0.8 * dc) / (dmc + 0.4 * dc)) * (0.92 + (0.0114 * dmc) ** 1.7);
  return Math.max(0, v);
}

export function fwi(isiV, buiV) {
  const fD = buiV <= 80 ? 0.626 * buiV ** 0.809 + 2 : 1000 / (25 + 108.64 * Math.exp(-0.023 * buiV));
  const b = 0.1 * isiV * fD;
  return b > 1 ? Math.exp(2.72 * (0.434 * Math.log(b)) ** 0.647) : b;
}

// days: [{date:'YYYY-MM-DD', temp, rh, wind, rain}] oldest first.
export function runSeries(days, hemi = 'south', start = STARTUP) {
  let { ffmc, dmc, dc } = start;
  return days.map((d) => {
    const month = Number(d.date.slice(5, 7)) - 1;
    ffmc = ffmcNext(ffmc, d.temp, d.rh, d.wind, d.rain);
    dmc = dmcNext(dmc, d.temp, d.rh, d.rain, month, hemi);
    dc = dcNext(dc, d.temp, d.rain, month, hemi);
    const i = isi(ffmc, d.wind);
    const u = bui(dmc, dc);
    return { ...d, ffmc, dmc, dc, isi: i, bui: u, fwi: fwi(i, u) };
  });
}

export function dangerClass(fwiV) {
  if (fwiV >= 30) return 'Extreme';
  if (fwiV >= 20) return 'Very high';
  if (fwiV >= 12) return 'High';
  if (fwiV >= 5) return 'Moderate';
  return 'Low';
}
