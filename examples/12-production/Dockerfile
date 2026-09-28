# examples/12-production/Dockerfile — for examples/11-mediasoup-minimal (or the capstone)
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Prebuilt mediasoup-worker is downloaded during npm ci. If your platform has no prebuilt,
# add: RUN apt-get update && apt-get install -y python3 python3-pip build-essential
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:client && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
USER node
CMD ["node", "server.js"]
