# ==============================================================
# 0. Base image with shared dependencies
# ==============================================================

FROM node:20-alpine AS base

# Install bash, curl, Infisical CLI for Alpine
RUN apk add --no-cache libc6-compat bash curl && \
    curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.alpine.sh' | bash && \
    apk add --no-cache infisical

# Chromium for Puppeteer (PDF export). Puppeteer's own Chrome builds are
# glibc-only, so on Alpine we use the system chromium and skip the download.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont && \
    ln -sf "$(command -v chromium-browser || command -v chromium)" /usr/bin/chrome

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chrome

WORKDIR /app

# ==============================================================
# 1. Dependency installation
# ==============================================================

FROM base AS deps

WORKDIR /app

COPY package.json ./

RUN npm install

# ==============================================================
# 2. Build source with env vars from Infisical
# ==============================================================

FROM base AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY . .

RUN npm run tsc

# Clean up build artifacts
RUN rm -rf .env tsconfig.tsbuildinfo

# ==============================================================
# 3. Final production image
# ==============================================================

FROM base AS runner

WORKDIR /app

COPY --from=builder /app .

# Set environment
ENV PORT=4000

ENV HOSTNAME=0.0.0.0

EXPOSE 4000
