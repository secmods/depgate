import { Observable, firstValueFrom } from 'rxjs';

type Cell = string | number | boolean | null | undefined;

function escape(cell: Cell): string {
  if (cell == null) return '';
  const text = String(cell);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = typeof cell === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, header: string[], rows: Cell[][]): void {
  const blob = new Blob(['﻿' + toCsv(header, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Reads every page of a list endpoint, up to `max` rows.
 * `fetch(limit, offset)` must return `{ items, total }`.
 */
export async function fetchAllPages<T>(
  fetch: (limit: number, offset: number) => Observable<{ items: T[]; total: number }>,
  pageSize = 200,
  max = 10000,
): Promise<{ items: T[]; total: number; truncated: boolean }> {
  const items: T[] = [];
  let total = 0;
  for (let offset = 0; offset < max; offset += pageSize) {
    const page = await firstValueFrom(fetch(pageSize, offset));
    total = page.total;
    items.push(...page.items);
    if (page.items.length < pageSize || items.length >= total) break;
  }
  return { items: items.slice(0, max), total, truncated: total > max };
}

export function timestampedName(prefix: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
}
