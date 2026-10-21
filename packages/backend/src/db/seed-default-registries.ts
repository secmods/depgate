import { DataSource } from 'typeorm';
import { UpstreamRegistry } from './entities/UpstreamRegistry.js';

const DEFAULTS = [
  { ecosystem: 'npm', url: 'https://registry.npmjs.org', priority: 0 },
  { ecosystem: 'pypi', url: 'https://pypi.org', priority: 0 },
  { ecosystem: 'go', url: 'https://proxy.golang.org', priority: 0 },
  { ecosystem: 'maven', url: 'https://repo1.maven.org/maven2', priority: 0 },
  { ecosystem: 'nuget', url: 'https://api.nuget.org', priority: 0 },
  { ecosystem: 'cargo', url: 'https://crates.io', priority: 0 },
  { ecosystem: 'composer', url: 'https://repo.packagist.org', priority: 0 },
  { ecosystem: 'rubygems', url: 'https://rubygems.org', priority: 0 },
];

export async function seedDefaultRegistries(db: DataSource): Promise<void> {
  const repo = db.getRepository(UpstreamRegistry);
  for (const d of DEFAULTS) {
    const existing = await repo.findOne({
      where: { ecosystem: d.ecosystem, url: d.url },
    });
    if (!existing) {
      await repo.save(repo.create({ ...d, isEnabled: true, timeoutMs: 30000, retryCount: 3 }));
    }
  }
}
