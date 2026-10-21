import { FastifyPluginAsync } from 'fastify';
// Imported, not read from disk, so the build ships it inside dist/ with the code.
import osiLicenses from '../data/osi-licenses.json';

interface OsiLicense {
  name: string;
  spdxId: string;
  category: string;
}

const licenses: readonly OsiLicense[] = osiLicenses;

const licensesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { q?: string } }>(
    '/api/licenses',
    {
      schema: {
        tags: ['Licenses'],
        security: [],
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search by name or SPDX ID' },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                spdxId: { type: 'string' },
                category: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const list = licenses;
      const q = (request.query?.q ?? '').trim().toLowerCase();
      if (!q) return reply.send(list);
      const filtered = list.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          l.spdxId.toLowerCase().includes(q)
      );
      return reply.send(filtered);
    }
  );
};

export default licensesRoutes;
