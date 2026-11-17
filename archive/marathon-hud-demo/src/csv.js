import fs from 'node:fs';

// Expected columns: time_ms,distance_km,pace_sec_km,heart_rate,cadence,elevation_m,lat,lon
export function readActivityCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('运动数据 CSV 至少需要一行表头和一行数据');
  const headers = lines[0].split(',').map(x => x.trim());
  const required = ['time_ms', 'distance_km', 'pace_sec_km', 'heart_rate'];
  for (const name of required) if (!headers.includes(name)) throw new Error(`CSV 缺少必要列: ${name}`);
  const rows = lines.slice(1).map((line, index) => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => row[h] = values[i] === undefined || values[i] === '' ? NaN : Number(values[i]));
    if (!Number.isFinite(row.time_ms)) throw new Error(`CSV 第 ${index + 2} 行 time_ms 无效`);
    return row;
  }).sort((a, b) => a.time_ms - b.time_ms);
  if (rows.length < 2) throw new Error('有效运动数据不足');
  return rows;
}

export function sampleAt(rows, timeMs) {
  if (timeMs <= rows[0].time_ms) return rows[0];
  if (timeMs >= rows[rows.length - 1].time_ms) return rows[rows.length - 1];
  let lo = 0, hi = rows.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].time_ms <= timeMs) lo = mid; else hi = mid;
  }
  const a = rows[lo], b = rows[hi];
  const ratio = (timeMs - a.time_ms) / Math.max(1, b.time_ms - a.time_ms);
  const out = { time_ms: timeMs };
  for (const key of ['distance_km', 'pace_sec_km', 'heart_rate', 'cadence', 'elevation_m', 'lat', 'lon']) {
    const av = a[key], bv = b[key];
    out[key] = Number.isFinite(av) && Number.isFinite(bv) ? av + (bv - av) * ratio : (Number.isFinite(av) ? av : bv);
  }
  return out;
}
