import Fastify from 'fastify';
import { fastifyTrustProxy } from './app.js';

async function clientIp(trustProxy: boolean | number | string, forwardedFor: string): Promise<string> {
  const app = Fastify({ trustProxy: fastifyTrustProxy(trustProxy) });
  app.get('/ip', async (request) => request.ip);
  const res = await app.inject({ method: 'GET', url: '/ip', remoteAddress: '10.0.0.2', headers: { 'x-forwarded-for': forwardedFor } });
  await app.close();
  return res.body;
}

describe('TRUST_PROXY hop count', () => {
  it('takes the client address from as many proxies as configured', async () => {
    expect(await clientIp(1, '203.0.113.7, 198.51.100.9')).toBe('198.51.100.9');
    expect(await clientIp(2, '203.0.113.7, 198.51.100.9')).toBe('203.0.113.7');
  });

  it('keeps the socket address with no hops, and passes other settings through', async () => {
    expect(await clientIp(0, '203.0.113.7')).toBe('10.0.0.2');
    expect(await clientIp(false, '203.0.113.7')).toBe('10.0.0.2');
    expect(await clientIp('10.0.0.2', '203.0.113.7')).toBe('203.0.113.7');
  });
});
