# Multi-stage build for Cloud Run. Builder compiles TS; runner ships only
# production deps + dist.
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# Cloud Run injects PORT (default 8080); config.ts reads it. Express binds 0.0.0.0.
EXPOSE 8080
CMD ["node", "dist/server.js"]
