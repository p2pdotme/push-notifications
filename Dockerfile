# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
# better-sqlite3 ships prebuilt binaries, but keep build tools available as a
# fallback for platforms without a prebuild.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Persisted SQLite data lives here; mount a volume in production.
VOLUME ["/app/data"]
EXPOSE 4000
CMD ["node", "dist/src/index.js"]
