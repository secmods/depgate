/**
 * Monitor mode integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1) and network
 * access to the public registries, like the proxy integration tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { Policy } from '../db/entities/Policy.js';
import { Exception } from '../db/entities/Exception.js';
import { auditRows } from '../test-support/event-rows.js';
import { MonitorHit } from '../db/entities/MonitorHit.js';
import { purgeMonitorHits } from '../services/monitor-service.js';

/** Ahead of any policy a developer database already holds. */
const PRIORITY = -3_000_000;

type Case = { ecosystem: string; pkg: string; version: string; download: (version: string) => string };

const CASES: Case[] = [
  { ecosystem: 'npm', pkg: 'is-number', version: '7.0.0', download: (v) => `/npm/is-number/-/is-number-${v}.tgz` },
  {
    ecosystem: 'pypi',
    pkg: 'requests',
    version: '2.32.3',
    download: (v) =>
      `/pypi/files/requests/requests-${v}.tar.gz`,
  },
  { ecosystem: 'go', pkg: 'golang.org/x/text', version: 'v0.15.0', download: (v) => `/go/golang.org/x/text/@v/${v}.zip` },
  {
    ecosystem: 'maven',
    pkg: 'org.slf4j:slf4j-api',
    version: '2.0.13',
    download: (v) => `/maven/org/slf4j/slf4j-api/${v}/slf4j-api-${v}.jar`,
  },
  {
    ecosystem: 'nuget',
    pkg: 'newtonsoft.json',
    version: '13.0.3',
    download: (v) => `/nuget/v3-flatcontainer/newtonsoft.json/${v}/newtonsoft.json.${v}.nupkg`,
  },
  { ecosystem: 'cargo', pkg: 'serde', version: '1.0.198', download: (v) => `/cargo/api/v1/crates/serde/${v}/download` },
  {
    ecosystem: 'composer',
    pkg: 'monolog/monolog',
    version: '3.6.0',
    download: (v) =>
      `/composer/dist/monolog/monolog/${v}`,
  },
  {
    ecosystem: 'rubygems',
    pkg: 'rake',
    version: '13.2.1',
    download: (v) => `/rubygems/gems/rake-${v}.gem`,
  },
];

async function securityToken(app: FastifyInstance): Promise<string> {
  for (const creds of [
    { email: 'admin@depgate.local', password: 'admin' },
    { email: 'npmpolicyadmin@depgate.local', password: 'npmpolicyadmin123' },
  ]) {
    const res = await supertest(app.server).post('/api/auth/login').send(creds);
    if (res.status === 200 && res.body.token) return res.body.token as string;
  }
  throw new Error('Could not obtain a Security token');
}

describe.skipIf(!process.env.RUN_INTEGRATION)('monitor mode', () => {
  const timeout = 90_000;
  let app: FastifyInstance;
  let token: string;
  const policyIds: string[] = [];
  const run = Date.now();

  const api = () => ({
    get: (url: string) => supertest(app.server).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => supertest(app.server).post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    put: (url: string, body: object) => supertest(app.server).put(url).set('Authorization', `Bearer ${token}`).send(body),
    del: (url: string) => supertest(app.server).delete(url).set('Authorization', `Bearer ${token}`),
  });

  async function createPolicy(body: Record<string, unknown>): Promise<string> {
    const res = await api().post('/api/admin/policies', { priority: PRIORITY, decision: 'BLOCK', ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    policyIds.push(res.body.id);
    return res.body.id as string;
  }

  const hits = (policyId: string) => app.db.getRepository(MonitorHit).find({ where: { policyId } });

  /** Recording is fire-and-forget, so wait for the row the download wrote. */
  async function waitForHits(policyId: string, predicate: (rows: MonitorHit[]) => boolean): Promise<MonitorHit[]> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const rows = await hits(policyId);
      if (predicate(rows) || Date.now() > deadline) return rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Ends the 60 s write window, so the next download writes its row at once. */
  async function closeWriteWindow(): Promise<void> {
    const keys = await app.redis.keys('monitor:gate:*');
    if (keys.length) await app.redis.del(...keys);
  }

  async function insertRows(policyId: string, rows: Array<{ ecosystem?: string; pkg: string; version: string; reasonKey?: string; lastSeenDaysAgo?: number; hits?: number }>) {
    for (const row of rows) {
      await app.db.query(
        `INSERT INTO monitor_hits (id, policy_id, ecosystem, package_name, version, reason_key, reasons, first_seen_at, last_seen_at, hit_count)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, now() - make_interval(days => $7), now() - make_interval(days => $7), $8)`,
        [
          policyId,
          row.ecosystem ?? 'npm',
          row.pkg,
          row.version,
          row.reasonKey ?? 'GPL-3.0',
          JSON.stringify([`reason for ${row.pkg}`]),
          row.lastSeenDaysAgo ?? 0,
          row.hits ?? 1,
        ]
      );
    }
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    token = await securityToken(app);
  }, timeout);

  afterAll(async () => {
    if (!app) return;
    if (policyIds.length) {
      await app.db.getRepository(Exception).delete(policyIds.map((policyId) => ({ policyId })));
      await app.db.getRepository(Policy).delete(policyIds);
    }
    await app.close();
  });

  describe('policy mode', () => {
    it('accepts monitor for Block policies and returns mode and modeChangedAt', async () => {
      const id = await createPolicy({ name: `mon-mode-${run}`, mode: 'monitor', conditions: { packageBlockList: ['mon-none-*'] } });
      const res = await api().get(`/api/admin/policies/${id}`);
      expect(res.body.mode).toBe('monitor');
      expect(Date.parse(res.body.modeChangedAt)).toBeGreaterThan(Date.now() - 60_000);
      const list = await api().get('/api/admin/policies?limit=500');
      expect(list.body.monitoring).toBeGreaterThanOrEqual(1);
    });

    it('defaults to enforce and refuses monitor for an Allow policy', async () => {
      const id = await createPolicy({ name: `mon-default-${run}`, conditions: { packageBlockList: ['mon-none-*'] } });
      expect((await api().get(`/api/admin/policies/${id}`)).body.mode).toBe('enforce');
      const allow = await api().post('/api/admin/policies', {
        name: `mon-allow-${run}`,
        decision: 'ALLOW',
        mode: 'monitor',
        priority: PRIORITY,
        conditions: { packageBlockList: ['x'] },
      });
      expect(allow.status).toBe(400);
      expect((await api().put(`/api/admin/policies/${id}`, { decision: 'ALLOW', mode: 'monitor' })).status).toBe(400);
    });

    it('audits mode changes; switching back to monitor starts empty', async () => {
      const id = await createPolicy({ name: `mon-switch-${run}`, mode: 'monitor', conditions: { packageBlockList: ['mon-switch-*'] } });
      await insertRows(id, [{ pkg: 'mon-switch-a', version: '1.0.0' }]);
      const enforced = await api().put(`/api/admin/policies/${id}`, { mode: 'enforce' });
      expect(enforced.status).toBe(200);
      expect(enforced.body.mode).toBe('enforce');
      expect(await hits(id)).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const audits = await auditRows(app.db, { type: 'POLICY_UPDATED', targetKind: 'policy', targetId: id });
      expect(audits.some((row) => row.reasons?.includes('Mode changed from monitor to enforce'))).toBe(true);

      const enforcedList = await api().get('/api/admin/monitor/policies?status=enforced');
      expect(enforcedList.body.items.map((p: { id: string }) => p.id)).toContain(id);

      await api().put(`/api/admin/policies/${id}`, { mode: 'monitor' });
      expect(await hits(id)).toHaveLength(0);
    });
  });

  describe.each(CASES)('$ecosystem artifact download', (c) => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await createPolicy({
        name: `mon-${c.ecosystem}-${run}`,
        mode: 'monitor',
        conditions: { ecosystem: [c.ecosystem], packageBlockList: [c.pkg] },
      });
      await closeWriteWindow();
    }, timeout);

    it('is served and recorded; a second download counts twice', async () => {
      const first = await supertest(app.server).get(c.download(c.version)).set('Authorization', `Bearer ${token}`);
      expect(first.status, first.text?.slice(0, 200)).toBe(200);
      let rows = await waitForHits(policyId, (r) => r.length > 0);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ecosystem: c.ecosystem, version: c.version, hitCount: 1, reasonKey: c.pkg });

      await closeWriteWindow();
      const second = await supertest(app.server).get(c.download(c.version)).set('Authorization', `Bearer ${token}`);
      expect(second.status).toBe(200);
      rows = await waitForHits(policyId, (r) => r[0]?.hitCount === 2);
      expect(rows[0].hitCount).toBe(2);
    }, timeout);
  });

  describe('metadata requests', () => {
    it('never record and never filter versions for a monitoring policy', async () => {
      const id = await createPolicy({
        name: `mon-meta-${run}`,
        mode: 'monitor',
        conditions: { ecosystem: ['npm'], packageBlockList: ['is-odd'] },
      });
      const packument = await api().get('/npm/is-odd');
      expect(packument.status).toBe(200);
      expect(Object.keys(packument.body.versions)).toContain('3.0.1');
      const info = await api().get('/go/golang.org/x/text/@v/v0.15.0.info');
      expect(info.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await hits(id)).toHaveLength(0);
    }, timeout);
  });

  describe('only new breakage', () => {
    it('a lower enforced Block means no row; once it is disabled the download records', async () => {
      const monitor = await createPolicy({
        name: `mon-new-${run}`,
        mode: 'monitor',
        conditions: { ecosystem: ['npm'], packageBlockList: ['is-number'] },
      });
      const block = await createPolicy({
        name: `mon-new-block-${run}`,
        priority: PRIORITY + 1,
        conditions: { ecosystem: ['npm'], packageBlockList: ['is-number'], versionRange: '=6.0.0' },
      });
      await closeWriteWindow();
      const blocked = await api().get('/npm/is-number/-/is-number-6.0.0.tgz');
      expect(blocked.status).toBe(403);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await hits(monitor)).toHaveLength(0);

      await api().put(`/api/admin/policies/${block}`, { isEnabled: false });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const served = await api().get('/npm/is-number/-/is-number-6.0.0.tgz');
      expect(served.status).toBe(200);
      expect(await waitForHits(monitor, (r) => r.length > 0)).toHaveLength(1);
    }, timeout);
  });

  describe('approvals', () => {
    let packagesPolicy: string;

    beforeAll(async () => {
      packagesPolicy = await createPolicy({ name: `mon-approve-${run}`, mode: 'monitor', conditions: { packageBlockList: ['mon-appr-*'] } });
      await insertRows(packagesPolicy, ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0'].map((version) => ({ pkg: 'mon-appr-a', version })));
    });

    const approve = (policyId: string, items: Array<{ ecosystem?: string; packageName: string; versions: string[] }>) =>
      api().post('/api/admin/monitor/approve', {
        policyId,
        items: items.map((item) => ({ ecosystem: 'npm', ...item })),
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        reason: 'needed by checkout',
      });

    it('5 versions become one || record, and approving again widens it', async () => {
      const res = await approve(packagesPolicy, [{ packageName: 'mon-appr-a', versions: ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0'] }]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = await app.db.getRepository(Exception).find({ where: { policyId: packagesPolicy } });
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe('=1.0.0 || =1.1.0 || =1.2.0 || =1.3.0 || =1.4.0');

      const again = await approve(packagesPolicy, [{ packageName: 'mon-appr-a', versions: ['2.0.0'] }]);
      expect(again.body.items[0].action).toBe('widened');
      const widened = await app.db.getRepository(Exception).find({ where: { policyId: packagesPolicy } });
      expect(widened).toHaveLength(1);
      expect(widened[0].version).toContain('=2.0.0');

      const list = await api().get(`/api/admin/monitor/packages?policyId=${packagesPolicy}&status=approved`);
      expect(list.body.items[0]).toMatchObject({ packageName: 'mon-appr-a', status: 'approved', approvedVersions: 5 });
      const exceptions = await api().get(`/api/admin/exceptions?appliesTo=${packagesPolicy}`);
      expect(exceptions.body.items[0]).toMatchObject({ policyId: packagesPolicy, policyName: `mon-approve-${run}` });
      const global = await api().get('/api/admin/exceptions?package=mon-appr-a');
      expect(global.body.items).toHaveLength(0);
    });

    it('* is one record', async () => {
      const res = await approve(packagesPolicy, [{ packageName: 'mon-appr-star', versions: ['*'] }]);
      expect(res.status).toBe(200);
      const rows = await app.db.getRepository(Exception).find({ where: { policyId: packagesPolicy, packageName: 'mon-appr-star' } });
      expect(rows.map((row) => row.version)).toEqual(['*']);
    });

    it('a list longer than 128 characters is refused', async () => {
      const versions = Array.from({ length: 30 }, (_, i) => `1.${i}.0`);
      const res = await approve(packagesPolicy, [{ packageName: 'mon-appr-long', versions }]);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('range');
    });

    it('release age and release type policies cannot approve; vulnerability refuses *', async () => {
      const age = await createPolicy({ name: `mon-age-${run}`, mode: 'monitor', conditions: { releaseAgeMaxHours: 24 } });
      const type = await createPolicy({ name: `mon-type-${run}`, mode: 'monitor', conditions: { releaseTypes: ['prerelease'] } });
      const vuln = await createPolicy({ name: `mon-vuln-${run}`, mode: 'monitor', conditions: { cvssMin: 7 } });
      expect((await approve(age, [{ packageName: 'a', versions: ['1.0.0'] }])).status).toBe(400);
      expect((await approve(type, [{ packageName: 'a', versions: ['1.0.0'] }])).status).toBe(400);
      expect((await approve(vuln, [{ packageName: 'a', versions: ['*'] }])).status).toBe(400);
      expect((await approve(vuln, [{ packageName: 'a', versions: ['1.0.0'] }])).status).toBe(200);
    });
  });

  describe('restart and retention', () => {
    it('restart deletes only this policy rows, resets Monitoring since, keeps approvals, and is audited', async () => {
      const a = await createPolicy({ name: `mon-restart-a-${run}`, mode: 'monitor', conditions: { packageBlockList: ['mon-rs-*'] } });
      const b = await createPolicy({ name: `mon-restart-b-${run}`, mode: 'monitor', conditions: { packageBlockList: ['mon-rs-*'] } });
      await insertRows(a, [{ pkg: 'mon-rs-x', version: '1.0.0' }, { pkg: 'mon-rs-x', version: '1.1.0' }]);
      await insertRows(b, [{ pkg: 'mon-rs-x', version: '1.0.0' }]);
      await api().post('/api/admin/monitor/approve', {
        policyId: a,
        items: [{ ecosystem: 'npm', packageName: 'mon-rs-x', versions: ['1.0.0'] }],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        reason: 'keep',
      });
      const before = (await api().get(`/api/admin/policies/${a}`)).body.modeChangedAt;
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await api().post(`/api/admin/monitor/policies/${a}/restart`);
      expect(res.status).toBe(200);
      expect(res.body.cleared).toBe(2);
      expect(await hits(a)).toHaveLength(0);
      expect(await hits(b)).toHaveLength(1);
      expect(Date.parse((await api().get(`/api/admin/policies/${a}`)).body.modeChangedAt)).toBeGreaterThan(Date.parse(before));
      expect(await app.db.getRepository(Exception).count({ where: { policyId: a } })).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const audits = await auditRows(app.db, { type: 'POLICY_UPDATED', targetKind: 'policy', targetId: a });
      expect(audits.some((row) => row.reasons?.[0] === 'Monitoring restarted (2 rows cleared)')).toBe(true);

      const enforced = await createPolicy({ name: `mon-restart-enf-${run}`, conditions: { packageBlockList: ['mon-rs-none'] } });
      expect((await api().post(`/api/admin/monitor/policies/${enforced}/restart`)).status).toBe(400);
    });

    it('purges rows older than the window and keeps newer ones; 0 keeps everything', async () => {
      const id = await createPolicy({ name: `mon-retention-${run}`, mode: 'monitor', conditions: { packageBlockList: ['mon-ret-*'] } });
      await insertRows(id, [
        { pkg: 'mon-ret-old', version: '1.0.0', lastSeenDaysAgo: 120 },
        { pkg: 'mon-ret-new', version: '1.0.0', lastSeenDaysAgo: 10 },
      ]);
      await purgeMonitorHits(app.db, { retentionDays: 0 });
      expect(await hits(id)).toHaveLength(2);
      const result = await purgeMonitorHits(app.db, { retentionDays: 90 });
      expect(result?.expired).toBeGreaterThanOrEqual(1);
      expect((await hits(id)).map((row) => row.packageName)).toEqual(['mon-ret-new']);
    });
  });

  describe('report', () => {
    let id: string;
    let other: string;

    beforeAll(async () => {
      id = await createPolicy({ name: `mon-report-${run}`, mode: 'monitor', conditions: { licenseAllowList: ['MIT'] } });
      other = await createPolicy({ name: `mon-report-other-${run}`, mode: 'monitor', conditions: { licenseAllowList: ['MIT'] } });
      await insertRows(id, [
        { pkg: 'gpl-a', version: '1.0.0', reasonKey: 'GPL-3.0', hits: 10 },
        { pkg: 'gpl-a', version: '2.0.0', reasonKey: 'GPL-3.0', hits: 5 },
        { pkg: 'gpl-b', version: '1.0.0', reasonKey: 'GPL-3.0', hits: 1, lastSeenDaysAgo: 40 },
        { pkg: '=cmd()', version: '1.0.0', reasonKey: 'UNKNOWN', hits: 3 },
      ]);
      await insertRows(other, [{ pkg: 'gpl-a', version: '1.0.0' }]);
    });

    it('groups reasons largest first with share', async () => {
      const res = await api().get(`/api/admin/monitor/policies/${id}/reasons`);
      expect(res.body.items.map((g: { reasonKey: string; packages: number }) => [g.reasonKey, g.packages])).toEqual([
        ['GPL-3.0', 2],
        ['UNKNOWN', 1],
      ]);
      expect(res.body.items[0].share).toBeCloseTo(2 / 3);
      const recent = await api().get(`/api/admin/monitor/policies/${id}/reasons?lastSeenWithin=30d`);
      expect(recent.body.items[0].packages).toBe(1);
    });

    it('lists one item per package with versions, downloads and Also matched by', async () => {
      const res = await api().get(`/api/admin/monitor/packages?policyId=${id}&reasonKey=GPL-3.0`);
      expect(res.body.total).toBe(2);
      const first = res.body.items[0];
      expect(first).toMatchObject({
        packageName: 'gpl-a',
        versionCount: 2,
        downloads: 15,
        status: 'will_block',
        versionRange: { min: '1.0.0', max: '2.0.0' },
      });
      expect(first.versions.map((v: { version: string }) => v.version)).toEqual(['2.0.0', '1.0.0']);
      expect(first.alsoMatchedBy).toEqual([{ policyId: other, policyName: `mon-report-other-${run}` }]);
      const search = await api().get(`/api/admin/monitor/packages?policyId=${id}&search=gpl-b&lastSeenWithin=30d`);
      expect(search.body.total).toBe(0);
    });

    it('impact counts what Enforce would block', async () => {
      const res = await api().get(`/api/admin/monitor/policies/${id}/impact`);
      expect(res.body).toMatchObject({ packagesToBlock: 3, versionsToBlock: 4, downloadsToBlock: 19, approvedPackages: 0 });
      expect(res.body.topReasons[0].reasonKey).toBe('GPL-3.0');
      const summary = await api().get('/api/admin/monitor/policies');
      const card = summary.body.items.find((p: { id: string }) => p.id === id);
      expect(card).toMatchObject({ packages: 3, versions: 4, downloads: 19, willBlock: 3, approvable: true, capped: false });
      const one = await api().get(`/api/admin/monitor/policies/${id}`);
      expect(one.body).toMatchObject({ id, mode: 'monitor', packages: 3, willBlock: 3 });
      expect((await api().get('/api/admin/monitor/policies/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });

    it('exports what is shown as CSV, escaping formulas', async () => {
      const pkg = await api().get(`/api/admin/monitor/packages.csv?policyId=${id}&status=all`);
      expect(pkg.status).toBe(200);
      expect(pkg.headers['content-disposition']).toMatch(/depgate-monitoring-mon-report-\d+-\d{8}-\d{4}\.csv/);
      const lines = pkg.text.replace(/^\uFEFF/, '').trim().split('\r\n');
      expect(lines).toHaveLength(4);
      expect(pkg.text).toContain("'=cmd()");
      const versions = await api().get(`/api/admin/monitor/packages.csv?policyId=${id}&status=all&granularity=version&reasonKey=GPL-3.0`);
      expect(versions.text.replace(/^\uFEFF/, '').trim().split('\r\n')).toHaveLength(4);
    });
  });

  describe('flow', () => {
    it('monitor → download → edit rule + recheck → approve → enforce → approved installs, unapproved 403 → delete', async () => {
      const id = await createPolicy({
        name: `mon-flow-${run}`,
        mode: 'monitor',
        conditions: { ecosystem: ['npm'], packageBlockList: ['is-number', 'is-odd'] },
      });
      await closeWriteWindow();
      for (const path of ['/npm/is-number/-/is-number-7.0.0.tgz', '/npm/is-number/-/is-number-6.0.0.tgz', '/npm/is-odd/-/is-odd-3.0.1.tgz']) {
        expect((await api().get(path)).status).toBe(200);
      }
      expect(await waitForHits(id, (r) => r.length === 3)).toHaveLength(3);

      // Narrow the rule: is-odd no longer matches, so the recheck drops its row.
      const edit = await api().put(`/api/admin/policies/${id}`, {
        conditions: { ecosystem: ['npm'], packageBlockList: ['is-number'] },
      });
      expect(edit.body.recheck).toBe(true);
      const rows = await waitForHits(id, (r) => r.length === 2);
      expect(rows.map((r) => r.packageName).sort()).toEqual(['is-number', 'is-number']);

      const approved = await api().post('/api/admin/monitor/approve', {
        policyId: id,
        items: [{ ecosystem: 'npm', packageName: 'is-number', versions: ['7.0.0'] }],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        reason: 'still needed',
      });
      expect(approved.status).toBe(200);
      const impact = await api().get(`/api/admin/monitor/policies/${id}/impact`);
      expect(impact.body).toMatchObject({ versionsToBlock: 1, partlyApprovedPackages: 1 });

      expect((await api().put(`/api/admin/policies/${id}`, { mode: 'enforce' })).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await api().get('/npm/is-number/-/is-number-7.0.0.tgz')).status).toBe(200);
      expect((await api().get('/npm/is-number/-/is-number-6.0.0.tgz')).status).toBe(403);

      expect((await api().del(`/api/admin/policies/${id}`)).status).toBe(204);
      expect(await hits(id)).toHaveLength(0);
      expect(await app.db.getRepository(Exception).count({ where: { policyId: id } })).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const revoked = await auditRows(app.db, { type: 'EXCEPTION_REVOKED', policyId: id });
      expect(revoked[0]?.reasons).toEqual(['Policy deleted']);
    }, timeout);
  });

  describe('scale', () => {
    it('50,000 rows: reasons and the first page in under 500 ms; the CSV has every row', async () => {
      const id = await createPolicy({ name: `mon-scale-${run}`, mode: 'monitor', conditions: { licenseAllowList: ['MIT'] } });
      await app.db.query(
        `INSERT INTO monitor_hits (id, policy_id, ecosystem, package_name, version, reason_key, reasons, first_seen_at, last_seen_at, hit_count)
         SELECT gen_random_uuid(), $1, 'npm', 'scale-pkg-' || (g % 5000), '1.0.' || g,
                (ARRAY['GPL-3.0','AGPL-3.0','UNKNOWN','SSPL-1.0'])[1 + g % 4], '["x"]'::jsonb, now(), now(), 1 + g % 7
           FROM generate_series(1, 50000) g`,
        [id]
      );
      await app.db.query('ANALYZE monitor_hits');
      const started = Date.now();
      const [reasons, page] = await Promise.all([
        api().get(`/api/admin/monitor/policies/${id}/reasons`),
        api().get(`/api/admin/monitor/packages?policyId=${id}&status=all`),
      ]);
      const elapsed = Date.now() - started;
      expect(reasons.status).toBe(200);
      expect(page.body.total).toBe(5000);
      expect(elapsed).toBeLessThan(500);

      const csv = await api().get(`/api/admin/monitor/packages.csv?policyId=${id}&status=all&granularity=version`);
      expect(csv.text.replace(/^\uFEFF/, '').trim().split('\r\n')).toHaveLength(50_001);

      // At the row limit, a new version is counted but not stored.
      const summary = await api().get('/api/admin/monitor/policies');
      expect(summary.body.items.find((p: { id: string }) => p.id === id).capped).toBe(true);
    }, timeout);
  });
});
