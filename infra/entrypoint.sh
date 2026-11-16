#!/bin/sh
set -e
class="${DULJA_ENTRYPOINT:-api}"
case "$class" in
  api) exec bun run apps/api/src/index.ts ;;
  worker) exec bun run apps/worker/src/index.ts ;;
  *) echo "unknown DULJA_ENTRYPOINT '$class' — expected api or worker" >&2; exit 2 ;;
esac
