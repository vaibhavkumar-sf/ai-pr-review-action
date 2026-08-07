# AWS's mirror of the Docker official images, NOT Docker Hub. Consumers run this
# container action on self-hosted CodeBuild runners that share a NAT egress IP,
# and `docker build` runs on every PR event (no prebuilt image, no layer cache on
# ephemeral runners) — anonymous Docker Hub pulls are rate-limited per IP, so the
# whole org's reviews failed with `toomanyrequests`. ECR Public has no anonymous
# pull limit and is in-region for those runners.
FROM public.ecr.aws/docker/library/node:20-alpine AS builder

LABEL maintainer="SourceFuse"
LABEL description="AI PR Review Action - Comprehensive code review with parallel specialist agents"

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json tsconfig.json ./

# Install ALL dependencies (including devDeps for tsc)
RUN npm ci

# Copy source code (+ schema/action.yml pair so prebuild's check:action can verify sync)
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY action.yml ./

# Build TypeScript
RUN npm run build

# --- Production stage ---
# Same registry as the builder stage — see the note above.
FROM public.ecr.aws/docker/library/node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built output from builder
COPY --from=builder /app/dist ./dist
COPY prompts/ ./prompts/

ENTRYPOINT ["node", "/app/dist/index.js"]
