FROM node:20-alpine AS builder

LABEL maintainer="SourceFuse"
LABEL description="AI PR Review Action - Comprehensive code review with parallel specialist agents"

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json tsconfig.json ./

# Install ALL dependencies (including devDeps for tsc)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# --- Production stage ---
FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built output from builder
COPY --from=builder /app/dist ./dist
COPY prompts/ ./prompts/

ENTRYPOINT ["node", "/app/dist/index.js"]
