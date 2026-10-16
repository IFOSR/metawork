# Production image for the MetaWork official service (accounts, entitlement, payment settlement).
# Build from this directory: docker build -t <registry>/metawork-official-server:<tag> .
# All configuration is injected as environment variables (see deploy/k8s/); no .env is baked in.
FROM node:22.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js business.js hub-payments.js prompts.js admin.js ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=8780 HOST=0.0.0.0 DATABASE_PATH=/app/data/official.sqlite
EXPOSE 8780
CMD ["node", "server.js"]
