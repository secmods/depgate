# Contributing to DepGate

Thank you for your interest in contributing to DepGate.

## Development setup

See [Build from source](docs/install/build-from-source.md) for prerequisites, the development environment and the test commands. In short:

```bash
git clone https://github.com/secmods/depgate.git
cd depgate
npm install
docker compose up -d postgres redis
cp .env.example .env
npm run dev:backend   # terminal 1: API and registries on http://localhost:3050
npm run dev:ui        # terminal 2: web interface on http://localhost:4200
```

## Database schema

Schema changes are SQL migrations in `packages/backend/migrations/`, never TypeORM sync. See [Database migrations](docs/install/database-migrations.md) for the workflow (`npm run migration:new`, `npm run migration:draft`) and the rules.

## Tests and lint

```bash
npm run test:unit          # backend unit tests
npm run test:integration   # backend integration tests (PostgreSQL and Redis)
npm run test:e2e           # Playwright end-to-end tests (starts the docker compose stack, with Keycloak)
npm run lint
```

Load tests need [k6](https://k6.io) and a running gateway: `npm run test:load`.

## Documentation

User documentation lives in `docs/` and is built with VitePress (`cd docs && npm install && npm run dev`). Screenshots are captured from a seeded instance; see `docs/scripts/README.md`.

## Pull requests

1. Create a feature branch.
2. Add or update tests, and update the documentation when behavior changes.
3. Make sure tests pass and lint is clean.
4. Open a pull request with a clear description.

## Reporting issues

Use [GitHub Issues](https://github.com/secmods/depgate/issues) for bugs and feature requests. Report security vulnerabilities privately, as described in the [Security Policy](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT License.
