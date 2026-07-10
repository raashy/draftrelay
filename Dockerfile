# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS prod-deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S -g 1001 draftrelay \
  && adduser -S -D -u 1001 -G draftrelay -h /app draftrelay \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=prod-deps --chown=draftrelay:draftrelay /app/node_modules ./node_modules
COPY --from=build --chown=draftrelay:draftrelay /app/dist ./dist
COPY --from=build --chown=draftrelay:draftrelay /app/migrations ./migrations
COPY --from=build --chown=draftrelay:draftrelay /app/package.json ./package.json
USER draftrelay
EXPOSE 3941
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3941/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/cloud/index.js"]
