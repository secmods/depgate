type Cell = string | number | boolean | null | undefined;

/** The same escaping as the UI's shared/csv.ts: neutralise spreadsheet formulas, then quote. */
export function csvCell(cell: Cell): string {
  if (cell == null) return '';
  const text = String(cell);
  const safe = typeof cell === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvLine(cells: Cell[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}
