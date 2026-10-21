import Fastify, { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback, FastifySchema } from 'fastify';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import healthPlugin from './plugins/health.js';
import uiStatic from './plugins/ui-static.js';
import { config } from './config.js';
import { APP_VERSION } from './version.js';
import { ECOSYSTEMS, rewritePackageUrl, type RepoTaggedRequest } from './services/repo-keys.js';
import { isUnsafePathParam } from './services/upstream-path.js';
import { runWithRequest } from './services/request-context.js';
import artifactCachePlugin, { type ArtifactCachePluginOptions } from './plugins/artifact-cache.js';

export interface BuildAppOptions {
  skipInfra?: boolean;
  /** Register every API route so the OpenAPI document can be written, without Postgres, Redis, or job workers. */
  docsOnly?: boolean;
  /** Artifact cache settings that replace the environment's (tests run pods with their own directories). */
  artifactCache?: ArtifactCachePluginOptions['overrides'];
}

type AppPlugin = FastifyPluginAsync | FastifyPluginCallback;

const nodeRequire = createRequire(__filename);

function devLogTransport(): { target: string } | undefined {
  if (process.env.NODE_ENV !== 'development') return undefined;
  try {
    nodeRequire.resolve('pino-pretty');
    return { target: 'pino-pretty' };
  } catch {
    return undefined;
  }
}

/** Certificate and key from TLS_CERT_FILE and TLS_KEY_FILE, or undefined to serve plain HTTP. */
export function readTlsFiles(): { cert: Buffer; key: Buffer } | undefined {
  const { disabled, certFile, keyFile } = config.tls;
  if (disabled || (!certFile && !keyFile)) return undefined;
  if (!certFile || !keyFile) throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither');
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

/**
 * Fastify 5.12 trusts no address for a numeric trustProxy. A hop count keeps its earlier meaning: the nearest
 * `hops` addresses (the socket peer first) are proxies, the same as Express and Fastify before 5.12.
 */
export function fastifyTrustProxy(value: boolean | number | string): boolean | string | ((address: string, hop: number) => boolean) {
  if (typeof value !== 'number') return value;
  return (_address, hop) => hop < value;
}

/** OpenAPI parameter names cannot be `*`. Wildcard routes are documented as `{path}`. */
function documentRoute(args: { schema: FastifySchema; url: string }): { schema: FastifySchema; url: string } {
  if (!args.url.includes('*')) return args;
  const params = args.schema?.params;
  let schema = args.schema;
  if (params && typeof params === 'object' && !Array.isArray(params) && 'properties' in params) {
    const record = params as { required?: string[]; properties?: Record<string, unknown> };
    if (record.properties && '*' in record.properties) {
      const { '*': star, ...rest } = record.properties;
      const starSchema = typeof star === 'object' && star ? star : {};
      schema = {
        ...args.schema,
        params: {
          ...record,
          required: (record.required ?? []).map((name) => (name === '*' ? 'path' : name)),
          properties: { ...rest, path: { ...starSchema, description: 'Remainder of the request path' } },
        },
      };
    }
  }
  return { schema, url: args.url.replaceAll('*', '{path}') };
}

async function loadPlugin(specifier: string): Promise<AppPlugin> {
  const loaded = (await import(specifier)) as { default?: AppPlugin };
  const plugin = loaded.default;
  if (!plugin) throw new Error(`Missing default export: ${specifier}`);
  return plugin;
}

export async function buildApp(opts?: BuildAppOptions): Promise<FastifyInstance> {
  const docsOnly = opts?.docsOnly ?? false;
  const skipInfra = opts?.skipInfra ?? false;
  const connectInfra = !skipInfra && !docsOnly;
  const registerRoutes = connectInfra || docsOnly;

  const tls = readTlsFiles();
  const app = Fastify({
    ...(tls ? { https: tls } : {}),
    trustProxy: fastifyTrustProxy(config.trustProxy),
    // Route params hold artifact file names; PyPI wheel names with several
    // platform tags exceed Fastify's default of 100 and would get HTTP 414.
    routerOptions: { maxParamLength: 1024 },
    // Log Streaming settings take `type: ['string', 'number', 'null']`; an anyOf would coerce numbers to strings.
    ajv: { customOptions: { allowUnionTypes: true } },
    rewriteUrl(req) {
      return rewritePackageUrl(req.url ?? '/', req as unknown as RepoTaggedRequest);
    },
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            level: config.logLevel,
            transport: devLogTransport(),
          },
  });

  // Before any plugin, so every route inherits it.
  const { upstreamErrorHandler } = await import('./services/upstream-provider.js');
  app.setErrorHandler(upstreamErrorHandler);

  // The ledger writer reads the repository key from the request in flight.
  app.addHook('onRequest', (req, _reply, done) => {
    runWithRequest(req.raw as unknown as RepoTaggedRequest, done);
  });

  // The router decodes `%2F` and leaves `..` in params; refuse them before any policy sees the name.
  app.addHook('preValidation', async (req, reply) => {
    const routeUrl = req.routeOptions.url ?? '';
    if (!ECOSYSTEMS.some((eco) => routeUrl.startsWith(`/${eco}/`))) return;
    const params = (req.params ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(params)) {
      if (typeof value !== 'string') continue;
      const wildcard = name === '*';
      const allowScopedName = routeUrl.startsWith('/npm/:pkg') && name === 'pkg';
      if (isUnsafePathParam(value, { wildcard, allowScopedName })) {
        return reply.status(400).send({ error: 'Invalid package path' });
      }
    }
  });

  await app.register(cors, { origin: true });

  await app.register(swagger, {
    transform: documentRoute,
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'DepGate API',
        description:
          'DepGate — control what enters your software supply chain. ' +
          'Interactive docs are at /api/docs. This document is also at /api/swagger.yml and /api/swagger.json. ' +
          'Send a session token, API key, or CI token as Authorization: Bearer <token>.',
        version: APP_VERSION,
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Session token from POST /api/auth/login, an API key, or a CI token. A Basic password or a bare Authorization value is also accepted.',
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'Auth', description: 'Authentication (login, single sign-on, password reset)' },
        { name: 'Single sign-on', description: 'OIDC identity providers and who may sign in with them' },
        { name: 'Users', description: 'User accounts' },
        { name: 'Service accounts', description: 'Service accounts' },
        { name: 'Mail', description: 'SMTP settings for invitation and password reset emails' },
        { name: 'API Keys', description: 'Admin API key management' },
        { name: 'CI Tokens', description: 'CI tokens for package clients' },
        { name: 'Upstream Registries', description: 'Manage upstream registries (npm, PyPI, Go, Maven)' },
        { name: 'Repositories', description: 'Package repositories' },
        { name: 'Policies', description: 'Policy engine rules (block, allow)' },
        { name: 'Exceptions', description: 'Policy exceptions (allow specific packages)' },
        { name: 'Waiver requests', description: 'Requests to waive a policy block' },
        { name: 'Malicious Packages', description: 'Malicious package feed and custom overrides' },
        { name: 'EPSS', description: 'EPSS exploit-probability scores' },
        { name: 'Webhooks', description: 'Webhook targets for events' },
        { name: 'Dashboard', description: 'Dashboard stats and charts' },
        { name: 'Audit Logs', description: 'Audit log history' },
        { name: 'Config', description: 'Gateway security configuration' },
        { name: 'Licenses', description: 'OSI-approved licenses reference' },
        { name: 'Package check', description: 'Which versions of a package can be used, before installing' },
        { name: 'Jobs', description: 'Background job queues: schedules, runs, failed jobs' },
        { name: 'Namespaces', description: 'Internal namespace rule: reserved names, remotes that serve them, collisions' },
        { name: 'Artifact cache', description: 'Package files from public remotes kept on each pod: status and purge' },
        { name: 'Health', description: 'Liveness and readiness' },
        { name: 'npm Proxy', description: 'npm registry proxy (packument, tarball)' },
        { name: 'PyPI Proxy', description: 'PyPI proxy (simple index, artifact files)' },
        { name: 'Go Proxy', description: 'Go module proxy (list, .info, .mod, .zip)' },
        { name: 'Maven Proxy', description: 'Maven proxy (maven-metadata.xml, artifacts, checksums)' },
        { name: 'NuGet Proxy', description: 'NuGet proxy (v3 index, flat container metadata, nupkg artifacts)' },
        { name: 'Cargo Proxy', description: 'Cargo proxy (crate metadata, download artifacts)' },
        { name: 'Composer Proxy', description: 'Composer proxy (package metadata and dist artifact files)' },
        { name: 'RubyGems Proxy', description: 'RubyGems proxy (gem version metadata and gem artifacts)' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
  });

  await app.register(await loadPlugin('./routes/licenses.js'));

  if (registerRoutes) {
    if (connectInfra) {
      await app.register(await loadPlugin('./plugins/database.js'));
      await app.register(await loadPlugin('./plugins/redis.js'));
    }
    await app.register(artifactCachePlugin, {
      overrides: docsOnly ? { ...opts?.artifactCache, enabled: false } : opts?.artifactCache,
    });
    await app.register(await loadPlugin('./plugins/auth.js'));
    await app.register(await loadPlugin('./routes/auth.js'));
    await app.register(await loadPlugin('./routes/sso.js'));
    await app.register(await loadPlugin('./routes/sso-admin.js'));
    await app.register(await loadPlugin('./routes/api-keys.js'));
    await app.register(await loadPlugin('./routes/accounts.js'));
    await app.register(await loadPlugin('./routes/mail-settings.js'));
    await app.register(await loadPlugin('./routes/ci-tokens.js'));
    await app.register(await loadPlugin('./routes/upstream-registries.js'));
    await app.register(await loadPlugin('./routes/repositories.js'));
    await app.register(await loadPlugin('./routes/policies.js'));
    await app.register(await loadPlugin('./routes/malicious-packages.js'));
    await app.register(await loadPlugin('./routes/npm.js'));
    await app.register(await loadPlugin('./routes/pypi.js'));
    await app.register(await loadPlugin('./routes/go.js'));
    await app.register(await loadPlugin('./routes/maven.js'));
    await app.register(await loadPlugin('./routes/nuget.js'));
    await app.register(await loadPlugin('./routes/cargo.js'));
    await app.register(await loadPlugin('./routes/composer.js'));
    await app.register(await loadPlugin('./routes/rubygems.js'));
    if (connectInfra) await app.register(await loadPlugin('./plugins/jobs.js'));
    if (connectInfra) await app.register(await loadPlugin('./plugins/events.js'));
  }

  await app.register(healthPlugin, { skipInfra: !connectInfra });

  if (registerRoutes) {
    if (connectInfra) await app.register(await loadPlugin('./plugins/metrics.js'));
    await app.register(await loadPlugin('./routes/events.js'));
    await app.register(await loadPlugin('./routes/stream-destinations.js'));
    await app.register(await loadPlugin('./routes/dashboard.js'));
    await app.register(await loadPlugin('./routes/webhooks.js'));
    await app.register(await loadPlugin('./routes/exceptions.js'));
    await app.register(await loadPlugin('./routes/waiver-requests.js'));
    await app.register(await loadPlugin('./routes/package-check.js'));
    await app.register(await loadPlugin('./routes/scorecard.js'));
    await app.register(await loadPlugin('./routes/epss.js'));
    await app.register(await loadPlugin('./routes/namespaces.js'));
    await app.register(await loadPlugin('./routes/jobs.js'));
    await app.register(await loadPlugin('./routes/monitor.js'));
    await app.register(await loadPlugin('./routes/config.js'));
    await app.register(await loadPlugin('./routes/artifact-cache.js'));
  }

  // The same document Swagger UI reads, at stable paths. Hidden so they are not operations in the spec.
  app.get('/api/swagger.yml', { schema: { hide: true } }, async (_request, reply) => {
    return reply.type('application/yaml; charset=utf-8').send(app.swagger({ yaml: true }));
  });
  app.get('/api/swagger.json', { schema: { hide: true } }, async (_request, reply) => {
    return reply.send(app.swagger());
  });

  // Last, so its not-found handler sees every route above.
  await app.register(uiStatic);

  return app;
}
