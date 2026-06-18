# Demo PWA server. Runs the esbuild-bundled server (server.out.mjs, with the
# @p2pdotme/push-client SDK inlined) and serves the bundled PWA from public/.
# Only express is needed at runtime — the private SDK is already bundled in, so
# no GitHub Packages token is required in this image.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
RUN npm install express@4.21.2 && npm cache clean --force
COPY demo/server.out.mjs ./server.out.mjs
COPY demo/public ./public
EXPOSE 3000
CMD ["node", "server.out.mjs"]
