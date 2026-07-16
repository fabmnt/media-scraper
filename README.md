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
docker compose up --build
```

The one-shot `migrate` service applies committed database migrations before the API and worker start.

Open the gallery at <http://localhost:5173> and API documentation at <http://localhost:3000/docs>.

## Local development

Start PostgreSQL and Redis, install the extractor tools on your host, then run:

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

Downloaded files are stored under `MEDIA_ROOT`. Collection jobs retry three times with exponential backoff, and failed jobs remain visible for diagnostics and manual retry.

## Instagram authentication

Open **Instagram access** in the gallery and either paste a Cookie request header or select a Netscape-format `cookies.txt` export. The input must contain the `sessionid` cookie. The normalized credential is stored in a private Docker volume, mounted read-only by the worker, and never returned by the API or placed in queue payloads.

Treat the file as a password. Remove it from the application when it is no longer needed, and replace it after Instagram invalidates the session.

Only collect media you are authorized to access. Preserve attribution, source links, privacy, copyright, and platform terms.
