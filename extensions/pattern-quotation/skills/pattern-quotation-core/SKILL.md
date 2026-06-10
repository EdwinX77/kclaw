---
name: pattern-quotation-core
description: Use the Pattern Quotation MCP sub-service to run configured quotation task chains, check refresh status, and review refresh failures.
---

# Pattern Quotation Core

Use this skill when the user asks to refresh market quotation data, refresh market information/events, refresh margin trading data, check the latest quotation refresh, or review quotation refresh failures.

Pattern Quotation is a supporting MCP sub-service. It is not the strategy execution service. Keep user-facing wording clearly labeled as quotation refresh or information refresh, not as strategy signal generation.

Do not use this skill for chart-generation requests. If the request contains `chan图`, `Chan 图`, `缠论图`, `走势结构图`, `走势结构`, `生成图`, `画图`, or asks for a chart/image over a date window, return that it should be handled by the dedicated `pattern-chan` agent with `chan_generate_chart` instead. A historical date range by itself is not enough to treat a request as quotation refresh.

## Tool mapping

This OpenClaw plugin exposes chain-based bridge tools:

- `quotation_refresh_chain` -> `quotation.refresh_run`
- `quotation_refresh_get` -> `quotation.refresh_get`
- `quotation_refresh_errors` -> `quotation.refresh_errors`
- `quotation_watch_refresh` -> local async watcher for refresh completion
- `quotation_get_watch` -> local watcher lookup
- `quotation_unwatch_refresh` -> local watcher removal
- `quotation_list_watches` -> local watcher list

Use these bridge tools instead of direct Platform API calls.

## Task chains

Quotation refresh now uses configured task chains and explicit stages.

- `pre_market`: 04:10 chain, stages `events`, `prices`, `financials`
- `post_open`: 10:00 chain, stages `margin_trading`

Cron runs execute the previous trading day's data on the current trading day. For example, a Friday trading-day cron normally refreshes Thursday's quotation data.

Use `quotation_refresh_chain` with:

- `chain_key="pre_market"` for the opening-before chain
- `chain_key="post_open"` for the post-open margin trading chain
- `stages=[...]` only for explicit manual backfills; stages override `chain_key`

Do not use the legacy margin-trading boolean; margin trading is the `margin_trading` stage.

## Refresh Workflow

For normal daily market information refresh, call `quotation_refresh_chain` with `chain_key="pre_market"`.

For post-open margin trading refresh, call `quotation_refresh_chain` with `chain_key="post_open"`.

For Feishu/manual requests:

1. Use `chain_key` when the request matches a configured chain.
2. Use explicit `stages` only when the user asks to temporarily rerun specific stage data.
3. Pass `start_date` and `end_date` when the user asks for a specific date or history window.
4. If dates are omitted, the bridge defaults to the previous trading day in Asia/Shanghai.

After submission:

1. Return `job_id` and the remote `message` immediately.
2. If status is `pending`, `running`, or `pause_requested`, call `quotation_watch_refresh` so the final status can be delivered later.
3. Use `quotation_refresh_get` for progress or latest status checks.
4. Terminal statuses are `completed`, `partial_failed`, and `failed`.
5. If `failed_symbols > 0`, call `quotation_refresh_errors`.
6. Use the returned `message` field as the authoritative status text.
7. OpenClaw should directly forward terminal status/message to the terminal app. Do not wake the LLM to rewrite or package quotation completion text.

## Cron Workflow

OpenClaw cron should run two isolated Pattern Quotation turns:

```text
Run Pattern Quotation pre_market chain for the previous trading day. Call quotation_refresh_chain with chain_key=pre_market, return job_id/status/message, then register quotation_watch_refresh if the job is not terminal.
```

```text
Run Pattern Quotation post_open chain for the previous trading day. Call quotation_refresh_chain with chain_key=post_open, return job_id/status/message, then register quotation_watch_refresh if the job is not terminal.
```

Recommended idempotency keys:

- `quotation:pre_market:YYYYMMDD`
- `quotation:post_open:YYYYMMDD`
- `quotation:manual:<stage-or-chain>:YYYYMMDD`

Do not block the first cron or Feishu reply waiting for a long-running refresh to finish.

## Error Handling

The remote service returns a normalized envelope with `ok`, `data`, `error`, and `meta`.

If a tool call fails, prioritize:

1. `error.code`
2. `error.message`
3. `error.retryable`
4. `error.details`

Retry only when the service marks the error as retryable or when the failure is clearly transient.
