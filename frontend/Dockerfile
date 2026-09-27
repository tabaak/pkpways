# syntax=docker/dockerfile:1
#
# Next.js map UI, built as the compose "frontend" service.
#
# Three stages so the runtime image carries no source, no build tooling and no
# dev dependencies. Requires output: "standalone" in next.config.ts.

# --- deps: install once; cached until package-lock.json changes --------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: compile the app ------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_CARTO_API_KEY
ENV NEXT_PUBLIC_CARTO_API_KEY=$NEXT_PUBLIC_CARTO_API_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runner: standalone output only ------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
# HOSTNAME=0.0.0.0 binds all interfaces; the default (localhost) would be
# unreachable from the Caddy container.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# standalone does NOT bundle public/ or .next/static; both must be copied in.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
