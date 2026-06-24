#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_SCRIPT="${KCLAW_OPENCLAW_SERVICE_SCRIPT:-$ROOT_DIR/scripts/docker/openclaw-service.sh}"

MARKET_FEISHU_TO="${KCLAW_CRON_FEISHU_MARKET_TO:-}"
STRATEGY_FEISHU_TO="${KCLAW_CRON_FEISHU_STRATEGY_TO:-${KCLAW_CRON_FEISHU_TO:-}}"

if [[ -z "$MARKET_FEISHU_TO" || -z "$STRATEGY_FEISHU_TO" ]]; then
  cat >&2 <<'EOF'
KClaw cron delivery targets are required.

For MyClaw parity, use a direct Feishu user target for market-data jobs and a
chat target for strategy scans:
  KCLAW_CRON_FEISHU_MARKET_TO='user:<feishu-open-id>'
  KCLAW_CRON_FEISHU_STRATEGY_TO='chat:<feishu-chat-id>'

KCLAW_CRON_FEISHU_TO remains a legacy fallback for strategy scans only. Market
jobs must always use KCLAW_CRON_FEISHU_MARKET_TO so quotation and board-index
delivery cannot accidentally inherit the strategy chat target.

Jobs are created disabled by default. Set KCLAW_CRON_ENABLE=1 only when
the channel target, model, Pattern services, and watcher delivery have been
validated in KClaw.
EOF
  exit 2
fi

if [[ ! "$MARKET_FEISHU_TO" =~ ^(user:|dm:|open_id:|ou_) ]]; then
  cat >&2 <<'EOF'
KCLAW_CRON_FEISHU_MARKET_TO must be a direct Feishu user target for quotation
and board-index completion delivery. Use a value such as:
  KCLAW_CRON_FEISHU_MARKET_TO='user:<feishu-open-id>'
EOF
  exit 2
fi

enabled_flag=(--disabled)
if [[ "${KCLAW_CRON_ENABLE:-0}" == "1" ]]; then
  enabled_flag=()
fi

extract_cron_job_id() {
  node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const id =
    typeof parsed?.id === "string"
      ? parsed.id
      : typeof parsed?.job?.id === "string"
        ? parsed.job.id
        : "";
  if (!id) {
    throw new Error(`cron add output did not include a job id: ${input}`);
  }
  console.log(id);
});
'
}

configure_failure_alert() {
  local job_id="$1"
  local delivery_to="$2"

  "$SERVICE_SCRIPT" \
    cli cron edit "$job_id" \
    --failure-alert \
    --failure-alert-after 1 \
    --failure-alert-channel feishu \
    --failure-alert-to "$delivery_to" \
    --failure-alert-mode announce \
    --failure-alert-account-id main >/dev/null
}

add_agent_job() {
  local name="$1"
  local cron_expr="$2"
  local agent_id="$3"
  local timeout_seconds="$4"
  local thinking="$5"
  local message="$6"
  local delivery_to="$7"

  local args=(
    cli cron add
    --name "$name"
    --cron "$cron_expr"
    --tz Asia/Shanghai
    --exact
    --session isolated
    --wake now
    --agent "$agent_id"
    --message "$message"
    --timeout-seconds "$timeout_seconds"
    --no-deliver
    --channel feishu
    --account main
    --to "$delivery_to"
    --best-effort-deliver
  )

  if [[ -n "$thinking" ]]; then
    args+=(--thinking "$thinking")
  fi
  args+=("${enabled_flag[@]}")

  printf 'Registering cron job: %s\n' "$name" >&2
  local output
  output="$("$SERVICE_SCRIPT" "${args[@]}")"
  printf '%s\n' "$output"

  local job_id
  job_id="$(printf '%s\n' "$output" | extract_cron_job_id)"
  configure_failure_alert "$job_id" "$delivery_to"
}

add_command_job() {
  local name="$1"
  local cron_expr="$2"
  local agent_id="$3"
  local timeout_seconds="$4"
  local command="$5"
  local delivery_to="$6"

  local args=(
    cli cron add
    --name "$name"
    --cron "$cron_expr"
    --tz Asia/Shanghai
    --exact
    --session isolated
    --wake now
    --agent "$agent_id"
    --command "$command"
    --timeout-seconds "$timeout_seconds"
    --output-max-bytes 12000
    --command-env "KCLAW_BOARD_INDEX_DELIVERY_TO=$delivery_to"
    --command-env "KCLAW_BOARD_INDEX_SESSION_KEY=agent:pattern-strategy:cron:board-index-daily-refresh"
    --no-deliver
    --channel feishu
    --account main
    --to "$delivery_to"
    --best-effort-deliver
  )

  args+=("${enabled_flag[@]}")

  printf 'Registering cron job: %s\n' "$name" >&2
  local output
  output="$("$SERVICE_SCRIPT" "${args[@]}")"
  printf '%s\n' "$output"

  local job_id
  job_id="$(printf '%s\n' "$output" | extract_cron_job_id)"
  configure_failure_alert "$job_id" "$delivery_to"
}

quotation_pre_market_message='/think off

开盘前行情刷新：执行 Pattern Quotation 开盘前行情资讯链。必须通过 openclaw_mcp 行情工具调用 quotation_refresh_chain，参数使用 chain_key=pre_market；日期默认使用当前交易日的上一交易日，不要直接访问底层 Platform API。提交后获取返回的 job_id、status、message、chain_key、stages；然后无条件调用 quotation_watch_refresh 注册异步 watcher，不论返回的状态是什么（即使已经是 completed），都要注册 watcher，这样后续和未来的完成态都能通知到。注册后立即结束本轮，不要用 LLM 轮询。watcher 到达终态后负责拉取结果、记录自动化信息并投递完成通知。任务结束后记录自动化执行信息：source=openclaw_cron，category=quotation，task_family=pre_market，task_key=quotation.refresh_run，business_job_id 使用 Quotation job_id，status 使用最终状态，raw_count 使用 total_symbols，returned_count 使用 success_symbols，notes 使用服务端 message。注册 watcher 成功后，本轮最终回复必须只输出 NO_REPLY，不要输出 job_id、JSON、解释或摘要。'

quotation_post_open_message='/think off

开盘后行情刷新：执行 Pattern Quotation 开盘后行情资讯链。必须通过 openclaw_mcp 行情工具调用 quotation_refresh_chain，参数使用 chain_key=post_open；日期默认使用当前交易日的上一交易日，不要直接访问底层 Platform API。提交后获取返回的 job_id、status、message、chain_key、stages；然后无条件调用 quotation_watch_refresh 注册异步 watcher，不论返回的状态是什么（即使已经是 completed），都要注册 watcher，这样后续和未来的完成态都能通知到。注册后立即结束本轮，不要用 LLM 轮询。watcher 到达终态后负责拉取结果、记录 automation 信息并投递完成通知。任务结束后记录自动化执行信息：source=openclaw_cron，category=quotation，task_family=post_open，task_key=quotation.refresh_run，business_job_id 使用 Quotation job_id，status 使用最终状态，raw_count 使用 margin_record_count，returned_count 使用 margin_record_count，notes 使用服务端 message。注册 watcher 成功后，本轮最终回复必须只输出 NO_REPLY，不要输出 job_id、JSON、解释或摘要。'

mid_term_accel_message='/think off

执行 Pattern Strategy 中期加速策略。task_key 使用 strategy.mid_term_accel.daily_scan。不要再向用户二次确认，直接提交执行。本轮 cron 是执行命令，不是状态查询；不得调用 automation_run_daily_summary、automation_run_latest 或 automation_run_list 来判断是否已跑，不得用历史 automation record、旧会话内容或前一交易日记录跳过本轮提交；只有完成本轮 strategy_task_run/strategy_watch_run 后才可写 automation_run_record。提交 strategy_task_run 时必须显式传入：idempotency_key=cron-mid-term-accel-YYYY-MM-DD，source=openclaw_cron，requested_by=openclaw_gateway，trigger_type=cron，trace_id=cron:<本轮OpenClaw cron job id>:YYYY-MM-DD；YYYY-MM-DD 使用最近 A 股交易日，周六或非交易日触发时不要使用日历日；本轮 OpenClaw cron job id 从消息前缀 [cron:<job_id> ...] 读取。overrides 必须使用嵌套对象格式，不要使用点路径格式：{"selection":{"limit":7000},"execution":{"max_workers":7}}。其他参数采用任务默认值。提交后只返回 job_id、status、message；如果状态是 accepted、queued 或 running，必须调用 strategy_watch_run 注册代码驱动 watcher，并立即结束本轮，不要用 LLM 轮询 strategy_get_run，不要派 subagent 轮询。调用 strategy_watch_run 时不要传 session_key 或 agent_id；必须使用同一组 idempotency_key/source/requested_by/trace_id/trigger_type，并使用 wake_mode="now"、enrich_signals=true、max_signals=20。watcher 到达终态后负责拉取信号、写入 automation_run_record，并通过 async callback 做 CANSLIM 因子 + 舆情 enrichment 后回调。提交失败时必须调用 automation_run_record 写 failed 记录：source=openclaw_cron，category=strategy，task_family=mid_term_accel，task_key=strategy.mid_term_accel.daily_scan，business_job_id 使用 Pattern Strategy job_id；如果没有 job_id 则写 "-"；status 使用最终状态，raw_count/returned_count/symbols/overrides/notes 按实际结果填写。注册 watcher 成功后，本轮最终回复必须只输出 NO_REPLY，不要输出 job_id、JSON、解释或摘要。'

strong_pivot_breakout_message='/think off

执行 Pattern Strategy 强势枢轴突破策略。task_key 使用 strategy.strong_pivot_breakout.daily_scan。不要再向用户二次确认，直接提交执行。本轮 cron 是执行命令，不是状态查询；不得调用 automation_run_daily_summary、automation_run_latest 或 automation_run_list 来判断是否已跑，不得用历史 automation record、旧会话内容或前一交易日记录跳过本轮提交；只有完成本轮 strategy_task_run/strategy_watch_run 后才可写 automation_run_record。提交 strategy_task_run 时必须显式传入：idempotency_key=cron-strong-pivot-breakout-YYYY-MM-DD，source=openclaw_cron，requested_by=openclaw_gateway，trigger_type=cron，trace_id=cron:<本轮OpenClaw cron job id>:YYYY-MM-DD；YYYY-MM-DD 使用最近 A 股交易日，周六或非交易日触发时不要使用日历日；本轮 OpenClaw cron job id 从消息前缀 [cron:<job_id> ...] 读取。overrides 必须使用嵌套对象格式，不要使用点路径格式：{"selection":{"limit":7000},"execution":{"max_workers":7}}。其他参数采用任务默认值。提交后只返回 job_id、status、message；如果状态是 accepted、queued 或 running，必须调用 strategy_watch_run 注册代码驱动 watcher，并立即结束本轮，不要用 LLM 轮询 strategy_get_run，不要派 subagent 轮询。调用 strategy_watch_run 时不要传 session_key 或 agent_id；必须使用同一组 idempotency_key/source/requested_by/trace_id/trigger_type，并使用 wake_mode="now"、enrich_signals=true、max_signals=20。watcher 到达终态后负责拉取信号、写入 automation_run_record，并通过 async callback 做 CANSLIM 因子 + 舆情 enrichment 后回调。提交失败时必须调用 automation_run_record 写 failed 记录：source=openclaw_cron，category=strategy，task_family=strong_pivot_breakout，task_key=strategy.strong_pivot_breakout.daily_scan，business_job_id 使用 Pattern Strategy job_id；如果没有 job_id 则写 "-"；status 使用最终状态，raw_count/returned_count/symbols/overrides/notes 按实际结果填写。注册 watcher 成功后，本轮最终回复必须只输出 NO_REPLY，不要输出 job_id、JSON、解释或摘要。'

mid_term_reversal_message='/think off

执行 Pattern Strategy 中期反转优化策略。task_key 使用 strategy.mid_term_reversal_opt.daily_scan。不要再向用户二次确认，直接提交执行。本轮 cron 是执行命令，不是状态查询；不得调用 automation_run_daily_summary、automation_run_latest 或 automation_run_list 来判断是否已跑，不得用历史 automation record、旧会话内容或前一交易日记录跳过本轮提交；只有完成本轮 strategy_task_run/strategy_watch_run 后才可写 automation_run_record。提交 strategy_task_run 时必须显式传入：idempotency_key=cron-mid-term-reversal-opt-YYYY-MM-DD，source=openclaw_cron，requested_by=openclaw_gateway，trigger_type=cron，trace_id=cron:<本轮OpenClaw cron job id>:YYYY-MM-DD；YYYY-MM-DD 使用最近 A 股交易日，周六或非交易日触发时不要使用日历日；本轮 OpenClaw cron job id 从消息前缀 [cron:<job_id> ...] 读取。overrides 必须使用嵌套对象格式，不要使用点路径格式：{"selection":{"limit":7000},"execution":{"max_workers":7}}。其他参数采用任务默认值。提交后只返回 job_id、status、message；如果状态是 accepted、queued 或 running，必须调用 strategy_watch_run 注册代码驱动 watcher，并立即结束本轮，不要用 LLM 轮询 strategy_get_run，不要派 subagent 轮询。调用 strategy_watch_run 时不要传 session_key 或 agent_id；必须使用同一组 idempotency_key/source/requested_by/trace_id/trigger_type，并使用 wake_mode="now"、enrich_signals=true、max_signals=20。watcher 到达终态后负责拉取信号、写入 automation_run_record，并通过 async callback 回调；回调链路需沿用中期加速策略：先获取财报/成长、融资余额、机构持仓等因子信息，再补充舆情/热度信息，最后汇总成策略信号。提交失败时必须调用 automation_run_record 写 failed 记录：source=openclaw_cron，category=strategy，task_family=mid_term_reversal_opt，task_key=strategy.mid_term_reversal_opt.daily_scan，business_job_id 使用 Pattern Strategy job_id；如果没有 job_id 则写 "-"；status 使用最终状态，raw_count/returned_count/symbols/overrides/notes 按实际结果填写。注册 watcher 成功后，本轮最终回复必须只输出 NO_REPLY，不要输出 job_id、JSON、解释或摘要。'

board_index_command='node --input-type=module -e '"'"'
const gatewayUrl = (
  process.env.OPENCLAW_GATEWAY_URL ||
  `http://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || "18789"}`
).replace(/\/+$/, "");
const deliveryTo = (process.env.KCLAW_BOARD_INDEX_DELIVERY_TO || "").trim();
if (!deliveryTo) {
  throw new Error("KCLAW_BOARD_INDEX_DELIVERY_TO is required");
}
const token = (process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
const headers = {
  "content-type": "application/json",
  "x-openclaw-message-channel": "feishu",
  "x-openclaw-account-id": "main",
  "x-openclaw-message-to": deliveryTo,
};
if (token) {
  headers.authorization = `Bearer ${token}`;
}
const sessionKey =
  process.env.KCLAW_BOARD_INDEX_SESSION_KEY ||
  "agent:pattern-strategy:cron:board-index-daily-refresh";
const invokeTool = async (name, args) => {
  const response = await fetch(`${gatewayUrl}/tools/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      agentId: "pattern-strategy",
      sessionKey,
      args,
    }),
  });
  const text = await response.text();
  let body = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok || body.ok === false) {
    throw new Error(JSON.stringify({ tool: name, status: response.status, body }));
  }
  return body.result?.details ?? body.result ?? body;
};
const readData = (result) => {
  const data = result?.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
};
const formatMarketAsOf = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+08:00`;
};
const parseMarketDate = (dateText) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) {
    throw new Error(`invalid market date: ${dateText}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDay) {
    throw new Error(`invalid market date: ${dateText}`);
  }
  return { year, month, day };
};
const pad2 = (value) => String(value).padStart(2, "0");
const shiftMarketDateByMonths = (dateText, deltaMonths) => {
  const parsed = parseMarketDate(dateText);
  const zeroBasedMonth = parsed.month - 1 + deltaMonths;
  const targetYear = parsed.year + Math.floor(zeroBasedMonth / 12);
  const targetMonthIndex = ((zeroBasedMonth % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(parsed.day, lastTargetDay);
  return `${targetYear}-${pad2(targetMonth)}-${pad2(targetDay)}`;
};
try {
  const latest = readData(
    await invokeTool("market_latest_available_trade_date", {
      market: "CN_A",
      as_of: formatMarketAsOf(),
      purpose: "daily_scan",
    }),
  );
  const endDate = typeof latest.trade_date === "string" ? latest.trade_date.trim() : "";
  if (!endDate || latest.data_ready !== true) {
    throw new Error(`market.latest_available_trade_date returned invalid date: ${JSON.stringify(latest)}`);
  }
  const startDate = shiftMarketDateByMonths(endDate, -3);
  const requestKey = `indice-daily-${endDate.replace(/-/g, "")}`;
  const refresh = readData(
    await invokeTool("indice_refresh_run", {
      start_date: startDate,
      end_date: endDate,
      dimensions: ["industry", "size", "style", "concept"],
      refresh_turnover: true,
      force_universe: false,
      source: "openclaw_cron",
      idempotency_key: requestKey,
    }),
  );
  const jobId =
    typeof refresh.job_id === "string"
      ? refresh.job_id.trim()
      : typeof refresh.jobId === "string"
        ? refresh.jobId.trim()
        : "";
  if (!jobId) {
    throw new Error(`indice.refresh_run returned no job_id: ${JSON.stringify(refresh)}`);
  }
  await invokeTool("indice_watch_refresh", {
    job_id: jobId,
    source: "openclaw_cron",
    request_key: requestKey,
    run_label: `board-index-${endDate}`,
    session_key: sessionKey,
    agent_id: "pattern-strategy",
    wake_mode: "now",
    refresh_date: endDate,
  });
  console.log("NO_REPLY");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
'"'"''

add_agent_job "quotation pre-market refresh" "10 4 * * 1-6" "pattern-quotation" 1800 "off" "$quotation_pre_market_message" "$MARKET_FEISHU_TO"
add_agent_job "quotation post-open refresh" "0 10 * * 1-6" "pattern-quotation" 1800 "off" "$quotation_post_open_message" "$MARKET_FEISHU_TO"
add_agent_job "mid_term_accel daily scan" "10 5 * * 1-6" "tas-dispatch" 7200 "off" "$mid_term_accel_message" "$STRATEGY_FEISHU_TO"
add_agent_job "strong_pivot_breakout daily scan" "10 6 * * 1-6" "tas-dispatch" 7200 "off" "$strong_pivot_breakout_message" "$STRATEGY_FEISHU_TO"
add_agent_job "mid_term_reversal_opt daily scan" "10 7 * * 1-6" "tas-dispatch" 7200 "off" "$mid_term_reversal_message" "$STRATEGY_FEISHU_TO"
add_command_job "board index daily refresh" "0 9 * * 1-6" "pattern-strategy" 1800 "$board_index_command" "$MARKET_FEISHU_TO"
