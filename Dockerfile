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
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM dependencies AS application
COPY . .

FROM application AS migrate
CMD ["pnpm", "db:migrate"]

FROM application AS api
RUN pnpm --filter @media-scraper/api build
CMD ["pnpm", "--filter", "@media-scraper/api", "start"]

FROM application AS web
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @media-scraper/web build
CMD ["pnpm", "--filter", "@media-scraper/web", "preview", "--host", "0.0.0.0"]

# Keep heavyweight media tooling independent from dependencies and source code.
# It is rebuilt only when this stage or the Node base image changes.
FROM toolchain AS worker-tools
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,id=apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv
RUN --mount=type=cache,id=pip-cache,target=/root/.cache/pip \
  python3 -m venv /opt/media-tools \
  && /opt/media-tools/bin/pip install gallery-dl yt-dlp
ENV PATH=/opt/media-tools/bin:$PATH

FROM worker-tools AS worker
COPY --from=dependencies /app /app
COPY . .
RUN pnpm --filter @media-scraper/worker build
CMD ["pnpm", "--filter", "@media-scraper/worker", "start"]
