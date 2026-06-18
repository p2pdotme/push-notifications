#!/usr/bin/env bash
# Build the demo for deployment:
#   1. React PWA (frontend/) -> frontend/dist, copied to server/public/ (served
#      by the backend)
#   2. Backend bundle -> server/server.out.mjs (esbuild inlines the PushServer
#      SDK; express stays external so the runtime image needs no token)
#
# Installing @p2pdotme/push-client needs a read:packages token. Provide it via
# frontend/.npmrc and server/.npmrc — both gitignored. The token is only used
# here at build time; it never ships to the server.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building React PWA (frontend/)"
( cd frontend && npm install && npm run build )

echo "==> Copying frontend/dist -> server/public/"
rm -rf server/public
cp -r frontend/dist server/public

echo "==> Bundling backend (server/server.out.mjs)"
( cd server && npm install && npm run build:server )

echo "Done: server/public (React PWA) + server/server.out.mjs"
