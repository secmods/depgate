/**
 * Bearer token, the password from Basic auth (`username:password`), or a bare token:
 * Cargo sends `registries.<name>.token` as the whole header value.
 */
export function tokenFromAuthorization(header: string | string[] | undefined): string | null {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!value) return null;

  const bearer = /^Bearer\s+(\S+)$/i.exec(value);
  if (bearer) return bearer[1];

  const basic = /^Basic\s+(\S+)$/i.exec(value);
  if (!basic) return /^\S+$/.test(value) ? value : null;
  const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  if (!decoded) return null;
  const colon = decoded.indexOf(':');
  if (colon === -1) return decoded;
  const password = decoded.slice(colon + 1);
  return password || decoded.slice(0, colon) || null;
}
