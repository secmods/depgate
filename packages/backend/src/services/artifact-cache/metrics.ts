import { Counter, Gauge, type Metric } from 'prom-client';

export type CacheResult = 'hit' | 'miss' | 'bypass';
export type EvictionReason = 'age' | 'idle' | 'size' | 'files' | 'purge';

export const artifactCacheRequestsTotal = new Counter({
  name: 'depgate_artifact_cache_requests_total',
  help: 'Artifact downloads by ecosystem and cache result (hit, miss = fetched and stored, bypass = fetched, not stored)',
  labelNames: ['ecosystem', 'result'],
  registers: [],
});

export const artifactCacheSizeBytes = new Gauge({
  name: 'depgate_artifact_cache_size_bytes',
  help: 'Bytes of package files in this pod\'s artifact cache',
  registers: [],
});

export const artifactCacheFiles = new Gauge({
  name: 'depgate_artifact_cache_files',
  help: 'Package files in this pod\'s artifact cache',
  registers: [],
});

export const artifactCacheEvictedTotal = new Counter({
  name: 'depgate_artifact_cache_evicted_total',
  help: 'Files removed from this pod\'s artifact cache, by reason',
  labelNames: ['reason'],
  registers: [],
});

export const ARTIFACT_CACHE_METRICS: Metric<string>[] = [artifactCacheRequestsTotal, artifactCacheSizeBytes, artifactCacheFiles, artifactCacheEvictedTotal];
