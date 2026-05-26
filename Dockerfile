# syntax=docker/dockerfile:1.7
# MAIster — single-image Node 24 + Python 3.12 + uv per the locked container target.
# Workspace: monorepo (pnpm) with `web/` (Next.js) and `supervisor/` (ACP daemon).
# Build stages: builder → development → production.

ARG NODE_VERSION=24-bookworm-slim
ARG PNPM_VERSION=11.3.0
ARG UV_VERSION=0.11.16
ARG PYTHON_VERSION=3.12

# ---------- Common base: Node + git + curl + Python toolchain via uv ----------
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ARG UV_VERSION
ARG PYTHON_VERSION

ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=/root/.local/bin:$PNPM_HOME:$PATH
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
ENV UV_PYTHON_PREFERENCE=only-managed

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      build-essential \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh \
 && uv python install ${PYTHON_VERSION}

WORKDIR /app

# ---------- builder: full monorepo deps + web production build ----------
FROM base AS builder
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
COPY supervisor/package.json ./supervisor/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY web/ ./web/
COPY supervisor/ ./supervisor/
RUN pnpm --filter maister-web build

# ---------- development: hot reload via pnpm dev / supervisor dev ----------
FROM base AS development
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
COPY supervisor/package.json ./supervisor/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
EXPOSE 3000 7777 9229
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "--filter", "maister-web", "dev"]

# ---------- production: minimal runtime, non-root ----------
FROM base AS production
ARG PYTHON_VERSION
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 app \
 && useradd  --system --uid 1001 --gid app --home /app --shell /usr/sbin/nologin app \
 && mkdir -p /app/.maister \
 && chown -R app:app /app

COPY --from=builder --chown=app:app /app /app

USER app
WORKDIR /app
EXPOSE 3000 7777
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "--filter", "maister-web", "start"]
