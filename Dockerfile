# Server image for the MicroPhoenix kernel. No web client stage.
# Base images are pinned by digest for reproducible builds.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS server-builder
RUN printf 'Acquire::Retries "5";\n' > /etc/apt/apt.conf.d/80-retries
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json tsconfig.build.json ./
COPY scripts scripts
# Native modules (better-sqlite3, sqlite-vec) need a compiler during install.
RUN apt-get update && apt-get install -y python3 make g++ gcc && rm -rf /var/lib/apt/lists/*
# prepare skips the build here: src/ is copied after install to keep the layer cache.
RUN npm ci
COPY src src
COPY types types
RUN node ./node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.json
RUN node ./node_modules/@typescript/native/bin/tsc --build tsconfig.build.json --pretty false --noCheck
RUN node scripts/copy-migrations.cjs && node scripts/rewrite-dist-aliases.cjs
RUN npm prune --omit=dev
RUN mkdir -p logs temp uploads

FROM gcr.io/distroless/nodejs24-debian12@sha256:61f4f4341db81820c24ce771b83d202eb6452076f58628cd536cc7d94a10978b AS production
WORKDIR /app
ARG APP_VERSION=2.13.0
LABEL org.opencontainers.image.title="MicroPhoenix" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.description="Event sourcing and clean architecture kernel" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
COPY --from=server-builder /app/node_modules ./node_modules
COPY --from=server-builder /app/dist ./dist
COPY 05-PLUGIN_SYSTEM/manifest-v2.schema.json ./05-PLUGIN_SYSTEM/manifest-v2.schema.json
COPY --from=server-builder --chown=65532:65532 /app/logs ./logs
COPY --from=server-builder --chown=65532:65532 /app/temp ./temp
COPY --from=server-builder --chown=65532:65532 /app/uploads ./uploads
COPY --from=server-builder /app/package.json ./
# Distroless nonroot user. Keep in sync with any Kubernetes securityContext.
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const h=require('http');h.get('http://127.0.0.1:3000/health/ready',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]
CMD ["dist/index.js"]
