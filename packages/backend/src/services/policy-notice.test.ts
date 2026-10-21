import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { blockedVersionMessage, packageCheckUrl, policyDenialBody, policyStatusPhrase, sendPolicyDenial } from './policy-notice.js';
import { config } from '../config.js';

describe('policy-notice', () => {
  it('names the policy in the sentence clients match on', () => {
    const message = blockedVersionMessage({
      policyName: 'Block lodash',
      reasons: ['manual block'],
      remediation: 'Request a waiver.',
    });
    expect(message).toContain('blocked');
    expect(message).toContain('Block lodash');
    expect(message).toContain('manual block');
    expect(message).toContain('Request a waiver.');
  });

  it('keeps the HTTP reason phrase on one printable line', () => {
    expect(policyStatusPhrase('Package blocked by policy "A":\nline')).toBe(
      'Package blocked by policy "A": line'
    );
  });

  it('returns 403 with the phrase Go, Maven, NuGet, pip, and RubyGems print', async () => {
    const app = Fastify();
    app.get('/blocked', async (_request, reply) =>
      sendPolicyDenial(reply, {
        policyId: 'p1',
        policyName: 'Block lodash',
        reasons: ['manual block'],
        remediation: 'Request a waiver.',
      })
    );
    const res = await app.inject({ method: 'GET', url: '/blocked' });
    expect(res.statusCode).toBe(403);
    expect(res.statusMessage).toContain('Package blocked by policy "Block lodash"');
    expect(res.headers['x-error-message']).toContain('blocked');
    expect(res.json().error).toContain('blocked');
    expect(res.json().detail).toContain('manual block');
    expect(res.json().errors[0].detail).toContain('Request a waiver.');
    expect(res.json().policyName).toBe('Block lodash');
    await app.close();
  });

  it('keeps a short npm status line so the policy sentence is not repeated', async () => {
    const app = Fastify();
    app.get('/blocked', async (_request, reply) =>
      sendPolicyDenial(
        reply,
        { policyName: 'Block lodash', reasons: ['manual block'] },
        { statusMessage: 'Forbidden' }
      )
    );
    const res = await app.inject({ method: 'GET', url: '/blocked' });
    expect(res.statusMessage).toBe('Forbidden');
    expect(res.json().error).toContain('Package blocked by policy "Block lodash"');
    expect(res.json().error).not.toBe(res.statusMessage);
    await app.close();
  });

  it('links a denial to the Package check page for the blocked version', () => {
    const base = config.ui.baseUrl.replace(/\/$/, '');
    expect(packageCheckUrl({ ecosystem: 'npm', packageName: '@scope/pkg', version: '1.0.0-rc.1' })).toBe(
      `${base}/package-check?ecosystem=npm&package=%40scope%2Fpkg&version=1.0.0-rc.1`
    );
    expect(packageCheckUrl({ ecosystem: 'pypi', packageName: 'requests', version: '2.0', repository: 'internal' })).toContain(
      '&repository=internal'
    );
    expect(policyDenialBody({ policyName: 'A' }).checkUrl).toBeUndefined();
    expect(
      policyDenialBody({ policyName: 'A' }, { ecosystem: 'npm', packageName: 'lodash', version: '4.17.20' }).checkUrl
    ).toContain('package=lodash&version=4.17.20');
  });
});
