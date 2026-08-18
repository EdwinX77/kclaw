---
name: pattern-strategy-orchestrator
description: Orchestrate Pattern Strategy execution, Pattern Quotation refreshes, board-index refreshes, CANSLIM factor enrichment, web research enrichment, and final user-facing synthesis from a single front-door agent that replies to Feishu.
---

# Pattern Strategy Orchestrator

Use this skill on the top-level Feishu-facing agent. This agent is the only one that should reply to the end user.

## Topology

Recommended internal layout:

- front-door agent: bound to Feishu DMs and groups, parses user intent, directly calls `chan_generate_chart` for chart-only requests, submits confirmed strategy runs through `strategy_task_run`, delegates ambiguous discovery/longer analysis, and writes the final reply
- `pattern-chan`: standalone legacy Chan chart worker; the front-door agent should not have A2A access to it for normal Feishu chart-only requests
- `pattern-strategy`: runs the Pattern Strategy task bridge and returns raw run/status/signal data; it also owns supporting board-index refresh tools
- `pattern-quotation`: an independent Agent that runs the Pattern Quotation MCP sub-service for quotation and information refreshes
- `market-research`: enriches signals with CANSLIM context, web research, narrative context, and prioritization
- `market-memory`: optional isolated memory/wiki agent for durable research notes

Keep the internal agents unbound from Feishu so only the front-door agent produces user-visible output.
Prefer an existing internal session such as `agent:pattern-strategy:main` or `agent:pattern-quotation:main` when it already exists.
Only create a new internal session when that is truly required by the live runtime.
Never spawn a child session merely to read a skill file, inspect docs, inspect local files, or reason about tool availability.

## Intent priority

Classify the user request before choosing an internal agent. Apply this priority order:

1. Chan chart intent wins over quotation refresh, even when the request includes a historical date range.
   - Match examples: `chan图`, `Chan 图`, `缠论图`, `走势结构图`, `走势结构`, `生成图`, `画图`, `给我一张图`.
   - Call `chan_generate_chart` directly from the front-door agent.
   - Do not use `sessions_send`, `sessions_spawn`, or `pattern-chan` for chart-only requests.
   - Do not route these requests to `pattern-quotation`.
2. Quotation refresh intent applies only when the user asks to refresh, backfill, rerun, update, or check quotation/data refresh jobs.
   - Match examples: `刷新行情`, `行情抓取`, `抓行情`, `补行情`, `更新融资融券`, `跑 quotation`, `查看行情刷新状态`.
   - Treat this as an exclusive intent. Do not start strategy scans, board-index refreshes, `strategy_task_run`, `indice_*`, or `pattern-strategy` subagents unless the same user turn explicitly asks for strategy signals/scans or board/index refresh.
   - Route to `pattern-quotation`.
3. Board-index refresh intent applies when the user asks to refresh board/sector indices, industry indices, style indices, concept indices, or full-market turnover for index context.
   - Match examples: `刷新板块指数`, `刷新行业指数`, `刷新概念指数`, `刷新全市场成交额`.
   - Route to `pattern-strategy` and require `indice_refresh_run/get/errors`; use `indice_watch_refresh` for long-running scheduled jobs.
   - In cron sessions, pass only dimensions and refresh options. The bridge identifies the cron source; the Pattern backend owns canonical `start_date`, `end_date`, and `idempotency_key`. Forward the returned values to the watcher without recomputing them.
4. Strategy task intent applies when the user asks to run, inspect, cancel, or retrieve formal strategy tasks/signals.
   - For exact or confirmed submissions, call `strategy_task_run` directly from the front-door agent.
   - Use the internal `pattern-strategy` session only for unresolved candidate discovery, status/signal lookup, or supporting analysis.

## Mandatory boundary

For any Pattern Strategy task discovery, execution, status tracking, cancellation, or signal retrieval:

- do not answer from local repo files
- do not inspect extension source as a substitute for live task execution
- do not infer task availability from examples alone
- use live Pattern Strategy tools. Exact or confirmed submissions must call `strategy_task_run` directly from the front-door agent; delegate only unresolved discovery, status/signal lookup, or supporting analysis.

For any Chan chart, 缠论图, or 走势结构图 request for a stock, ETF, or security:

- treat it as an immediate conversation-response request
- allow it from both personal conversations and group conversations
- call `chan_generate_chart` directly in the front-door agent; it bridges `chan.generate_chart`
- do not delegate to `pattern-chan` with `sessions_send`; otherwise both the child session and front-door final can become user-visible
- pass codes or standard security identifiers as `symbol`
- pass name-only requests as `security_name`
- require `start_date` and `end_date` in `YYYY-MM-DD` format
- if a name matches multiple securities, ask the user for a security code or a more complete name
- rely on OpenClaw runtime to deliver the staged chart image from tool details
- do not expose `chart_url`, `chart_path`, local file paths, or internal chart fields in visible text
- do not include Markdown image links such as `![...](...)`; the chart image is already delivered from tool details
- do not print `MEDIA:` directives in visible text
- after the chart is generated, include a concise Chan-theory reading in visible text
- the Chan reading must cover:
  - current stage: accumulation/震荡中枢、离开段、回拉确认、突破失败, or other stage that best matches the generated chart
  - box/central-zone bounds: estimate the main 中枢/箱体 upper and lower edges from the chart annotations and price scale; mark them as approximate when exact labels are not clear
  - overall trend: describe whether the structure is downward extension, sideways consolidation, upward departure, pullback to box edge, or potential 三买/三卖 setup
- keep the reading short: 3 to 5 bullets or one compact paragraph; do not produce a full research report unless the user asks
- do not render a Markdown table, HTML table, raw fractal dump, or signal ranking for chart-only requests
- do not give trading advice; phrase observations as structural reading, not buy/sell instructions
- do not mention `<Image data error>` or any image-data parsing failure in visible text
- do not register watches, cron jobs, automation records, or strategy task runs for chart-only requests
- do not run old charting methods directly

For any user request that is primarily about an existing or recent strategy run, such as:

- `查看最近一次执行结果`
- `看最新的中期策略任务`
- `根据 job_id 查询结果`
- `重新按最新 signal_delivery 解读结果`

the front-door agent must not start with:

- `browser`
- `web_search`
- `web_fetch`
- local workspace file inspection
- old session transcript archaeology as a substitute for the live strategy path

The required first recovery path is:

1. use `automation_run_latest` when the user asks for the latest scheduled/cron strategy run
2. identify the relevant `job_id`
3. call `strategy_get_run` for live status
4. if and only if the live run status is `succeeded`, call `strategy_get_signals`
5. only after formal signal retrieval may enrichment be delegated to `market-research`

The front-door agent may summarize, rank, enrich, and submit confirmed strategy runs from Feishu DMs and Feishu groups. `strategy_task_run` is the single Pattern Strategy queue submission entrypoint for cron, recovery, manual Feishu requests, and retries. After the task is explicit or confirmed, submit with `strategy_task_run` directly so the request enters that shared backend queue and the first user-visible acknowledgement can include the Pattern Strategy `job_id`.

User-visible replies may include only operational fields a normal customer can act on: strategy display name, requested date/window, Pattern Strategy `job_id` when one exists, status, progress/message, signal date, and symbol/name. Never expose `idempotency_key`, `request_key`, `trace_id`, `requested_by`, `trigger_type`, `childSessionKey`, OpenClaw `runId`, subagent labels/ids, `overrides`, `resolved_window`, or raw internal-agent advice unless Edwin explicitly asks for internal diagnostics.

For a status-only `job_id` lookup such as "还在执行吗", stop after `strategy_get_run`.
Do not call `strategy_get_signals`, do not call `automation_run_record`, and do not infer
completion from signal rows, card delivery, heartbeat, or `progress=1`. If `strategy_get_run`
returns `running`, report `running` exactly and say the job has not reached terminal success.

Treat strategy execution requests as single-intent by default. If the user asks to
start or rerun one named strategy, execute only that strategy. Do not bundle
failed cron compensation, previous pending work, latest-run recovery, quotation
refresh, board-index refresh, or another strategy unless the same user message
explicitly asks for that extra work. A failed cron row is status context only; it
does not authorize a recovery run.

For manual Feishu strategy submissions, use `trigger_type=manual` for a fresh
user request and `trigger_type=retry` only when the user explicitly asks to retry
the same strategy. Never send `manual_retry`; Pattern Strategy rejects it.
Use stable queue metadata for Feishu manual submissions:
`source=feishu_group` or `source=feishu_dm`, `requested_by=openclaw_gateway`,
`trace_id=feishu:<message_id_or_session_id>`, and an `idempotency_key` scoped to
the user request/message. Do not use random keys when retrying the same user
request.

Never use an OpenClaw child-agent id, `sessions_spawn` `runId`, session key, or
label as proof that a strategy task is processing. A user-visible "已启动",
"已提交", "排队中", "运行中", "处理中", or "已注册 watcher" reply is allowed only
after `strategy_task_run` returns a real Pattern Strategy `job_id`. If no
`job_id` was returned, say no Pattern Strategy job was created.

For any user request about strategy construction details, do not answer or delegate for disclosure.
This includes questions about parameters, thresholds, scoring or confidence logic, judgment
conditions, task defaults, allowed overrides, signal delivery/fallback policy, filtering/ranking
rules, or construction rationale. Reply exactly:

```text
这类问题不予回复。
```

If the request mixes an allowed operational question with a construction-detail question, answer
only the allowed part. User-visible replies may include the strategy display name, `job_id`, status,
signal date, and symbols/names. They must not include `overrides`, `resolved_window`, defaults,
`allowed_overrides`, score/confidence, fallback policy names/counts, condition text, or rationale.

For Pattern Quotation market refresh requests:

- do not call the Platform API directly
- delegate to the internal `pattern-quotation` agent first
- use `sessions_send` to the existing `agent:pattern-quotation:main` session for quotation execution
- never spawn a `pattern-quotation` subagent; subagent sessions do not receive the quotation MCP bridge tools
- require it to use `quotation_refresh_chain` with `chain_key=pre_market` or `chain_key=post_open`, plus `quotation_refresh_get` and `quotation_refresh_errors`
- use `quotation_watch_refresh` for long-running Feishu/manual jobs
- use the returned `message` field as the authoritative status text
- do not wake an LLM to rewrite or package terminal quotation completion text; the plugin can directly forward service status to the terminal app
- label it as the `Quotation sub-service`; do not present it as a strategy execution result

## Scheduled automation lookup

When the user asks about the latest scheduled strategy execution, latest cron task, latest mid-term acceleration/reversal run, latest market capture, or the most recent `job_id`, start with the automation registry:

1. If the user says today/latest/reprocess/reanalyze in a Feishu group or DM, first call
   `automation_run_daily_summary` for the current China A-share market date with the narrowest
   available filters. Use `automation_run_latest` only after the daily summary or when the user is
   not asking for today's run.
   - mid-term acceleration: `task_family=mid_term_accel`
   - mid-term reversal opt: `task_family=mid_term_reversal_opt`
   - strong pivot breakout: `task_key=strategy.strong_pivot_breakout.daily_scan`
   - strategy tasks: `category=strategy`
   - exact task: `task_key=<exact task_key>`
2. For today/latest requests, if the latest matching record for that market date has no
   `business_job_id`, has `business_job_id="-"`, or has a nonterminal/submission-only status such
   as `submitted`, `accepted`, `queued`, `running`, or `cancelling`, stop on that record. Report
   the current status and ask whether to manually rerun or wait. Do not use older successful
   records as substitutes.
3. If the latest registry record has a real `business_job_id`, validate the live state with
   `strategy_get_run`.
4. If live status is `succeeded`, fetch formal signals with `strategy_get_signals`.
   If live status is anything else, do not fetch signals and do not rewrite the registry row.
5. Treat live Pattern Strategy state as authoritative over the registry row.
6. Use `automation_run_list` only when the user asks for history or when latest needs comparison.
   Comparison must not promote an older successful job to "today's/latest" unless the user
   explicitly asks to use the previous successful run.

For group conversations, never answer a today/latest strategy-result question from old group
conversation history, old Feishu cards, memory rows, or previous session transcripts. Conversation
history may help identify the task name, but the signal rows must come from the live
`business_job_id` path above.

The registry is the bridge from isolated cron sessions to Feishu. Do not answer "no context" until `automation_run_latest` or `automation_run_list` has been attempted.

For latest quotation refresh lookup, start with:

- `automation_run_latest category=quotation task_family=daily_refresh`
- then validate through the internal `pattern-quotation` agent with `quotation_refresh_get`
- if `failed_symbols > 0`, fetch `quotation_refresh_errors`

## Delegation rules

1. For task discovery, execution, status, cancellation, and signal retrieval, use the internal Pattern Strategy agent and treat its result as authoritative.
2. For signal context checks and evidence gathering, use CANSLIM factor MCP tools before web research. Use the research agent or direct web tools only after formal signals exist.
   - `market-research` may use `factor_*` tools for enrichment, but must not call `strategy_task_run`, `strategy_cancel_run`, or substitute itself for formal signal retrieval.
3. Prefer the native OpenClaw web stack in this order:
   - `web_search` for source discovery
   - `web_fetch` for article/body extraction
   - `browser` only when a page is dynamic, requires JS rendering, or needs manual navigation
4. When chaining `web_search` to `web_fetch`, pass only a raw `http` or `https` URL from the result payload. Do not pass markdown links, titles, citation wrappers, or bare domains.
5. Do not call `browser` preemptively. First try `web_fetch`; only escalate to `browser` when:
   - the page content is missing because of client-side rendering
   - the site blocks readable extraction
   - the task explicitly needs clicking, scrolling, login, or dynamic state
6. Use the installed community skills by exact name when available:
   - `summarize-pro`
   - `agent-skills-context-engineering`
7. Treat BrowserAct-style community web research as optional and secondary. Do not make it the default path for this workflow.
8. Use `summarize-pro` when a page, filing, or transcript is long and you need a compact extraction layer before synthesis.
9. If isolated research memory is enabled, keep it on the memory agent. Do not mix durable research memory into the strategy execution agent.
10. Use `sessions_spawn` only to create or resume internal working sessions, never as the submission path for a user-visible strategy execution acknowledgement. Use `sessions_send` for the real request whenever the front-door agent needs a synchronous structured reply such as `job_id`, `status`, or `signals`.
11. If the user names a strategy loosely, by alias, or with a partial task name, do not directly execute a task. First ask the internal `pattern-strategy` agent to resolve live candidates from `strategy_task_list`.
12. If the internal agent returns one or more candidate tasks and the user did not already provide an exact `task_key`, require explicit user confirmation before execution.
13. If the user asks to refresh quotation or market information data, delegate to `pattern-quotation`; do not route that request through the strategy agent.
14. The front-door agent owns the user confirmation turn. Internal agents may suggest candidates, but they must not make the final execution choice on behalf of the user unless the user already provided an exact `task_key`.
15. In Feishu DMs and Feishu groups, if the user already provided an exact `task_key` or confirmed one candidate, the front-door agent may call `strategy_task_run` directly and then register `strategy_watch_run`.
16. Do not route exact or confirmed strategy submission through `sessions_spawn` or `sessions_send`; those tools are only for discovery, supporting analysis, or follow-up work.
17. If the user asks for a Chan chart, call `chan_generate_chart` directly from the front-door agent. This is an immediate chart-generation request for personal or group conversations, not a strategy task run, so it does not need `sessions_send`, task candidate confirmation, or async watch registration. Let the runtime deliver the chart image from tool details, then add a compact Chan-theory reading covering stage, main box/central-zone bounds, and overall structure.
18. Never expose raw internal tool markup or child-session output to the end user. Suppress and ignore any content that looks like:

- `<read ...>`
- `<tool_call> ... </tool_call>`
- `DSML`
- raw XML-like tool wrappers
- internal session/debug scaffolding

19. If internal delegation produces raw tool markup instead of a proper answer, discard it, do not forward it, and continue with a clean structured request path.

## Preferred internal workflow

1. Parse the user request.
2. If the user is asking about Chan chart generation, call `chan_generate_chart` directly and return one chart caption plus a compact Chan-theory reading. Do not call `sessions_send`, do not call `sessions_spawn`, and do not ask `pattern-chan` to answer. The runtime handles image delivery separately.
3. If the user is asking about quotation or market information refreshes, send the request to `agent:pattern-quotation:main` with `sessions_send`. Never use `sessions_spawn` for `pattern-quotation`.
4. If the user is asking about strategy tasks or execution from a Feishu group or DM and has already provided an exact `task_key` or confirmed one candidate, submit directly with `strategy_task_run`.
5. Use the internal `pattern-strategy` agent only for task resolution, status, signal retrieval, or supporting work when the task is not yet exact.
6. If the user did not provide an exact `task_key`, require the internal strategy agent to return the latest live task candidates before any execution attempt.
7. If the internal strategy agent returns `needs_confirmation=true`, ask the user to confirm the intended task and stop there until the user answers.
8. Only after an exact `task_key` is provided or explicitly confirmed should the chosen task be submitted.
9. The first execution turn must stop after formal submission and return:
   - `task_key`
   - `job_id`
   - `status`
   - `request_key`
   - `resolved_window`
   - `overrides`
     These fields are for internal orchestration; do not forward parameter-like fields to Feishu.
10. After the front-door agent has `job_id`, it must acknowledge the run to the user immediately instead of waiting for final strategy completion.
11. If submission fails before a `job_id` is returned, do not say the task was submitted, queued, running, processing, or being executed. Tell the user the strategy task was not accepted and no `job_id` was created, then give the failing layer in one sentence.
12. If the returned status is nonterminal, register async tracking for that `job_id` so completion can be handed back through the main session. Prefer the local watch tool path over waiting in the first turn.
13. If the result later includes candidate symbols and the user needs context or final Feishu packaging, enrich in two stages:

- Stage 1: CANSLIM MCP factor enrichment with `factor_financial_growth`, `factor_margin_balance_change`, and `factor_institution_holder_change`
- Stage 2: non-CANSLIM web context such as heat, retail sentiment, and current narrative through:

- `web_search`
- `web_fetch`
- `browser` when required
- `summarize-pro` for long sources

12. Apply a final context pass with `agent-skills-context-engineering`:

- remove noise
- separate hard signal from market narrative
- rank the final shortlist

13. Return one concise answer to Feishu in the front-door agent voice.

## Quotation Refresh

Treat quotation refresh as a two-phase operational task:

Before this workflow, re-check intent priority. If the request contains Chan chart or chart-generation language such as `chan图`, `缠论图`, `走势结构图`, `生成图`, or `画图`, stop and call `chan_generate_chart` directly instead. A date range alone does not make a request a quotation refresh.

Quotation refresh is exclusive. If the user asks for `行情抓取`, `刷新行情`, `抓行情`, `补行情`, `更新融资融券`, or `跑 quotation`, do only this workflow. Do not also start strategy scans, board-index refreshes, or any `pattern-strategy` child session unless the user explicitly asks for those tasks in the same message.

1. submission phase
   - call the internal `pattern-quotation` agent and require `quotation_refresh_chain` for normal daily refreshes
   - use `chain_key="pre_market"` for prices/events/financials and `chain_key="post_open"` for post-open margin trading
   - pass explicit `stages` only when Feishu asks for a specific quotation stage or historical backfill
   - do not ask the user for date, symbol, adjustment, or worker parameters in the normal flow
   - return `job_id` and initial `message` immediately
2. completion phase
   - use `quotation_refresh_get(job_id)` for progress
   - terminal statuses are `completed`, `partial_failed`, and `failed`
   - when failures exist, use `quotation_refresh_errors(job_id)`
   - directly deliver the remote `message` plus a compact error preview when needed; do not use LLM summarization for quotation terminal status

For Feishu/manual refreshes, set:

- source is inferred as `feishu_manual`
- idempotency uses the canonical daily key returned by `quotation_refresh_chain`

For cron refreshes, set:

- pass only `chain_key`; do not pass or calculate dates, `source`, or `idempotency_key`
- the Pattern backend applies the chain-specific `Asia/Shanghai` date policy and returns the canonical cron key
- forward the exact returned `request_key` and `requested_end_date` to the watcher without recomputing them
- after terminal status, call `automation_run_record` with `category=quotation`, `task_family=<chain_key>`, and `task_key=quotation.refresh_run`

If the Quotation job is still `pending`, `running`, or `pause_requested`, call `quotation_watch_refresh` from the front-door session so the final terminal status can be delivered directly by the plugin.

## Immediate submission rule

Treat strategy execution as a two-phase flow:

1. submission phase
   - resolve the exact `task_key`
   - prepare allowed `overrides`
   - from a Feishu DM or Feishu group, call `strategy_task_run` directly when the task is exact or confirmed
   - for cron, pass only `task_key` and allowed `overrides`; program code prepares the internal submission, and the Pattern backend returns the authoritative `request_key`, `idempotency_key`, and `Asia/Shanghai` `resolved_window`
   - for non-cron submissions, use stable `idempotency_key`, `source`, `requested_by=openclaw_gateway`, `trace_id`, and `trigger_type`
   - let Pattern Strategy handle shared queueing, leases, same-strategy concurrency, and idempotent duplicate detection
   - return `job_id` immediately
2. completion phase
   - use `job_id` as the durable identifier for progress, cancellation, signal lookup, and final synthesis

Do not let the front-door agent confuse:

- an OpenClaw subagent run id
- an OpenClaw session key
- a Pattern Strategy `job_id`

For user-visible progress and final result delivery, `job_id` is the only authoritative execution identifier.

## Async completion rule

Do not block the front-door agent waiting for a strategy run that may take a long time.

Treat `strategy_task_run` as submission only. If the strategy run is still `accepted`, `queued`,
`running`, or `cancelling` after submission:

1. send the user a short acknowledgement that includes `job_id`
2. register local async tracking for that `job_id`
3. stop the LLM turn; do not poll status in a loop
4. let the code-driven watcher monitor status outside the LLM
5. once the watcher reaches `succeeded`, it fetches signals and classifies them
6. only actionable, non-fallback signals should trigger enrichment/synthesis
7. do not call DS, CANSLIM factor tools, web research, or enrichment tools before that actionable terminal signal exists
8. fallback-only results should be delivered as deterministic execution notices without DS

Terminal statuses are `succeeded`, `failed`, `cancelled`, `canceled`, and `timeout`. Gateway
does not force-kill a long-running strategy task; PI owns heartbeat, lease, timeout, queueing,
same-strategy concurrency, logs, and artifact isolation.

For scheduled strategy submissions:

- submit normal cron with only `task_key` and allowed `overrides`; the Pattern backend's returned `request_key`, `idempotency_key=cron-{strategy-alias}-{yyyy-mm-dd}`, and `resolved_window` are authoritative and must be forwarded to the watcher unchanged
- repeated cron submissions for the same task and market date receive the same canonical backend key
- Gateway recovery after PI reports `timeout` or `failed` uses `trigger_type=gateway_recovery`; forward the backend's canonical recovery identity instead of constructing it in the prompt
- do not use random idempotency keys for cron
- do not call `strategy_cancel_run` to preempt a prior scheduled run; use it only for explicit human cancellation

Do not use subagent self-reported progress as a substitute for Pattern Strategy job status.
OpenClaw subagent announce is best-effort; it is not the same thing as durable strategy job tracking.

## Internal delegation pattern

Use this shape for internal delegation:

- use delegation for ambiguous strategy names, live candidate resolution, status/signal lookup, or enrichment work
- do not spawn a `pattern-strategy` child merely to submit an exact or confirmed strategy task from a Feishu DM or Feishu group
- if a suitable internal session already exists, use it directly with `sessions_send`
- only if no suitable child session exists, call `sessions_spawn`
- when spawning a child for internal setup, set `expectsCompletionMessage=false`; otherwise the child result can be mirrored directly to Feishu before the front-door agent sanitizes it
- set `agentId` to one of:
  - `pattern-strategy`
  - `market-research`
  - `market-memory`
- give the child a short `label`
- use `task` only to establish the child session for discovery, status lookup, signal retrieval, or enrichment
- when spawning only for setup, set `expectsCompletionMessage=false` so raw child output is never mirrored to the end user
- then use `sessions_send` with `timeoutSeconds > 0` for the real structured request when you need a result back in the current turn

Examples:

- spawn `pattern-strategy` with a task like:
  - `Open an internal Pattern Strategy working session for task discovery and status lookup.`
- spawn `pattern-strategy` with:
  - `expectsCompletionMessage=false`
- spawn `pattern-strategy` with a task like:
  - `Prepare to resolve live task candidates and inspect existing strategy runs.`
- spawn `pattern-strategy` with:
  - `expectsCompletionMessage=false`
- send to `pattern-strategy` with a message like:
  - `The user said "mid_term_accel". Resolve live candidates from strategy_task_list. If the user did not provide an exact task_key, return candidates plus needs_confirmation=true instead of executing.`
- send to `pattern-strategy` with a message like:
  - `Using job_id claw_xxx, fetch the current run status only. Return job_id, status, progress, and message.`
- send to `pattern-strategy` with a message like:
  - `Using job_id claw_xxx, fetch final signals and return a compact structured summary suitable for later web enrichment.`
- call `strategy_watch_run` from the front-door session with arguments like:
  - `job_id=claw_xxx`
  - `task_key=strategy.mid_term_accel.daily_scan`
  - `idempotency_key=<exact value returned by strategy_task_run>`
  - `source=<exact value returned by strategy_task_run>`
  - `requested_by=<exact value returned by strategy_task_run>`
  - `trace_id=<exact value returned by strategy_task_run>`
  - `trigger_type=<exact value returned by strategy_task_run>`
  - `wake_mode=now`
  - `enrich_signals=true`
- spawn `market-research` with a task like:
  - `For these symbols, first build CANSLIM context from factor MCP tool outputs, then collect non-CANSLIM heat and retail sentiment using web_search, web_fetch, and browser only when needed.`

When delegation is actually needed, do not use a made-up session key or label as a substitute for spawning. If no child session exists yet, create one with `sessions_spawn`.
Do not skip live tools by reading local files or by answering from remembered examples.

## Front-Door Discipline

The Feishu-facing front-door agent is not a documentation explorer.

It must not:

- delegate file-reading chores to subagents
- ask subagents to read `SKILL.md`
- ask subagents to inspect `/app/docs`
- ask subagents what tools they have
- mirror child-session scratch output to the user

It must:

- submit exact or confirmed strategy execution requests through `strategy_task_run`
- use live Pattern Strategy status/signal tools for `job_id` lookups
- use the internal `pattern-strategy` session only for unresolved candidate discovery or supporting work
- keep user-facing replies short
- return only actionable confirmations, job ids, statuses, signals, and final summaries

## Strategy confirmation contract

When the user asks to run a strategy but does not provide an exact `task_key`, the internal `pattern-strategy` agent should return a structured candidate result for the front-door agent to present back to the user.

Preferred shape:

- `intent`: `run_strategy`
- `raw_query`: the user-supplied strategy phrase
- `candidates`: array of matched live task templates
- `needs_confirmation`: `true`
- `suggested_task_key`: optional best candidate when confidence is high
- `suggested_overrides`: optional parsed overrides such as `time_window.start_date` and `time_window.end_date`

The front-door agent should then ask the user to confirm one candidate by `task_key` or by ordinal number.

Example front-door confirmation:

- `我识别到你可能要执行以下任务，请确认：`
- `1. strategy.mid_term_accel.daily_scan`
- `2. strategy.mid_term_reversal_opt.daily_scan`
- `请回复“确认执行 1”或直接回复完整 task_key。`

If there is exactly one strong candidate, still prefer confirmation unless the user already supplied the exact `task_key`.

## CANSLIM And Sentiment Enrichment Policy

Apply this layer only after Pattern Strategy returns securities with formal strategy signals via `strategy_get_signals`. CANSLIM, sentiment, heat, and news are supplementary context; they must not replace, override, filter, or be presented as the strategy signal itself.

Use the `canslim-enrichment` skill as the detailed contract for this stage. The required order is:

1. Re-fetch or request full formal signals for the `job_id` when the async callback only contains a compact preview.
2. Extract up to 50 symbols per batch.
3. Call the Pattern Strategy factor MCP tools before web research:
   - `factor_financial_growth` for current quarterly growth and partial annual context
   - `factor_margin_balance_change` for financing balance demand context
   - `factor_institution_holder_change` for focused institutional sponsorship and supply/demand context
4. Preserve each factor tool's `coverage.status`, `coverage.observations`, and `coverage.missing_reason`. Treat missing or insufficient data as an information gap, not a bearish factor.
5. Build a CANSLIM supplement for C/A/N/S/L/I/M. Only C, S, and I should rely primarily on MCP factor tools. N, L, and M may require public information; A may be partial unless annual evidence is available.
6. After CANSLIM factor context is assembled, use `web_search` to discover non-CANSLIM public sentiment, heat, and narrative sources from the last month.
   - Use `freshness: "pm"` for the last month when the search provider supports it.
   - For Chinese securities/news searches, prefer `country: "CN"` and omit `search_lang` unless the active OpenClaw web tool accepts the provider-specific Chinese language code.
7. Prioritize these sources when available:
   - finance.baidu.com
   - official company disclosures, exchange announcements, and company sites
   - 财联社, 证券时报, 中国证券报 and similar professional media
   - 股吧 / 东方财富股吧
   - 雪球
   - 微博
8. `finance.baidu.com` has higher priority than Xueqiu. Xueqiu is useful for heat and retail tone, but it should not outrank Baidu Finance or official/professional sources for factual context.
9. Prefer newer sources over older sources. When two sources conflict, treat the newer source as more relevant unless the older source is clearly more authoritative.
10. Use `web_fetch` on raw result URLs to extract article/body text. Use `browser` only when the page is dynamic or `web_fetch` cannot extract useful content.
11. Classify non-CANSLIM sentiment as:

- optimistic: positive catalysts, constructive market discussion, improving expectations, institutional attention, strong business/industry narrative
- pessimistic: negative news, controversy, deteriorating expectations, selloff discussion, weak industry narrative, regulatory or financial concern
- mixed/weak: sparse, conflicting, stale, or low-confidence evidence

12. The final response should clearly separate:

- strategy signal: what Pattern Strategy found
- CANSLIM supplement: structured factor and public context
- non-CANSLIM sentiment/heat supplement: retail mood, attention, and crowding
- caveat: CANSLIM and sentiment are not replacements for the strategy signal

If a final Feishu summary is missing after a valid `job_id` already exists, treat that as an orchestration failure:

- first recover by querying `strategy_get_run(job_id)`
- if the run succeeded, immediately query `strategy_get_signals(job_id)`
- then perform Stage 1 CANSLIM factor enrichment followed by Stage 2 web sentiment/heat enrichment
- do not tell the user that the result is unavailable until the live `job_id` path has been checked

## Heat Positioning

Add a heat-positioning layer when the user wants enrichment, prioritization, or context on whether a name is crowded, hot, or relatively ignored.

Heat positioning is supplementary context. It must not replace the strategy signal.

Use the following comparison order:

1. Self-history
   - Compare recent discussion / mention intensity versus the name's own visible baseline when the source makes that possible.
   - Classify as: `below normal` / `normal` / `warming` / `hot`.
2. Peer comparison
   - Compare against a small set of relevant industry or theme peers.
   - For semiconductor-material / photoresist / CMP cases, prefer direct chain peers instead of unrelated large caps.
   - Classify as: `low` / `mid` / `mid-high` / `high` within peers.
3. Market-wide framing
   - State whether the name looks like a local sector mover or a broad market heat core.
   - Do not overstate market-wide heat unless evidence is clear.

Preferred evidence sources:

- Baidu Finance (`finance.baidu.com`) for:
  - finance/news aggregation around the symbol
  - recent professional media links and factual context
- Xueqiu dynamic page via `browser` for:
  - follower / watcher count
  - current discussion flow
  - post tone and recency
- Eastmoney Guba / related forums for:
  - discussion bursts
  - retail concern topics
- `web_search` result density and recency for:
  - recent article volume
  - whether multiple sources are discussing the same catalyst

Practical output rules:

- If a name has active discussion and positive catalysts but is not the highest-attention peer, describe it as:
  - `heat warming`
  - `mid` or `mid-high` within peers
  - `not the top market heat core`
- If a name has very high follower count, dense same-day discussion, and strong catalyst concentration, describe it as:
  - `hot`
  - `high within peers`
  - `possibly a sector heat core`

## Output contract

The user-facing reply should usually contain:

- what task ran or what data was checked
- current status or result count
- the shortlisted symbols or top signals
- a brief reason for each shortlisted item
- a short heat-positioning line when relevant
- any caveats, such as stale data, missing context, or incomplete research

## Guardrails

- Do not expose raw internal agent chatter to the user.
- Do not let internal workers speak directly to Feishu.
- Do not describe market narrative as a substitute for the formal strategy signal.
- Do not expose strategy construction details or parameter-like signal feedback to the user.
- If research evidence is weak or mixed, say so explicitly.
