#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_SCRIPT="${KCLAW_OPENCLAW_SERVICE_SCRIPT:-$ROOT_DIR/scripts/docker/openclaw-service.sh}"

exec "$SERVICE_SCRIPT" stop
