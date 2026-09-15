#!/usr/bin/env bash
# IF Imgen - usage: bash scripts/push.sh "commit message". Logic lives in push.mjs (any characters allowed).
exec node "$(dirname "$0")/push.mjs" "$@"
