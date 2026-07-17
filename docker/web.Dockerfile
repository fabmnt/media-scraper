# Railway web service Dockerfile. The build context must be the repository root
# because the web app imports the shared workspace package.

FROM node:24-bookworm-slim AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack install --global pnpm@11.5.1
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/extractors/package.json packages/extractors/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=s/6c4c77ca-5611-4b2c-8dd7-c6e6a0d9ceea-/pnpm/store,target=/pnpm/store \
  pnpm install --frozen-lockfile

COPY . .
ARG API_PROXY_URL
ENV API_PROXY_URL=$API_PROXY_URL
RUN pnpm --filter @media-scraper/web build

CMD ["bash", "-c", "pnpm --filter @media-scraper/web preview --host 0.0.0.0 --port ${PORT:-4173}"]
