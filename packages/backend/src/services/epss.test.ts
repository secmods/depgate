import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { downloadEpss, epssBackupUrls, isEpssStale } from './epss.js';

const FEED = 'https://epss.empiricalsecurity.com/epss_scores-current.csv.gz';
const GITHUB = 'https://raw.githubusercontent.com/empiricalsec/epss_scores/main';

const csv = (date: string) =>
  [`#model_version:v2026.06.15,score_date:${date}T12:00:26Z`, 'cve,epss,percentile', 'CVE-2024-0001,0.1,0.5', 'CVE-2024-0002,0.2,0.6'].join('\n');

function body(status: number, payload: Buffer | string) {
  const bytes = typeof payload === 'string' ? Buffer.from(payload) : payload;
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

describe('EPSS GitHub backup URLs', () => {
  it('lists today first, then earlier days, in each date’s year folder', () => {
    expect(epssBackupUrls(new Date('2026-10-13T08:00:00Z'))).toEqual([
      `${GITHUB}/2026/epss_scores-2026-10-13.csv.gz`,
      `${GITHUB}/2026/epss_scores-2026-10-12.csv.gz`,
      `${GITHUB}/2026/epss_scores-2026-10-11.csv.gz`,
    ]);
  });

  it('moves to the previous year’s folder across New Year', () => {
    expect(epssBackupUrls(new Date('2027-01-01T03:00:00Z'), undefined, 2)).toEqual([
      `${GITHUB}/2027/epss_scores-2027-01-01.csv.gz`,
      `${GITHUB}/2026/epss_scores-2026-12-31.csv.gz`,
    ]);
  });

  it('uses UTC dates, and an empty template disables the backup', () => {
    expect(epssBackupUrls(new Date('2026-10-13T23:30:00-05:00'), undefined, 1)).toEqual([`${GITHUB}/2026/epss_scores-2026-10-14.csv.gz`]);
    expect(epssBackupUrls(new Date(), '', 3)).toEqual([]);
  });
});

describe('EPSS download', () => {
  const fetchMock = vi.fn();
  const now = new Date('2026-10-13T08:00:00Z');

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('uses the feed when it answers', async () => {
    fetchMock.mockResolvedValue(body(200, gzipSync(Buffer.from(csv('2026-10-12')))));
    const out = await downloadEpss(2, now);
    expect(out.source).toBe(FEED);
    expect(out.file.rows).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to GitHub: today is not published yet, so yesterday’s file is used', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FEED) return body(503, 'unavailable');
      if (url.endsWith('2026-10-13.csv.gz')) return body(404, 'Not Found');
      return body(200, gzipSync(Buffer.from(csv('2026-10-12'))));
    });
    const out = await downloadEpss(2, now);
    expect(out.source).toBe(`${GITHUB}/2026/epss_scores-2026-10-12.csv.gz`);
    expect(out.file.scoreDate).toBe('2026-10-12T12:00:26Z');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([FEED, `${GITHUB}/2026/epss_scores-2026-10-13.csv.gz`, out.source]);
  });

  it('falls back when the feed answers 200 with something that is not the file', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === FEED ? body(200, '<html>maintenance</html>') : body(200, gzipSync(Buffer.from(csv('2026-10-13'))))
    );
    const out = await downloadEpss(2, now);
    expect(out.source).toBe(`${GITHUB}/2026/epss_scores-2026-10-13.csv.gz`);
  });

  it('falls back when the feed times out or the network fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FEED) throw new Error('The operation was aborted due to timeout');
      return body(200, gzipSync(Buffer.from(csv('2026-10-13'))));
    });
    expect((await downloadEpss(2, now)).source).toContain('epss_scores-2026-10-13');
  });

  it('names every source when none can be read', async () => {
    fetchMock.mockResolvedValue(body(404, 'Not Found'));
    await expect(downloadEpss(2, now)).rejects.toThrow(/No EPSS source could be read\..*current\.csv\.gz: HTTP 404.*2026-10-11\.csv\.gz: HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1 + config.epss.backupDays);
  });
});

describe('EPSS staleness', () => {
  it('is stale when never synced or older than EPSS_STALE_AFTER_HOURS', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(isEpssStale(null, now)).toBe(true);
    expect(isEpssStale('2026-10-12T12:00:00Z', now)).toBe(false);
    expect(isEpssStale('2026-10-01T12:00:00Z', now)).toBe(true);
  });
});
