# Demo PWA server: static files + trigger proxy. Built from the repo root so the
# build context can see demo/.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY demo/package.json demo/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY demo/ ./
EXPOSE 3000
CMD ["node", "server.mjs"]
