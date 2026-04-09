# syntax=docker/dockerfile:1
# Multi-stage build for the runner-autoscaler service.

FROM node:24-alpine AS builder
WORKDIR /app

# Enable corepack so we get the exact pnpm version pinned in package.json
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
COPY tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm build

# Prune dev deps for the runtime image
RUN pnpm prune --prod


FROM node:24-alpine AS runtime
WORKDIR /app

# Run as non-root for defense-in-depth.
# We don't need root inside the container — dockerode talks to /var/run/docker.sock
# which is mounted from the host, and the host group ownership is what matters.
RUN addgroup -S app && adduser -S app -G app
USER app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json

ENV NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
