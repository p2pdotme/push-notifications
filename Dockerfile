# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Cap the V8 heap so RSS stays small on a low-traffic service; tune per host.
ENV NODE_OPTIONS="--max-old-space-size=128 --max-semi-space-size=2"
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/src/index.js"]
