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
