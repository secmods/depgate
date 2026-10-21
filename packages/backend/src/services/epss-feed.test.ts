import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeEpssBody, epssFileError, isCveId, parseEpssCsv, scoreDay } from './epss-feed.js';

const SAMPLE = [
  '#model_version:v2026.06.15,score_date:2026-10-12T12:00:26Z',
  'cve,epss,percentile',
  'CVE-1999-0001,0.03351,0.88393',
  'CVE-2024-1234,0.42100,0.97001',
  '',
].join('\n');

describe('EPSS file parsing', () => {
  it('reads the comment line, the header and every row', () => {
    const file = parseEpssCsv(SAMPLE);
    expect(file.modelVersion).toBe('v2026.06.15');
    expect(file.scoreDate).toBe('2026-10-12T12:00:26Z');
    expect(file.rows).toEqual([
      { cve: 'CVE-1999-0001', score: 0.03351, percentile: 0.88393 },
      { cve: 'CVE-2024-1234', score: 0.421, percentile: 0.97001 },
    ]);
    expect(file.skipped).toBe(0);
  });

  it('counts and skips bad rows: not a CVE, out of range, missing a column', () => {
    const file = parseEpssCsv(
      ['cve,epss,percentile', 'GHSA-xxxx,0.1,0.5', 'CVE-2024-1,0.1,0.5', 'CVE-2024-0002,1.5,0.5', 'CVE-2024-0003,0.1', 'CVE-2024-0004,0.2,0.6'].join('\n')
    );
    expect(file.rows.map((row) => row.cve)).toEqual(['CVE-2024-0004']);
    expect(file.skipped).toBe(4);
  });

  it('follows the header when columns are reordered, and the documented order without one', () => {
    expect(parseEpssCsv('percentile,cve,epss\n0.9,cve-2024-0001,0.3').rows).toEqual([{ cve: 'CVE-2024-0001', score: 0.3, percentile: 0.9 }]);
    expect(parseEpssCsv('CVE-2024-0001,0.3,0.9\r\nCVE-2024-0002,0.4,0.95\r\n').rows).toHaveLength(2);
  });

  it('decodes a gzip body and passes plain text through', () => {
    expect(decodeEpssBody(gzipSync(Buffer.from(SAMPLE)))).toBe(SAMPLE);
    expect(decodeEpssBody(Buffer.from(SAMPLE))).toBe(SAMPLE);
  });

  it('rejects a truncated file and one older than the stored data, and accepts the rest', () => {
    const file = parseEpssCsv(SAMPLE);
    expect(epssFileError(file, null, 3)).toMatch(/2 rows, fewer than 3: rejected as truncated/);
    expect(epssFileError(file, '2026-10-13T12:00:00Z', 1)).toMatch(/older than the stored/);
    expect(epssFileError(file, '2026-10-12T12:00:26Z', 1)).toBeNull();
    expect(epssFileError(file, '2026-10-11T12:00:00Z', 1)).toBeNull();
  });

  it('knows CVE ids and the score day', () => {
    expect(isCveId(' cve-2024-12345 ')).toBe(true);
    expect(isCveId('CVE-2024-123')).toBe(false);
    expect(isCveId('GHSA-abcd-efgh-ijkl')).toBe(false);
    expect(scoreDay('2026-10-12T12:00:26Z')).toBe('2026-10-12');
    expect(scoreDay(null)).toBeNull();
  });
});
