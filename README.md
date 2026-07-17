# Media Scraper

A personal media archive for public Instagram, Facebook, and TikTok posts and galleries. The application uses deterministic command-line extractors (`yt-dlp`, then `gallery-dl`) and does not include browser automation.

## Workspace

- `apps/web` — React and Vite gallery
- `apps/api` — Fastify REST API and OpenAPI documentation
- `apps/worker` — BullMQ download and media-processing worker
- `packages/shared` — normalized schemas, types, and constants
- `packages/database` — PostgreSQL schema and Drizzle client
- `packages/extractors` — isolated extractor adapters
- `packages/config` — validated environment configuration

## Requirements

- Node.js 24+
- pnpm 11+
- PostgreSQL and Redis
- `yt-dlp`, `gallery-dl`, and `ffmpeg` for a locally-run worker

The Docker setup provisions all runtime dependencies automatically.

## Deploy to Railway

Railway should be configured as four services in one project:

- `backend` — deploys the repository root with the default `Dockerfile`. The final image runs both the API and worker, which lets them share one persistent volume.
- `web` — deploys the repository root with `RAILWAY_DOCKERFILE_PATH=/docker/web.Dockerfile`.
- `Postgres` — add Railway's managed PostgreSQL service.
- `Redis` — add Railway's managed Redis service.

Create the database services first, then configure the backend variables. Use Railway reference variables for the service names if you choose different names:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
API_ACCESS_TOKEN=<a random value of at least 32 characters>
API_HOST=0.0.0.0
COOKIE_SECURE=true
# Use http://localhost:5173 until the web service has a generated domain.
WEB_ORIGIN=http://localhost:5173
MEDIA_ROOT=/data/media
CREDENTIALS_ROOT=/data/credentials
```

Set the backend service's pre-deploy command to `pnpm db:migrate`, healthcheck path to `/health`, attach a Railway volume mounted at `/data`, and generate its public domain. Do not scale this volume-backed service horizontally.

On the `web` service, set `VITE_API_URL=https://${{backend.RAILWAY_PUBLIC_DOMAIN}}`, set `RAILWAY_DOCKERFILE_PATH=/docker/web.Dockerfile`, and generate a public domain. Because Vite embeds this URL at build time, the backend domain must exist before the web service is built. Finally, change the backend's `WEB_ORIGIN` to `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` and redeploy it. Railway provides `PORT` automatically; the API and web preview are configured to listen on it.

Railway's private networking supplies the database and Redis connections through the reference variables. The `/data` volume is required: without it, downloaded media and stored platform credentials are lost when the backend redeploys.

You can connect the GitHub repository to both application services so pushes to the selected branch redeploy them automatically. Set watch paths if desired; changes under `packages/**` should trigger both services.

## Start with Docker

```bash
cp .env.example .env
# Set API_ACCESS_TOKEN in .env, for example with: openssl rand -hex 32
docker compose up --build
```

The one-shot `migrate` service applies committed database migrations before the API and worker start.

Open the gallery at <http://localhost:5173>, sign in with `API_ACCESS_TOKEN`, and view API documentation at <http://localhost:3000/docs>. The API stores the token in an HTTP-only, same-site session cookie; set `COOKIE_SECURE=true` when serving it over HTTPS.

## Local development

Start PostgreSQL and Redis, install the extractor tools on your host, then run:

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

Downloaded files are stored under `MEDIA_ROOT`. Relative storage paths are resolved from the workspace root so the API and worker always share the same files. Collection jobs retry three times with exponential backoff, and failed jobs remain visible for diagnostics and manual retry.

Extraction is bounded by `MAX_ASSET_BYTES`, `MAX_COLLECTION_BYTES`, and `EXTRACTION_TIMEOUT_MS`. Metadata probing uses `METADATA_CONCURRENCY` to avoid launching an unbounded number of processes.

## Platform authentication

Open the relevant platform access panel in the gallery and either paste a Cookie request header or select a Netscape-format `cookies.txt` export. The input must contain the platform's authentication cookies:

- Instagram: `sessionid`
- Facebook: `c_user` and `xs`
- TikTok: `sid_tt`

Each normalized credential is stored separately in a private Docker volume, mounted read-only by the worker, and never returned by the API or placed in queue payloads. A configured status only confirms that a credential is stored; platforms can invalidate sessions at any time.

Treat cookie files as passwords. Remove them from the application when they are no longer needed, and replace them after logging out, changing a password, or when the platform invalidates the session.

Only collect media you are authorized to access. Preserve attribution, source links, privacy, copyright, and platform terms.
