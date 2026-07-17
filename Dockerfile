# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack install --global pnpm@11.5.1
WORKDIR /app

FROM toolchain AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/extractors/package.json packages/extractors/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=s/7fda2391-ee57-4840-9b72-b7dba3d4937f-/pnpm/store,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM dependencies AS application
COPY . .

FROM application AS migrate
CMD ["pnpm", "db:migrate"]

FROM application AS api
RUN pnpm --filter @media-scraper/api build
CMD ["pnpm", "--filter", "@media-scraper/api", "start"]

FROM application AS web
ARG API_PROXY_URL=http://localhost:3000
ENV API_PROXY_URL=$API_PROXY_URL
RUN pnpm --filter @media-scraper/web build
CMD ["pnpm", "--filter", "@media-scraper/web", "preview", "--host", "0.0.0.0"]

# Keep heavyweight media tooling independent from dependencies and source code.
# It is rebuilt only when this stage or the Node base image changes.
FROM toolchain AS worker-tools
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,id=s/7fda2391-ee57-4840-9b72-b7dba3d4937f-/var/cache/apt,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=s/7fda2391-ee57-4840-9b72-b7dba3d4937f-/var/lib/apt/lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv
RUN --mount=type=cache,id=s/7fda2391-ee57-4840-9b72-b7dba3d4937f-/root/.cache/pip,target=/root/.cache/pip \
  python3 -m venv /opt/media-tools \
  && /opt/media-tools/bin/pip install gallery-dl yt-dlp
ENV PATH=/opt/media-tools/bin:$PATH

FROM worker-tools AS worker
COPY --from=dependencies /app /app
COPY . .
RUN pnpm --filter @media-scraper/worker build
CMD ["pnpm", "--filter", "@media-scraper/worker", "start"]

# Railway attaches a volume to one service, so the production backend runs the
# API and worker together and both processes use the same /data volume.
FROM worker-tools AS app
COPY --from=dependencies /app /app
COPY . .
RUN pnpm --filter @media-scraper/api build \
  && pnpm --filter @media-scraper/worker build
CMD ["bash", "-c", "pnpm --filter @media-scraper/api start & api_pid=$!; pnpm --filter @media-scraper/worker start & worker_pid=$!; trap 'kill $api_pid $worker_pid 2>/dev/null' TERM INT; wait -n $api_pid $worker_pid; status=$?; kill $api_pid $worker_pid 2>/dev/null; wait 2>/dev/null; exit $status"]
