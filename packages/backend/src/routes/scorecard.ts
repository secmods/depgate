import { FastifyPluginAsync } from 'fastify';
import { ROLE_SECURITY, ROLE_USER } from '../auth/roles.js';
import { ECOSYSTEMS, isEcosystem } from '../services/repo-keys.js';
import { isVersionInput, STORED_VERSION_MAX_LENGTH } from '../services/version-range.js';
import { normalizePackageName, packageNameError } from '../services/package-versions.js';
import { resolvePackageTargets } from '../services/namespace-protection.js';
import { lookupScorecards, scorecardView } from '../services/scorecard.js';

const REPOSITORY_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

type LookupQuery = { ecosystem?: string; package?: string; version?: string; repository?: string };

/** One package version's OpenSSF Scorecard as the rule sees it (requirements_scorecard.md §8). */
const scorecardRoutes: FastifyPluginAsync = async (fastify) => {
  const requireRead = fastify.authenticate({ roles: [ROLE_USER, ROLE_SECURITY] });

  fastify.get<{ Querystring: LookupQuery }>(
    '/api/admin/scorecard',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Policies'],
        summary: "A package version's OpenSSF Scorecard, from the cache or one live lookup",
        querystring: {
          type: 'object',
          required: ['ecosystem', 'package', 'version'],
          properties: {
            ecosystem: { type: 'string' },
            package: { type: 'string' },
            version: { type: 'string' },
            repository: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const ecosystem = String(request.query.ecosystem ?? '').trim();
      if (!isEcosystem(ecosystem)) return reply.status(400).send({ error: `ecosystem must be one of ${ECOSYSTEMS.join(', ')}` });
      const nameError = packageNameError(ecosystem, String(request.query.package ?? ''));
      if (nameError) return reply.status(400).send({ error: nameError });
      const version = String(request.query.version ?? '').trim();
      if (!version || version.length > STORED_VERSION_MAX_LENGTH || !isVersionInput(version, [ecosystem])) {
        return reply.status(400).send({ error: `"${version}" is not a version` });
      }
      const repository = String(request.query.repository ?? 'default').trim() || 'default';
      if (!REPOSITORY_KEY.test(repository)) return reply.status(400).send({ error: `Repository "${repository}" is not a valid repository key` });

      const pkg = normalizePackageName(ecosystem, String(request.query.package));
      const route = await resolvePackageTargets(fastify.db, ecosystem, repository, pkg);
      if (route.targets.length + route.skipped.length === 0) {
        return reply.status(400).send({ error: `Repository "${repository}" does not exist or is not enabled for ${ecosystem}` });
      }
      const lookups = await lookupScorecards(fastify.db, fastify.redis, route, pkg, [version]);
      const lookup = lookups.get(version) ?? { status: 'unavailable' as const };
      return reply.send({ ecosystem, package: pkg, version, repository, ...scorecardView(lookup) });
    }
  );
};

export default scorecardRoutes;
