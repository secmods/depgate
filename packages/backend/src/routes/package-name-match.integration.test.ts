/**
 * Malicious packages entries match the name as each client spells it. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  backfillMaliciousLookupNames,
  createPackageStore,
  findMaliciousEntry,
} from '../services/malicious-sync.js';
import { canonicalPackageName } from '../services/package-name.js';
import { User } from '../db/entities/User.js';
import { hashPassword } from '../services/auth.js';
import { ensurePackageNames } from '../services/package-name-schema.js';
import { findActiveException } from '../services/exception-service.js';
import { evaluatePackageVersions } from '../services/policy-engine.js';
import { loadApprovals } from '../services/monitor-service.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('package name matching', () => {
  let app: FastifyInstance;
  let token: string;
  const tag = randomUUID().slice(0, 8);
  const names = {
    nuget: `DepGate.Test${tag}.Evil`,
    go: `github.com/DepGateTest${tag}/evil`,
    pypi: `DepGate_Test${tag}.Evil`,
    cratesIo: `depgate_test${tag}`,
    rubygems: `depgateTest${tag}`,
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    for (const creds of [
      { email: 'admin@depgate.local', password: 'admin' },
      { email: 'testadmin@depgate.local', password: 'testpass123' },
    ]) {
      const res = await supertest(app.server).post('/api/auth/login').send(creds);
      if (res.status === 200) {
        token = res.body.token;
        break;
      }
    }
    if (!token) throw new Error('Could not obtain auth token');

    // The feed's own spellings, written the way a sync writes them.
    await createPackageStore(app.db).insertDefault([
      { name: names.nuget, ecosystem: 'nuget', reason: 'MAL-2026-1' },
      { name: names.go, ecosystem: 'go', reason: 'MAL-2026-2' },
      { name: names.pypi, ecosystem: 'pypi', reason: 'MAL-2026-3' },
      { name: names.cratesIo, ecosystem: 'crates.io', reason: 'MAL-2026-4' },
      { name: names.rubygems, ecosystem: 'rubygems', reason: 'MAL-2026-5' },
    ]);
  });

  afterAll(async () => {
    if (!app) return;
    await app.db.query(`DELETE FROM malicious_packages WHERE name LIKE $1 OR name LIKE $2`, [
      `%${tag}%`,
      `%${tag.toLowerCase()}%`,
    ]);
    await app.close();
  });

  it('every row has a lookup name after startup', async () => {
    const [{ missing }] = await app.db.query(
      `SELECT count(*)::int AS missing FROM malicious_packages WHERE lookup_name IS NULL`
    );
    expect(missing).toBe(0);
  });

  it.each([
    ['nuget', () => names.nuget.toLowerCase()],
    ['go', () => `github.com/!dep!gate!test${tag.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)}/evil`],
    ['pypi', () => `depgate-test${tag}-evil`.toLowerCase()],
    ['cargo', () => `depgate-test${tag}`],
    ['rubygems', () => names.rubygems.toLowerCase()],
  ])('finds the %s entry under the name the client sends', async (ecosystem, clientName) => {
    const entry = await findMaliciousEntry(app.db, ecosystem, clientName());
    expect(entry?.reason).toMatch(/^MAL-2026-/);
  });

  it('blocks the Go download whose module path uses the !x case encoding', async () => {
    const escaped = `github.com/!dep!gate!test${tag.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)}/evil`;
    const res = await supertest(app.server)
      .get(`/go/${escaped}/@v/v1.0.0.zip`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('MAL-2026-2');
  });

  it('blocks the NuGet download whose ID the route lowercased', async () => {
    const id = names.nuget.toLowerCase();
    const res = await supertest(app.server)
      .get(`/nuget/v3-flatcontainer/${id}/1.0.0/${id}.1.0.0.nupkg`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('MAL-2026-1');
  });

  describe('exceptions and waivers', () => {
    const exc = {
      nuget: `DepGate.Exc${tag}`,
      go: `github.com/DepGateExc${tag}/mod`,
      goEscaped: `github.com/!dep!gate!exc${tag.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)}/mod`,
      pypi: `DepGate_Exc${tag}.Pkg`,
      composer: `DepGate/Exc${tag}`,
    };
    const api = () => ({
      post: (url: string, body: object) => supertest(app.server).post(url).set('Authorization', `Bearer ${token}`).send(body),
    });
    const expiresAt = () => new Date(Date.now() + 86_400_000).toISOString();
    let policyId = '';

    afterAll(async () => {
      if (policyId) await app.db.query(`DELETE FROM policies WHERE id = $1`, [policyId]);
      await app.db.query(`DELETE FROM exceptions WHERE package_name ILIKE $1`, [`%exc${tag}%`]);
      await app.db.query(`DELETE FROM waiver_requests WHERE package_name ILIKE $1`, [`%exc${tag}%`]);
    });

    it('stores an exception under its canonical name and finds it under the client spelling', async () => {
      for (const [ecosystem, packageName] of [
        ['nuget', exc.nuget],
        ['go', exc.go],
        ['pypi', exc.pypi],
        ['composer', exc.composer],
      ] as const) {
        const res = await api().post('/api/admin/exceptions', { ecosystem, packageName, version: '*', expiresAt: expiresAt() });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.packageName).toBe(canonicalPackageName(ecosystem, packageName));
      }
      expect(await findActiveException(app.db, 'nuget', exc.nuget.toLowerCase(), '1.0.0')).not.toBeNull();
      expect(await findActiveException(app.db, 'go', exc.goEscaped, 'v1.0.0')).not.toBeNull();
      expect(await findActiveException(app.db, 'pypi', `depgate-exc${tag}-pkg`.toLowerCase(), '1.0.0')).not.toBeNull();
      expect(await findActiveException(app.db, 'composer', exc.composer.toLowerCase(), '1.0.0')).not.toBeNull();
    });

    it('an exception typed in mixed case lifts a block on the lowercased NuGet request', async () => {
      const id = exc.nuget.toLowerCase();
      const created = await api().post('/api/admin/policies', {
        name: `name-match-${tag}`,
        decision: 'BLOCK',
        priority: 1,
        conditions: { ecosystem: ['nuget'], packageBlockList: [id] },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      policyId = created.body.id as string;
      const decisions = await evaluatePackageVersions(app.db, 'nuget', id, [{ version: '1.0.0' }], app.redis);
      expect(decisions.get('1.0.0')).toBeNull();
    });

    it('stores a waiver under its canonical name', async () => {
      const email = `name-match-${tag}@depgate.local`;
      const user = await app.db
        .getRepository(User)
        .save(app.db.getRepository(User).create({ email, passwordHash: await hashPassword('name-match-pass'), role: 'User' }));
      try {
        const login = await supertest(app.server).post('/api/auth/login').send({ email, password: 'name-match-pass' }).expect(200);
        const res = await supertest(app.server)
          .post('/api/waiver-requests')
          .set('Authorization', `Bearer ${login.body.token}`)
          .send({ ecosystem: 'pypi', packageName: exc.pypi, version: '*', expiresAt: expiresAt(), reason: 'name matching test' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.packageName).toBe(`depgate-exc${tag}-pkg`.toLowerCase());
      } finally {
        await app.db.query(`DELETE FROM waiver_requests WHERE requested_by_id = $1`, [user.id]);
        await app.db.getRepository(User).delete({ id: user.id });
      }
    });

    it('matches a monitoring approval to hits recorded with the Go case encoding', async () => {
      await app.db.query(
        `INSERT INTO monitor_hits (id, policy_id, ecosystem, package_name, version, reason_key, reasons, first_seen_at, last_seen_at, hit_count)
         VALUES (gen_random_uuid(), $1, 'go', $2, 'v1.0.0', 'x', '[]'::jsonb, now(), now(), 1)`,
        [policyId, exc.goEscaped]
      );
      const approvals = await loadApprovals(app.db, policyId);
      expect([...(approvals.get(`go\u0000${exc.goEscaped}`)?.approved.keys() ?? [])]).toEqual(['v1.0.0']);
    });

    it('the one-time update rewrites rows stored with another spelling', async () => {
      const legacy = `Legacy.Exc${tag}`;
      await app.db.query(
        `INSERT INTO exceptions (id, package_name, ecosystem, version, expires_at, approved_by, repository_ids, created_at)
         VALUES (gen_random_uuid(), $1, 'nuget', '*', now() + interval '1 day', 'test', '[]'::jsonb, now())`,
        [legacy]
      );
      await app.db.query(
        `INSERT INTO waiver_requests (id, package_name, ecosystem, version, repository_ids, requested_expires_at, reason, status, requested_by, requested_by_id, created_at)
         VALUES (gen_random_uuid(), $1, 'pypi', '*', '[]'::jsonb, now() + interval '1 day', 'r', 'pending', 'test', 'test', now())`,
        [`Legacy_Exc${tag}.Pkg`]
      );
      const result = await ensurePackageNames(app.db);
      expect(result.exceptions).toBeGreaterThanOrEqual(1);
      expect(result.waivers).toBeGreaterThanOrEqual(1);
      const [{ n }] = await app.db.query(`SELECT count(*)::int AS n FROM exceptions WHERE package_name = $1`, [legacy.toLowerCase()]);
      expect(n).toBe(1);
      const [{ w }] = await app.db.query(`SELECT count(*)::int AS w FROM waiver_requests WHERE package_name = $1`, [
        `legacy-exc${tag}-pkg`.toLowerCase(),
      ]);
      expect(w).toBe(1);
      expect(await ensurePackageNames(app.db)).toEqual({ malicious: 0, exceptions: 0, waivers: 0 });
    });
  });

  it('fills the lookup name of a row written without one', async () => {
    const name = `Legacy.Row${tag}`;
    await app.db.query(
      `INSERT INTO malicious_packages (id, name, ecosystem, source, override_status, created_at)
       VALUES ($1, $2, 'nuget', 'default', 'BLOCK', NOW())`,
      [randomUUID(), name]
    );
    expect(await backfillMaliciousLookupNames(app.db)).toBeGreaterThanOrEqual(1);
    expect((await findMaliciousEntry(app.db, 'nuget', name.toLowerCase()))?.name).toBe(name);
  });

  describe('policy patterns and custom entries', () => {
    let patternPolicyId = '';
    const auth = () => `Bearer ${token}`;

    afterAll(async () => {
      if (patternPolicyId) await app.db.query(`DELETE FROM policies WHERE id = $1`, [patternPolicyId]);
    });

    it('a package-list pattern typed with capitals blocks the escaped Go request and the pip spelling', async () => {
      const created = await supertest(app.server)
        .post('/api/admin/policies')
        .set('Authorization', auth())
        .send({
          name: `name-pattern-${tag}`,
          decision: 'BLOCK',
          priority: 1,
          conditions: { ecosystem: ['go', 'pypi'], packageBlockList: [`github.com/DepGatePattern${tag}/*`, `DepGate_Pattern${tag}.*`] },
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      patternPolicyId = created.body.id as string;

      const res = await supertest(app.server)
        .get(`/go/github.com/!dep!gate!pattern${tag}/x/@v/v1.0.0.zip`)
        .set('Authorization', auth());
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain(`name-pattern-${tag}`);

      const decisions = await evaluatePackageVersions(app.db, 'pypi', `depgate-pattern${tag}-tools`, [{ version: '1.0' }], app.redis);
      expect(decisions.get('1.0')).toMatchObject({ decision: 'BLOCK', policyId: patternPolicyId });
    });

    it('adding a custom entry in another spelling turns the feed entry custom instead of adding a second row', async () => {
      const lookup = canonicalPackageName('nuget', names.nuget);
      const res = await supertest(app.server)
        .post('/api/admin/malicious-packages')
        .set('Authorization', auth())
        .send({ name: names.nuget.toLowerCase(), ecosystem: 'nuget' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.name).toBe(names.nuget);
      const rows: { name: string; source: string }[] = await app.db.query(
        `SELECT name, source FROM malicious_packages WHERE ecosystem = 'nuget' AND lookup_name = $1`,
        [lookup]
      );
      expect(rows).toEqual([{ name: names.nuget, source: 'custom' }]);

      const again = await supertest(app.server)
        .post('/api/admin/malicious-packages')
        .set('Authorization', auth())
        .send({ name: names.nuget.toUpperCase(), ecosystem: 'nuget' });
      expect(again.status).toBe(409);
    });

    it('a feed sync repairs a row an older replica wrote without a lookup name', async () => {
      const name = `Replica.Row${tag}`;
      await app.db.query(
        `INSERT INTO malicious_packages (id, name, ecosystem, source, override_status, created_at)
         VALUES ($1, $2, 'nuget', 'default', 'BLOCK', NOW())`,
        [randomUUID(), name]
      );
      expect(await findMaliciousEntry(app.db, 'nuget', name.toLowerCase())).toBeNull();
      expect(await createPackageStore(app.db).fillLookupNames!()).toBeGreaterThanOrEqual(1);
      expect((await findMaliciousEntry(app.db, 'nuget', name.toLowerCase()))?.name).toBe(name);
    });
  });
});
