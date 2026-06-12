#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_SCRIPT="${KCLAW_OPENCLAW_SERVICE_SCRIPT:-$ROOT_DIR/scripts/docker/openclaw-service.sh}"

if [[ -z "${KCLAW_CRON_FEISHU_TO:-}" ]]; then
  cat >&2 <<'EOF'
KCLAW_CRON_FEISHU_TO is required.
Use a Feishu delivery target such as:
  KCLAW_CRON_FEISHU_TO='chat:<feishu-chat-id>'

Jobs are created disabled by default. Set KCLAW_CRON_ENABLE=1 only when
the channel target, model, Pattern services, and watcher delivery have been
validated in KClaw.
EOF
  exit 2
fi

enabled_flag=(--disabled)
if [[ "${KCLAW_CRON_ENABLE:-0}" == "1" ]]; then
  enabled_flag=()
fi

add_agent_job() {
  local name="$1"
  local cron_expr="$2"
  local agent_id="$3"
  local timeout_seconds="$4"
  local thinking="$5"
  local message="$6"

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
    --announce
    --channel feishu
    --account main
    --to "$KCLAW_CRON_FEISHU_TO"
    --best-effort-deliver
  )

  if [[ -n "$thinking" ]]; then
    args+=(--thinking "$thinking")
  fi
  args+=("${enabled_flag[@]}")

  printf 'Registering cron job: %s\n' "$name" >&2
  "$SERVICE_SCRIPT" "${args[@]}"
}

quotation_pre_market_message='/think off

开盘前行情刷新：执行 Pattern Quotation 开盘前行情资讯链。必须通过 openclaw_mcp 行情工具调用 quotation_refresh_chain，参数使用 chain_key=pre_market；日期默认使用当前交易日的上一交易日，不要直接访问底层 Platform API。提交后获取返回的 job_id、status、message、chain_key、stages；然后无条件调用 quotation_watch_refresh 注册异步 watcher，不论返回的状态是什么（即使已经是 completed），都要注册 watcher，这样后续和未来的完成态都能通知到。注册后立即结束本轮，不要用 LLM 轮询。watcher 到达终态后负责拉取结果、记录自动化信息。任务结束后记录自动化执行信息：source=openclaw_cron，category=quotation，task_family=pre_market，task_key=quotation.refresh_run，business_job_id 使用 Quotation job_id，status 使用最终状态，raw_count 使用 total_symbols，returned_count 使用 success_symbols，notes 使用服务端 message。'

quotation_post_open_message='/think off

开盘前行情刷新：执行 Pattern Quotation 开盘后行情资讯链。必须通过 openclaw_mcp 行情工具调用 quotation_refresh_chain，参数使用 chain_key=post_open；日期默认使用当前交易日的上一交易日，不要直接访问底层 Platform API。提交后获取返回的 job_id、status、message、chain_key、stages；然后无条件调用 quotation_watch_refresh 注册异步 watcher，不论返回的状态是什么（即使已经是 completed），都要注册 watcher，这样后续和未来的完成态都能通知到。注册后立即结束本轮，不要用 LLM 轮询。watcher 到达终态后负责拉取结果、记录 automation 信息。任务结束后记录自动化执行信息：source=openclaw_cron，category=quotation，task_family=post_open，task_key=quotation.refresh_run，business_job_id 使用 Quotation job_id，status 使用最终状态，raw_count 使用 margin_record_count，returned_count 使用 margin_record_count，notes 使用服务端 message。'

mid_term_accel_message='执行 Pattern Strategy 中期加速策略。task_key 使用 strategy.mid_term_accel.daily_scan。不要再向用户二次确认，直接提交执行。overrides 必须使用嵌套对象格式，不要使用点路径格式：{"selection":{"limit":7000},"execution":{"max_workers":7}}。其他参数采用任务默认值。提交后只返回 job_id、status、message；如果状态是 accepted、queued 或 running，必须调用 strategy_watch_run 注册代码驱动 watcher，并立即结束本轮，不要用 LLM 轮询 strategy_get_run，不要派 subagent 轮询。调用 strategy_watch_run 时不要传 session_key 或 agent_id；必须使用 wake_mode="now"、enrich_signals=true、max_signals=20。watcher 到达终态后负责拉取信号、写入 automation_run_record，并通过 async callback 做 CANSLIM 因子 + 舆情 enrichment 后回调。提交失败时必须调用 automation_run_record 写 failed 记录：source=openclaw_cron，category=strategy，task_family=mid_term_accel，task_key=strategy.mid_term_accel.daily_scan，business_job_id 使用 Pattern Strategy job_id，status 使用最终状态，raw_count/returned_count/symbols/overrides/notes 按实际结果填写。首轮中文总结只包含：已提交状态、job_id、是否已注册 watcher。'

strong_pivot_breakout_message='执行 Pattern Strategy 强势枢轴突破策略。task_key 使用 strategy.strong_pivot_breakout.daily_scan。处理方法同中期加速策略：不要再向用户二次确认，直接提交执行。overrides 必须使用嵌套对象格式，不要使用点路径格式：{"selection":{"limit":7000},"execution":{"max_workers":7}}。其他参数采用任务默认值。提交后只返回 job_id、status、message；如果状态是 accepted、queued 或 running，必须调用 strategy_watch_run 注册代码驱动 watcher，并立即结束本轮，不要用 LLM 轮询 strategy_get_run，不要派 subagent 轮询。调用 strategy_watch_run 时不要传 session_key 或 agent_id；必须使用 wake_mode="now"、enrich_signals=true、max_signals=20。watcher 到达终态后负责拉取信号、写入 automation_run_record，并通过 async callback 做 CANSLIM 因子 + 舆情 enrichment 后回调。提交失败时必须调用 automation_run_record 写 failed 记录：source=openclaw_cron，category=strategy，task_family=strong_pivot_breakout，task_key=strategy.strong_pivot_breakout.daily_scan，business_job_id 使用 Pattern Strategy job_id，status 使用最终状态，raw_count/returned_count/symbols/overrides/notes 按实际结果填写。首轮中文总结只包含：已提交状态、job_id、是否已注册 watcher。'

mid_term_reversal_message='/think off

执行 Pattern Strategy 中期反转优化策略。task_key 使用 strategy.mid_term_reversal_opt.daily_scan。不要再向用户二次确认，直接提交执行。overrides 必须使用嵌套对象格式，不要使用点路径格式：{"selection":{"limit":7000},"execution":{"max_workers":7}}。其他参数采用任务默认值。提交后只返回 job_id、status、message；如果状态是 accepted、queued 或 running，必须调用 strategy_watch_run 注册代码驱动 watcher，并立即结束本轮，不要用 LLM 轮询 strategy_get_run，不要派 subagent 轮询。调用 strategy_watch_run 时不要传 session_key 或 agent_id；必须使用 wake_mode="now"、enrich_signals=true、max_signals=20。watcher 到达终态后负责拉取信号、写入 automation_run_record，并通过 async callback 回调；回调链路需沿用中期加速策略：先获取财报/成长、融资余额、机构持仓等因子信息，再补充舆情/热度信息，最后汇总成策略信号。提交失败时必须调用 automation_run_record 写 failed 记录：source=openclaw_cron，category=strategy，task_family=mid_term_reversal_opt，task_key=strategy.mid_term_reversal_opt.daily_scan，business_job_id 使用 Pattern Strategy job_id，status 使用最终状态，raw_count/returned_count/symbols/overrides/notes 按实际结果填写。首轮中文总结只包含：已提交状态、job_id、是否已注册 watcher。'

board_index_message='/think off

执行 Pattern Strategy 板块指数刷新任务。必须通过 pattern-strategy 工具调用 indice_refresh_run，不要直接访问底层 Pattern Platform API。日期使用当前交易日作为 end_date；start_date 使用 end_date 往前 3 个月的同日。按交易日生成 idempotency_key=indice-daily-YYYYMMDD。调用参数：dimensions=["industry","size","style","concept"], refresh_turnover=true, force_universe=false, source=openclaw_cron。提交后保存返回的 job_id、status、message；然后无条件调用 indice_watch_refresh 注册异步 watcher，不论返回的状态是什么（即使已经是 completed、partial_failed 或 failed），都要注册 watcher，这样本轮 cron 可以立即结束，后续由代码驱动 watcher 轮询终态并直接推送飞书执行结果。注册后立即结束本轮，不要用 LLM 轮询 indice_refresh_get。watcher 到达终态后负责拉取 indice_refresh_get；若 failed_indices > 0，再调用 indice_refresh_errors 获取失败明细并推送紧凑预览。首轮中文总结只包含：已提交状态、job_id、是否已注册 watcher。'

add_agent_job "quotation pre-market refresh" "10 4 * * 1-5" "pattern-quotation" 1800 "" "$quotation_pre_market_message"
add_agent_job "quotation post-open refresh" "0 10 * * 1-5" "pattern-quotation" 1800 "" "$quotation_post_open_message"
add_agent_job "mid_term_accel daily scan" "10 6 * * 1-5" "tas-dispatch" 7200 "" "$mid_term_accel_message"
add_agent_job "strong_pivot_breakout daily scan" "0 7 * * 1-5" "tas-dispatch" 7200 "" "$strong_pivot_breakout_message"
add_agent_job "mid_term_reversal_opt daily scan" "40 7 * * 1-5" "tas-dispatch" 7200 "off" "$mid_term_reversal_message"
add_agent_job "board index daily refresh" "0 9 * * 1-5" "pattern-strategy" 1800 "" "$board_index_message"
