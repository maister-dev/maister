# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24-bookworm-slim
ARG PNPM_VERSION=11.3.0

FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION

ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
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
    pnpm install --frozen-lockfile --filter @maister/site... --filter maister-web...

FROM deps AS builder

ARG NEXT_PUBLIC_DOCS_URL=https://docs.imaister.dev
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3001

ENV NEXT_PUBLIC_DOCS_URL=${NEXT_PUBLIC_DOCS_URL}
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV NEXT_TELEMETRY_DISABLED=1

COPY site ./site
COPY web/components/auth/spine-graph.tsx ./web/components/auth/spine-graph.tsx

RUN pnpm --filter @maister/site build

FROM deps AS development

ENV NEXT_TELEMETRY_DISABLED=1

COPY site ./site
COPY web/components/auth/spine-graph.tsx ./web/components/auth/spine-graph.tsx

EXPOSE 3001

CMD ["pnpm", "--filter", "@maister/site", "dev"]

FROM node:${NODE_VERSION} AS production

ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001

RUN groupadd --system --gid 1001 site \
 && useradd --system --uid 1001 --gid site --home /app --shell /usr/sbin/nologin site

WORKDIR /app

COPY --from=builder --chown=site:site /app/site/.next/standalone ./
COPY --from=builder --chown=site:site /app/site/.next/static ./site/.next/static
COPY --from=builder --chown=site:site /app/site/public ./site/public

USER site

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/en').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "site/server.js"]
