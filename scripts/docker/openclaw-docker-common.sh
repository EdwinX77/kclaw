#!/usr/bin/env bash

if [[ -n "${OPENCLAW_DOCKER_COMMON_SH_LOADED:-}" ]]; then
  return 0
fi
OPENCLAW_DOCKER_COMMON_SH_LOADED=1

OPENCLAW_DOCKER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

openclaw_docker_repo_root() {
  printf "%s\n" "$OPENCLAW_DOCKER_ROOT"
}

openclaw_docker_load_env() {
  local root
  root="$(openclaw_docker_repo_root)"
  local env_file="$root/.env"

  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi

  export OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
  export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$OPENCLAW_CONFIG_DIR/workspace}"
  export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
  export OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}}"
  export CLAUDE_AI_SESSION_KEY="${CLAUDE_AI_SESSION_KEY:-}"
  export CLAUDE_WEB_SESSION_KEY="${CLAUDE_WEB_SESSION_KEY:-}"
  export CLAUDE_WEB_COOKIE="${CLAUDE_WEB_COOKIE:-}"
}

openclaw_docker_config_path() {
  if [[ -n "${OPENCLAW_CONFIG_PATH:-}" ]]; then
    printf "%s\n" "$OPENCLAW_CONFIG_PATH"
    return 0
  fi
  printf "%s/openclaw.json\n" "${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
}

openclaw_docker_compose_files() {
  local root
  root="$(openclaw_docker_repo_root)"
  local files=("$root/docker-compose.yml")

  if [[ -f "$root/docker-compose.override.yml" ]]; then
    files+=("$root/docker-compose.override.yml")
  fi
  if [[ -f "$root/docker-compose.extra.yml" ]]; then
    files+=("$root/docker-compose.extra.yml")
  fi

  printf "%s\n" "${files[@]}"
}

openclaw_docker_compose() {
  local args=()
  local file
  while IFS= read -r file; do
    args+=(-f "$file")
  done < <(openclaw_docker_compose_files)

  command docker compose "${args[@]}" "$@"
}

openclaw_docker_require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing dependency: $cmd" >&2
    return 1
  fi
}

openclaw_docker_require_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "Missing file: $file" >&2
    return 1
  fi
}

openclaw_docker_gateway_running() {
  local running
  running="$(openclaw_docker_compose ps --status running --services 2>/dev/null | tr -d '\r')" || return 2
  [[ "$running" == *"openclaw-gateway"* ]]
}
