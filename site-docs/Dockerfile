# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24-bookworm-slim
ARG NGINX_VERSION=1.30.4-alpine-slim
ARG PNPM_VERSION=11.3.0

FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION

ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY mcp/package.json ./mcp/package.json
COPY site/package.json ./site/package.json
COPY site-docs/package.json ./site-docs/package.json
COPY supervisor/package.json ./supervisor/package.json
COPY web/package.json ./web/package.json

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @maister/site-docs...

FROM deps AS builder

ARG DOCS_BASE_URL=https://docs.imaister.dev

COPY site-docs ./site-docs

RUN pnpm --filter @maister/site-docs validate \
 && pnpm --filter @maister/site-docs links \
 && pnpm --filter @maister/site-docs exec mint export --output /tmp/docs.zip \
 && mkdir -p /app/export \
 && unzip -q /tmp/docs.zip -d /app/export \
 && node site-docs/scripts/prepare-static-export.mjs /app/export \
 && node site-docs/scripts/build-agent-docs.mjs /app/export ${DOCS_BASE_URL} \
 && pnpm --filter @maister/site-docs exec pagefind --site /app/export --root-selector "#content"

FROM deps AS development

COPY site-docs ./site-docs

EXPOSE 3002

CMD ["pnpm", "--filter", "@maister/site-docs", "dev"]

FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS production

COPY site-docs/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder --chown=101:101 /app/export /usr/share/nginx/html

USER 101:101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "--spider", "-q", "http://127.0.0.1:8080/healthz"]

CMD ["nginx", "-g", "daemon off;"]
