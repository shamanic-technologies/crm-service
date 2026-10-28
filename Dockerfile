# Stage 1: Builder
FROM node:22.23.4-slim AS builder

WORKDIR /app

# Install pnpm — PINNED to the major that matches pnpm-lock.yaml's
# lockfileVersion 9.0. Unpinned, the deploy host installs pnpm 10, which fails
# the install outright on ignored dependency build scripts (ERR_PNPM_IGNORED_BUILDS)
# and leaves the container frozen on its previous image with no error surfaced.
RUN npm install -g pnpm@9

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source files
COPY . .

# Build
RUN pnpm build

# Stage 2: Production
FROM node:22.23.4-slim

WORKDIR /app

# Install pnpm — PINNED to the major that matches pnpm-lock.yaml's
# lockfileVersion 9.0. Unpinned, the deploy host installs pnpm 10, which fails
# the install outright on ignored dependency build scripts (ERR_PNPM_IGNORED_BUILDS)
# and leaves the container frozen on its previous image with no error surfaced.
RUN npm install -g pnpm@9

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# Copy built files, migrations, and OpenAPI spec
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/openapi.json ./openapi.json

# Force IPv4 first to avoid IPv6 connection issues with Neon
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

# BOX-LOAD-1028-CRM-MEM: cap the V8 old space. The live heap peaks ~0.7 GB (a fact emission of the largest
# brand); left to its default (~4 GB on the 15.6 GB box) V8 collected lazily and the process sat at 2-2.7 GB
# RSS on the shared box, swapping. Raise the cap only with a measured live peak (HeapProfiler.collectGarbage).
CMD ["node", "--max-old-space-size=1280", "--import", "./dist/instrument.js", "dist/index.js"]
