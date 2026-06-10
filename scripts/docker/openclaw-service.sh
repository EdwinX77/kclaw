#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/docker/openclaw-docker-common.sh"

openclaw_docker_load_env

usage() {
  cat <<'EOF'
Usage: scripts/docker/openclaw-service.sh <command> [args]

Commands:
  start         Start the OpenClaw gateway container
  stop          Stop the OpenClaw gateway container
  restart       Restart the OpenClaw gateway container
  down          Stop and remove the compose stack
  status        Show compose service status
  logs          Follow gateway logs
  shell         Open a shell inside the gateway container
  cli [args...] Run an OpenClaw CLI command in the CLI container
  check         Run deployment self-checks
EOF
}

main() {
  local command="${1:-}"
  case "$command" in
    start)
      openclaw_docker_compose up -d openclaw-gateway
      ;;
    stop)
      openclaw_docker_compose stop openclaw-gateway
      ;;
    restart)
      openclaw_docker_compose up -d --force-recreate openclaw-gateway
      ;;
    down)
      openclaw_docker_compose down
      ;;
    status)
      openclaw_docker_compose ps
      ;;
    logs)
      openclaw_docker_compose logs -f openclaw-gateway
      ;;
    shell)
      openclaw_docker_compose exec openclaw-gateway bash
      ;;
    cli)
      shift || true
      openclaw_docker_compose run --rm openclaw-cli "$@"
      ;;
    check)
      shift || true
      exec "$ROOT_DIR/scripts/docker/openclaw-selfcheck.sh" "$@"
      ;;
    "" | -h | --help | help)
      usage
      ;;
    *)
      echo "Unknown command: $command" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
