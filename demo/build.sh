#!/usr/bin/env bash
# Build the demo for deployment:
#   1. React PWA (web/) -> web/dist, copied to public/ (served by the backend)
#   2. Backend bundle   -> server.out.mjs (esbuild inlines the PushServer SDK;
#                          express stays external so the image needs no token)
#
# Installing @p2pdotme/push-client needs a read:packages token. Provide it via
# web/.npmrc and (for the server bundle) demo/.npmrc — both gitignored. The
# token is only used here at build time; it never ships to the server.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building React PWA (web/)"
( cd web && npm install && npm run build )

echo "==> Copying web/dist -> public/"
rm -rf public
cp -r web/dist public

echo "==> Bundling backend (server.out.mjs)"
npm install
npm run build:server

echo "Done: public/ (React PWA) + server.out.mjs"
