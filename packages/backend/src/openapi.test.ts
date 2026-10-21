import { buildApp } from './app.js';

describe('openapi', () => {
  it('serves Swagger UI and the OpenAPI document', async () => {
    const app = await buildApp({ docsOnly: true });
    const yaml = await app.inject({ method: 'GET', url: '/api/swagger.yml' });
    expect(yaml.statusCode).toBe(200);
    expect(String(yaml.headers['content-type'])).toContain('yaml');
    expect(yaml.body).toContain('openapi: 3.0.3');
    expect(yaml.body).toContain('/api/auth/login:');
    expect(yaml.body).not.toContain('/api/auth/setup:');
    expect(yaml.body).toContain('/go/{path}:');
    expect(yaml.body).not.toContain('/go/{*}:');

    const json = await app.inject({ method: 'GET', url: '/api/swagger.json' });
    expect(json.statusCode).toBe(200);
    const doc = json.json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.paths['/api/auth/login']).toBeTruthy();
    expect(doc.paths['/api/swagger.yml']).toBeUndefined();

    const ui = await app.inject({ method: 'GET', url: '/api/docs' });
    expect([200, 301, 302, 308]).toContain(ui.statusCode);
    const page = ui.statusCode === 200 ? ui : await app.inject({ method: 'GET', url: '/api/docs/' });
    expect(page.statusCode).toBe(200);
    expect(page.body.toLowerCase()).toContain('swagger');
    await app.close();
  });
});
