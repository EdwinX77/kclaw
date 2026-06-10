#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/docker/openclaw-docker-common.sh"

openclaw_docker_load_env

FAILURES=0
WARNINGS=0

pass() {
  printf "[PASS] %s\n" "$1"
}

warn() {
  printf "[WARN] %s\n" "$1"
  WARNINGS=$((WARNINGS + 1))
}

fail() {
  printf "[FAIL] %s\n" "$1"
  FAILURES=$((FAILURES + 1))
}

check_http_ok() {
  local url="$1"
  if curl --noproxy '*' -fsS --max-time 8 "$url" >/dev/null; then
    return 0
  fi
  return 1
}

json_query() {
  local file="$1"
  local expression="$2"
  node - "$file" "$expression" <<'EOF'
const fs = require("fs");
const [file, expression] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const data = Function("return (" + text + ");")();
const value = Function("config", "return (" + expression + ");")(data);
if (typeof value === "undefined") {
  process.exit(2);
}
if (value === null) {
  process.stdout.write("null");
  process.exit(0);
}
if (typeof value === "object") {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
}
process.stdout.write(String(value));
EOF
}

check_compose_files() {
  while IFS= read -r file; do
    if [[ -f "$file" ]]; then
      pass "Compose file present: ${file#$ROOT_DIR/}"
    else
      fail "Compose file missing: ${file#$ROOT_DIR/}"
    fi
  done < <(openclaw_docker_compose_files)
}

check_gateway_container() {
  local status=0
  openclaw_docker_gateway_running || status=$?
  case "$status" in
    0)
      pass "Docker service openclaw-gateway is running"
      ;;
    1)
      fail "Docker service openclaw-gateway is not running"
      ;;
    *)
      fail "Docker service status could not be queried; check Docker daemon access"
      ;;
  esac
}

check_gateway_health() {
  if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    fail "OPENCLAW_GATEWAY_TOKEN is missing from .env"
    return 0
  fi

  local attempt
  local max_attempts=90
  local output_file
  output_file="$(mktemp)"
  for attempt in $(seq 1 "$max_attempts"); do
    if openclaw_docker_compose exec -T \
      -e "OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN" \
      openclaw-gateway node dist/index.js health >"$output_file" 2>&1; then
      pass "Gateway health probe succeeded"
      rm -f "$output_file"
      return 0
    fi
    if (( attempt < max_attempts )); then
      sleep 2
    fi
  done

  cat "$output_file" >&2
  rm -f "$output_file"
  fail "Gateway health probe failed"
}

check_pattern_strategy_http() {
  if check_http_ok "http://127.0.0.1:18080/healthz"; then
    pass "Pattern Strategy MCP healthz is reachable on 127.0.0.1:18080"
  else
    fail "Pattern Strategy MCP healthz is not reachable on 127.0.0.1:18080"
  fi

  local tools_file
  tools_file="$(mktemp)"
  if curl --noproxy '*' -fsS --max-time 8 "http://127.0.0.1:18080/tools" >"$tools_file"; then
    local missing=()
    local expected
    for expected in strategy.task_list strategy.task_run strategy.get_run strategy.get_signals; do
      if node - "$tools_file" "$expected" <<'EOF' >/dev/null; then
const fs = require("fs");
const [file, toolName] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
const list = Array.isArray(payload) ? payload : Array.isArray(payload.tools) ? payload.tools : [];
const found = list.some((item) => {
  if (typeof item === "string") return item === toolName;
  return item && typeof item === "object" && item.name === toolName;
});
process.exit(found ? 0 : 1);
EOF
        :
      else
        missing+=("$expected")
      fi
    done
    if [[ "${#missing[@]}" -eq 0 ]]; then
      pass "Pattern Strategy MCP exposes required strategy tools"
    else
      fail "Pattern Strategy MCP is missing tools: ${missing[*]}"
    fi
  else
    fail "Pattern Strategy MCP tools endpoint is not readable"
  fi
  rm -f "$tools_file"
}

check_config_file() {
  local config_path
  config_path="$(openclaw_docker_config_path)"
  if [[ -f "$config_path" ]]; then
    pass "Config file present: $config_path"
  else
    fail "Config file missing: $config_path"
    return 0
  fi

  if [[ "$(json_query "$config_path" "Boolean(config.channels?.feishu?.enabled)" 2>/dev/null || true)" == "true" ]]; then
    pass "Feishu channel is enabled"
  else
    fail "Feishu channel is not enabled in config"
  fi

  if [[ "$(json_query "$config_path" "Object.keys(config.channels?.feishu?.accounts || {}).length > 0" 2>/dev/null || true)" == "true" ]]; then
    pass "Feishu account configuration exists"
  else
    fail "Feishu account configuration is missing"
  fi

  if [[ -n "${FEISHU_APP_ID:-}" && -n "${FEISHU_APP_SECRET:-}" ]]; then
    pass "FEISHU_APP_ID and FEISHU_APP_SECRET are available in environment"
  else
    warn "FEISHU_APP_ID or FEISHU_APP_SECRET is missing from .env or process env"
  fi

  if [[ "$(json_query "$config_path" "Boolean(config.plugins?.entries?.['pattern-strategy']?.enabled)" 2>/dev/null || true)" == "true" ]]; then
    pass "Pattern Strategy plugin is enabled"
  else
    fail "Pattern Strategy plugin is not enabled"
  fi

  local base_url
  base_url="$(json_query "$config_path" "config.plugins?.entries?.['pattern-strategy']?.config?.baseUrl" 2>/dev/null || true)"
  if [[ "$base_url" == "http://127.0.0.1:18080" || "$base_url" == "http://host.docker.internal:18080" ]]; then
    pass "Pattern Strategy plugin baseUrl is configured for the local Pattern Strategy MCP"
  elif [[ -n "$base_url" ]]; then
    warn "Pattern Strategy plugin baseUrl is $base_url"
  else
    fail "Pattern Strategy plugin baseUrl is missing"
  fi

  if [[ "$(json_query "$config_path" "Array.isArray(config.agents?.list) && config.agents.list.some((agent) => agent?.id === 'pattern-strategy')" 2>/dev/null || true)" == "true" ]]; then
    pass "pattern-strategy agent exists"
  else
    fail "pattern-strategy agent is missing"
  fi

  if [[ "$(json_query "$config_path" "Array.isArray(config.bindings) && config.bindings.some((binding) => binding?.match?.channel === 'feishu')" 2>/dev/null || true)" == "true" ]]; then
    pass "At least one Feishu binding is configured"
  else
    fail "No Feishu binding is configured"
  fi

  local dm_policy
  dm_policy="$(json_query "$config_path" "config.channels?.feishu?.dmPolicy" 2>/dev/null || true)"
  if [[ "$dm_policy" == "allowlist" ]]; then
    if [[ "$(json_query "$config_path" "Array.isArray(config.channels?.feishu?.allowFrom) && config.channels.feishu.allowFrom.length > 0" 2>/dev/null || true)" == "true" ]]; then
      pass "Feishu allowlist is configured for dmPolicy=allowlist"
    else
      fail "Feishu dmPolicy=allowlist but allowFrom is empty"
    fi
  else
    warn "Feishu dmPolicy is ${dm_policy:-unset}"
  fi
}

check_research_tools() {
  if [[ -n "${BRAVE_API_KEY:-}" ]]; then
    pass "BRAVE_API_KEY is present for web_search"
  else
    warn "BRAVE_API_KEY is missing; web_search enrichment will fail"
  fi

  local config_path
  config_path="$(openclaw_docker_config_path)"
  if [[ ! -f "$config_path" ]]; then
    return 0
  fi

  if [[ "$(json_query "$config_path" "Boolean(config.browser?.enabled)" 2>/dev/null || true)" == "true" ]]; then
    pass "Browser tool is enabled"
  else
    warn "Browser tool is disabled; dynamic-page sentiment checks will be limited"
  fi
}

main() {
  openclaw_docker_require_cmd docker >/dev/null
  openclaw_docker_require_cmd curl >/dev/null
  openclaw_docker_require_cmd node >/dev/null

  check_compose_files
  check_gateway_container

  local gateway_status=0
  openclaw_docker_gateway_running || gateway_status=$?
  if (( gateway_status == 0 )); then
    check_gateway_health
  else
    warn "Skipping gateway health probe because the container is not ready"
  fi

  check_pattern_strategy_http
  check_config_file
  check_research_tools

  printf "\nSummary: %s failure(s), %s warning(s)\n" "$FAILURES" "$WARNINGS"
  if (( FAILURES > 0 )); then
    exit 1
  fi
}

main "$@"
