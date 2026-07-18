# Media Scraper

A personal media archive for public Instagram, Facebook, and TikTok posts and galleries. Users can paste an individual post URL or find recent media by platform and username, preview it, and queue only selected items. The application uses deterministic command-line extractors (`yt-dlp`, then `gallery-dl`) and does not include browser automation.

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
API_ACCESS_TOKEN=<your access password>
API_HOST=0.0.0.0
COOKIE_SECURE=true
PROFILE_DISCOVERY_TIMEOUT_MS=45000
# Use http://localhost:5173 until the web service has a generated domain.
WEB_ORIGIN=http://localhost:5173
MEDIA_ROOT=/data/media
CREDENTIALS_ROOT=/data/credentials
# Optional: override resource-aware collection concurrency (1-8).
# COLLECTION_CONCURRENCY=4
MAX_ASSET_BYTES=104857600
MAX_COLLECTION_BYTES=524288000
MAX_MEDIA_STORAGE_BYTES=4294967296
MEDIA_RETENTION_TRIGGER_PERCENT=80
MEDIA_RETENTION_TARGET_PERCENT=70
VIDEO_MAX_DIMENSION=1280
IMAGE_MAX_DIMENSION=1920
```

Set the backend service's pre-deploy command to `pnpm db:migrate`, healthcheck path to `/health`, attach a Railway volume mounted at `/data`, and generate its public domain. Do not scale this volume-backed service horizontally.

On the `web` service, set `API_PROXY_URL=https://${{backend.RAILWAY_PUBLIC_DOMAIN}}`, set `RAILWAY_DOCKERFILE_PATH=/docker/web.Dockerfile`, and generate a public domain. The web service uses that backend URL as its server-side proxy target while browser requests stay on the web origin, allowing session cookies to remain first-party. Finally, change the backend's `WEB_ORIGIN` to `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` and redeploy it. Railway provides `PORT` automatically; the API and web preview are configured to listen on it.

Railway's private networking supplies the database and Redis connections through the reference variables. Keep the `/data` volume attached for extraction workspace and platform credentials; with local storage, it also holds all downloaded media.

You can connect the GitHub repository to both application services so pushes to the selected branch redeploy them automatically. Set watch paths if desired; changes under `packages/**` should trigger both services.

## Start with Docker

```bash
cp .env.example .env
# Set API_ACCESS_TOKEN in .env to any non-empty password.
docker compose up --build
```

The one-shot `migrate` service applies committed database migrations before the API and worker start.

Open the gallery at <http://localhost:5173>, sign in with `API_ACCESS_TOKEN`, and view API documentation at <http://localhost:3000/docs>. The API stores the token in an HTTP-only session cookie. Set `COOKIE_SECURE=true` when serving it over HTTPS. The web service proxies `/api` requests so the cookie remains first-party even though the API runs as a separate service.

## Local development

Start PostgreSQL and Redis, install the extractor tools on your host, then run:

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

Downloaded files are stored under `MEDIA_ROOT`. Relative storage paths are resolved from the workspace root so the API and worker always share the same files. Collection jobs retry three times with exponential backoff, and failed jobs remain visible for diagnostics and manual retry.

Profile discovery uses `gallery-dl` in metadata-only mode and returns at most 24 items per request. Instagram discovery includes posts and reels, TikTok includes posts, and Facebook includes profile photos. Discovery metadata is fetched in bounded 24-item snapshots and cached in Redis for 10 minutes by default. When more media is available, an opaque continuation cursor loads and caches another snapshot without imposing a total browsing limit. Cold profile extraction is limited to one active and one queued lookup, runs at most one `gallery-dl` process at a time, and has a 45-second total deadline by default so it cannot starve normal API traffic. `PROFILE_DISCOVERY_CACHE_TTL_SECONDS` controls the cache lifetime, and `PROFILE_DISCOVERY_TIMEOUT_MS` controls the deadline up to a maximum of 90 seconds. Up to 100 selected items are accepted in one batch API request and their canonical post URLs are queued through the same collection pipeline and limits as manually pasted links.

Extraction defaults to a 100 MiB asset limit and a 500 MiB collection limit. Videos are downloaded at up to 720p when that source is available, then normalized to H.264/AAC with a maximum 1280px dimension and 30 FPS. Still images are converted to WebP with a maximum 1920px dimension; animated GIF, WebP, APNG, and other multi-frame images are preserved unchanged. An optimized file replaces its source only when it is smaller or the source exceeds the configured dimensions. `OPTIMIZATION_TIMEOUT_MS` bounds each FFmpeg operation.

`MAX_MEDIA_STORAGE_BYTES` defaults to 4 GiB. After a collection completes, oldest media is removed when database-tracked usage exceeds `MEDIA_RETENTION_TRIGGER_PERCENT` (80% by default) until it reaches `MEDIA_RETENTION_TARGET_PERCENT` (70%). Retention is serialized independently from collection processing, so collections can run concurrently without overlapping quota decisions.

Collection concurrency is automatically sized when the worker starts. It budgets two CPU threads and 1.5 GiB per collection, reserves 1.5 GiB for the co-located API and worker overhead, and caps automatic concurrency at four. The worker logs rounded detected limits and the selected concurrency at startup. On the current Railway runtime it selects three concurrent collections and reports 8 CPUs and 7.5 GiB, with memory rounded to one decimal place. Set `COLLECTION_CONCURRENCY` to a value from 1 through 8 only when an explicit override is needed. Metadata probing within each collection remains bounded by `METADATA_CONCURRENCY`.

## S3-compatible media storage

Local volume storage remains the default. For a larger archive, the API and worker can store final media in a private S3-compatible bucket while continuing to use `MEDIA_ROOT` as temporary extraction space and `CREDENTIALS_ROOT` for platform credentials.

For a Railway Bucket, add its credentials to the `backend` service with Railway variable references:

```text
MEDIA_STORAGE_DRIVER=s3
S3_BUCKET=${{media-bucket.BUCKET}}
S3_ENDPOINT=${{media-bucket.ENDPOINT}}
S3_REGION=${{media-bucket.REGION}}
S3_ACCESS_KEY_ID=${{media-bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{media-bucket.SECRET_ACCESS_KEY}}
S3_FORCE_PATH_STYLE=false
S3_PRESIGNED_URL_TTL_SECONDS=900
```

Replace `media-bucket` with the bucket service name. Object keys include the content hash for traceability and a unique ownership suffix so cleanup can never remove another asset's media. The API keeps media private and redirects authenticated content requests to short-lived presigned URLs. Local assets created before S3 was enabled continue to work from the attached volume.

After deploying and applying migrations, move existing local assets into the configured bucket with:

```bash
railway ssh --service backend pnpm --filter @media-scraper/worker storage:migrate
```

The migration uploads each object before atomically updating its database location and queuing the local copy for durable cleanup. Failed file/object cleanup and quota enforcement are retried by the worker's database-backed maintenance loop. Keep the volume attached afterward because extraction and credentials still use it. Railway Buckets do not currently provide lifecycle rules, so application retention remains enabled.

## Platform authentication

Open the relevant platform access panel in the gallery and either paste a Cookie request header or select a Netscape-format `cookies.txt` export. The input must contain the platform's authentication cookies:

- Instagram: `sessionid`
- Facebook: `c_user` and `xs`
- TikTok: `sid_tt`

Each normalized credential is stored separately in a private Docker volume, mounted read-only by the worker, and never returned by the API or placed in queue payloads. A configured status only confirms that a credential is stored; platforms can invalidate sessions at any time.

Treat cookie files as passwords. Remove them from the application when they are no longer needed, and replace them after logging out, changing a password, or when the platform invalidates the session.

Only collect media you are authorized to access. Preserve attribution, source links, privacy, copyright, and platform terms.
