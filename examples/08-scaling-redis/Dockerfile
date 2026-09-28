# Chapter 8 — image for the scaled chat server.
# Build context is the REPO ROOT (see docker-compose.yml) so we can reuse the
# root package.json / lockfile.
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY examples/08-scaling-redis ./examples/08-scaling-redis
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# Run node directly (not via npm) so SIGTERM reaches our graceful-shutdown handler.
CMD ["node", "examples/08-scaling-redis/server.js"]
