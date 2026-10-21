# Build from source

Build DepGate from its source code to create your own container image, to run it locally for development, or to evaluate unreleased changes.

## Prerequisites

- **Node.js 24** or later (the version is pinned in `.nvmrc`)
- **Docker Engine** and **Docker Compose v2**
- **Git**

```bash
git clone https://github.com/secmods/depgate.git
cd depgate
```

The repository is an npm workspace with two packages:

| Package | Contents |
|---|---|
| `packages/backend` | The gateway, the policy engine and the REST API (Node.js, Fastify, TypeScript). |
| `packages/ui` | The web interface (Angular). |

## Build the production image

The `Dockerfile` in the repository root builds the single production image: the web interface, the API and the registries.

```bash
docker build -t depgate:1.0.0 .
```

To push it to your registry:

```bash
docker tag depgate:1.0.0 registry.example.com/depgate:1.0.0
docker push registry.example.com/depgate:1.0.0
```

Then follow [Install with Docker](./docker), setting `DEPGATE_IMAGE` and `DEPGATE_VERSION` in the setup's `.env` to the image you built (`DEPGATE_IMAGE=depgate`, `DEPGATE_VERSION=1.0.0` for the example above). The deploy scripts never build: they pull the image, or use the one already loaded on the host.

Releases are built by the repository's release workflow and published as `ghcr.io/secmods/depgate:<version>`; `RELEASING.md` in the repository describes it.

## Run a development environment

### Option A: Everything in Docker

```bash
docker compose up --build
```

This builds the image from your working tree and starts it together with PostgreSQL and Redis.

| Address | Serves |
|---|---|
| http://localhost:3050 | Web interface, API and package registries |
| http://localhost:3050/api/docs | Interactive API documentation (Swagger) |

Sign in as `admin@depgate.local` with the password `admin`. To change them, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first start.

After you change code, rebuild with:

```bash
docker compose up -d --build backend
```

::: danger Development only
The root `docker-compose.yml` uses default passwords and publishes PostgreSQL and Redis on the loopback interface. Never use it for an installation; use the files in `deploy/` instead.
:::

### Option B: Backend and web interface on your machine

For fast edit-and-reload development:

```bash
# 1. Install dependencies
npm install

# 2. Start only PostgreSQL and Redis
docker compose up -d postgres redis

# 3. Create the settings file (the defaults match the containers)
cp .env.example .env

# 4. Run each in its own terminal
npm run dev:backend   # API and registries on http://localhost:3050, reloads on change
npm run dev:ui        # web interface on http://localhost:4200, forwards /api to the backend
```

The first start creates the admin account from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`.

To use a local PostgreSQL instead of the container, create the role and database first:

```bash
createuser -P depgate          # password: depgate, or match DB_PASSWORD in .env
createdb -O depgate depgate
```

## Database schema and migrations

The schema comes from numbered SQL files in `packages/backend/migrations/`, applied at startup. A change to an entity needs a new migration; [Database migrations](./database-migrations) has the steps and the rules.

## Run the tests

```bash
npm run test:unit            # backend unit tests, no infrastructure needed
npm run test --workspace=ui  # web interface unit tests
npm run test:integration     # backend integration tests (needs PostgreSQL and Redis; uses the database <DB_NAME>_test, created empty and migrated)
npm run test:e2e             # end-to-end tests with Playwright: starts DepGate and Keycloak with docker compose, then tests http://localhost:3050
npm run lint                 # lint both packages
```

The end-to-end tests start what they need (`e2e/stack.mjs`, run by Playwright's `webServer`): `docker compose --profile sso up -d --wait --build` for the backend, PostgreSQL, Redis and the Keycloak test identity provider, then a wait until both answer. A stack that already runs is used as it is, so rebuild it after a code change: `docker compose up -d --build backend`. Set `E2E_BASE_URL` to run the tests against another address, such as the Angular dev server on http://localhost:4200; then nothing is started, and the SSO suites skip unless Keycloak runs (`docker compose --profile sso up -d keycloak`).

The integration tests never use your own database: they drop and recreate the public schema of `<DB_NAME>_test` (or `TEST_DB_NAME`) and migrate it from empty. With a local PostgreSQL whose `depgate` role may not create databases, create it once: `createdb -O depgate depgate_test`.

## Build this documentation

The documentation site is built with [VitePress](https://vitepress.dev) from the `docs/` folder:

```bash
cd docs
npm install
npm run dev       # live preview on http://localhost:5173
npm run build     # static site in docs/.vitepress/dist
```

The screenshots are captured from a running DepGate with demo data. See `docs/scripts/README.md`.
