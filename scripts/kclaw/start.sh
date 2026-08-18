#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_SCRIPT="${KCLAW_OPENCLAW_SERVICE_SCRIPT:-$ROOT_DIR/scripts/docker/openclaw-service.sh}"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/docker/openclaw-docker-common.sh"
openclaw_docker_load_env
openclaw_docker_require_cmd curl

READY_URL="${KCLAW_GATEWAY_READY_URL:-http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/readyz}"
START_TIMEOUT_SECONDS="${KCLAW_START_TIMEOUT_SECONDS:-180}"

if [[ ! "$START_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "KCLAW_START_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi

"$SERVICE_SCRIPT" start

deadline=$((SECONDS + START_TIMEOUT_SECONDS))
until curl --noproxy '*' -fsS --max-time 5 "$READY_URL" >/dev/null; do
  if ((SECONDS >= deadline)); then
    echo "KClaw did not become ready within ${START_TIMEOUT_SECONDS}s: $READY_URL" >&2
    "$SERVICE_SCRIPT" status >&2 || true
    echo "Inspect logs with: $SERVICE_SCRIPT logs" >&2
    exit 1
  fi
  sleep 2
done

echo "KClaw is ready: $READY_URL"
