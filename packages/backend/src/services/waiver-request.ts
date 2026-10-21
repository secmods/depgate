/** Returns a future Date, or null when the value is missing, unparseable, or not in the future. */
export function parseFutureExpiry(value: string | undefined, now = Date.now()): Date | null {
  if (!value?.trim()) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime()) || d.getTime() <= now) return null;
  return d;
}

/** Reason stored on the exception: the requester's justification, plus the reviewer's note when present. */
export function exceptionReason(requestReason: string, reviewNote?: string | null): string {
  const note = reviewNote?.trim();
  if (!note) return requestReason;
  return `${requestReason}\nApprover note: ${note}`;
}
