import fs from 'node:fs';
import { config } from '../config.js';

/** Encrypt when DB_SSL is on. With DB_SSL_CA_FILE the server certificate is also verified against that CA. */
export function dbSslOptions(): false | { rejectUnauthorized: boolean; ca?: string } {
  if (!config.db.ssl) return false;
  if (!config.db.sslCaFile) return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ca: fs.readFileSync(config.db.sslCaFile, 'utf8') };
}
