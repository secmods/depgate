import { gunzipSync } from 'node:zlib';

export type EpssValue = { score: number; percentile: number };
export type EpssRow = EpssValue & { cve: string };

export type EpssFile = {
  modelVersion: string | null;
  /** ISO timestamp from the file's comment line, e.g. 2026-10-11T12:55:00Z. */
  scoreDate: string | null;
  rows: EpssRow[];
  /** Data lines that were not a CVE id with two numbers in 0–1. */
  skipped: number;
};

/** A full daily file has about 300 k rows; anything far smaller is truncated or not the feed. */
export const EPSS_MIN_ROWS = 100_000;

const CVE_ID = /^CVE-\d{4}-\d{4,}$/;

export function isCveId(id: string): boolean {
  return CVE_ID.test(id.trim().toUpperCase());
}

/** The file as served is gzip; a mirror may serve it already decompressed. */
export function decodeEpssBody(body: Buffer): string {
  const gzip = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
  return (gzip ? gunzipSync(body) : body).toString('utf8');
}

function fraction(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * `#model_version:v2025.03.14,score_date:2026-10-11T12:55:00Z`, then `cve,epss,percentile`,
 * then one row per CVE. Bad rows are counted and skipped; the guards decide whether the file is usable.
 */
export function parseEpssCsv(text: string): EpssFile {
  let modelVersion: string | null = null;
  let scoreDate: string | null = null;
  const rows: EpssRow[] = [];
  let skipped = 0;
  let columns: { cve: number; epss: number; percentile: number } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      for (const part of line.slice(1).split(',')) {
        const at = part.indexOf(':');
        if (at < 0) continue;
        const key = part.slice(0, at).trim().toLowerCase();
        const value = part.slice(at + 1).trim();
        if (key === 'model_version') modelVersion = value || null;
        if (key === 'score_date') scoreDate = value || null;
      }
      continue;
    }
    const cells = line.split(',');
    if (!columns) {
      const lower = cells.map((cell) => cell.trim().toLowerCase());
      if (lower.includes('cve') && lower.includes('epss')) {
        columns = { cve: lower.indexOf('cve'), epss: lower.indexOf('epss'), percentile: lower.indexOf('percentile') };
        continue;
      }
      // No header line: the documented column order.
      columns = { cve: 0, epss: 1, percentile: 2 };
    }
    const cve = (cells[columns.cve] ?? '').trim().toUpperCase();
    const score = fraction(cells[columns.epss]);
    const percentile = columns.percentile >= 0 ? fraction(cells[columns.percentile]) : null;
    if (!CVE_ID.test(cve) || score === null || percentile === null) {
      skipped += 1;
      continue;
    }
    rows.push({ cve, score, percentile });
  }
  return { modelVersion, scoreDate, rows, skipped };
}

/** Why the file must not replace the stored scores, or null when it may. */
export function epssFileError(file: EpssFile, storedScoreDate: string | null, minRows = EPSS_MIN_ROWS): string | null {
  if (file.rows.length < minRows) {
    return `EPSS file has ${file.rows.length} rows, fewer than ${minRows}: rejected as truncated`;
  }
  if (file.scoreDate && storedScoreDate) {
    const next = Date.parse(file.scoreDate);
    const stored = Date.parse(storedScoreDate);
    if (!Number.isNaN(next) && !Number.isNaN(stored) && next < stored) {
      return `EPSS file score_date ${file.scoreDate} is older than the stored ${storedScoreDate}: rejected`;
    }
  }
  return null;
}

/** `2026-10-11` from the file's timestamp, for reasons and the UI. */
export function scoreDay(scoreDate: string | null | undefined): string | null {
  if (!scoreDate) return null;
  const match = scoreDate.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}
