# syntax=docker/dockerfile:1.7
# MAIster — single-image Node 24 + Python 3.12 + uv per the locked container target.
# Build stages: deps → builder → development → production.

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

# ---------- deps: production-only node_modules ----------
FROM base AS deps
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    cd web && pnpm install --frozen-lockfile --prod

# ---------- builder: full deps + production build ----------
FROM base AS builder
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    cd web && pnpm install --frozen-lockfile
COPY web/ ./web/
RUN cd web && pnpm build

# ---------- development: hot reload via pnpm dev ----------
FROM base AS development
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    cd web && pnpm install --frozen-lockfile
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/web
EXPOSE 3000 9229
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "dev"]

# ---------- production: minimal runtime, non-root ----------
FROM base AS production
ARG PYTHON_VERSION
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 app \
 && useradd  --system --uid 1001 --gid app --home /app --shell /usr/sbin/nologin app \
 && mkdir -p /app/web /app/.maister \
 && chown -R app:app /app

COPY --from=deps    --chown=app:app /app/web/node_modules ./web/node_modules
COPY --from=builder --chown=app:app /app/web/.next        ./web/.next
COPY --from=builder --chown=app:app /app/web/public       ./web/public
COPY --from=builder --chown=app:app /app/web/package.json /app/web/pnpm-lock.yaml /app/web/next.config.mjs ./web/

USER app
WORKDIR /app/web
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
