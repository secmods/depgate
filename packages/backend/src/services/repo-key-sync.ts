import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { REPO_KEY_CHANNEL, applyRepoKeyMessage } from './repo-keys.js';
import { refreshRepoKeyCache } from './repository-resolve.js';

const REFRESH_MS = 5000;

type SyncLog = {
  warn: (err: unknown, msg: string) => void;
};

/**
 * rewriteUrl runs before routing and cannot await Redis. Each process keeps an
 * in-memory key set. Creates and deletes are published immediately, and a short
 * database refresh covers a missed message.
 */
export function startRepoKeyReplication(db: DataSource, redis: Redis, log: SyncLog): () => void {
  const sub = redis.duplicate();
  sub.on('error', (err) => log.warn(err, 'Repository key subscriber error'));
  sub.subscribe(REPO_KEY_CHANNEL).catch((err) => log.warn(err, 'Repository key subscribe failed'));
  sub.on('message', (channel, message) => {
    if (channel !== REPO_KEY_CHANNEL) return;
    applyRepoKeyMessage(message);
  });

  const timer = setInterval(() => {
    refreshRepoKeyCache(db).catch((err) => log.warn(err, 'Repository key refresh failed'));
  }, REFRESH_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    sub.disconnect();
  };
}
