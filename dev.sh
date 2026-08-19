#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PATH="$PWD/node_modules/.bin:$PATH"

exec concurrently -k 'vite --host 127.0.0.1' 'wait-on tcp:5173 && cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:5173 electron .'
