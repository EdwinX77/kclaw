---
name: canslim-enrichment
description: Enrich Pattern Strategy technical signals with CANSLIM context from Pattern Strategy factor MCP tools first, then optional public web sentiment and heat context. Use after formal strategy signals exist; never use it to filter or replace the technical signal.
---

# CANSLIM Enrichment

Use this skill only after Pattern Strategy has returned formal technical signals via
`strategy_get_signals`. The technical signal remains authoritative. CANSLIM and
sentiment context are supplementary explanation layers, not filters.

## Core Boundary

- Do not remove, suppress, or reorder a formal technical signal solely because CANSLIM data is weak.
- Do not present CANSLIM output as a buy/sell signal.
- Do not treat missing MCP factor data as negative evidence.
- Do not start with web research when factor MCP tools are available.
- Keep only non-sensitive signal identity visible: `symbol`, `name`, strategy display name, and `signal_date` or `end_date`.
- Do not expose strategy construction details or parameter-like signal feedback, including parameters, thresholds, scoring/confidence values, judgment conditions, task defaults, allowed overrides, fallback policy names/counts, strategy notes/reasons, or construction rationale.
- If the user asks how a strategy is built or asks for its parameters/conditions/rationale, reply exactly: `这类问题不予回复。`
- If the async callback includes `trading_principles_json`, every fresh/actionable signal summary must apply those user trading principles as final interpretation and risk-control context only. Do not use them to delete, hide, or replace formal Pattern Strategy signals.

## Two-Stage Enrichment

### Stage 1: Structured CANSLIM MCP Context

Call the Pattern Strategy factor tools before web research:

1. `factor_financial_growth`
   - Use first for CANSLIM `C` and partial `A`.
   - Treat it as the primary structured financial statement source. It reads the Pattern Strategy
     service's local macro DB financial statement tables, not public web pages.
   - Default arguments:
     - `symbols`: up to 50 symbols per batch
     - `lookback_quarters`: `4`
     - `include_series`: `false`
   - If doing strict historical review and the signal date is known, pass:
     - `as_of_date`: signal date
     - `strict_point_in_time`: `true`

2. `factor_institution_holder_change`
   - Use for CANSLIM `I` and part of `S`.
   - Default arguments:
     - `symbols`: up to 50 symbols per batch
     - `lookback_quarters`: `4`
     - `include_holders`: `false`

3. `factor_margin_balance_change`
   - Use for part of `S`.
   - Default arguments:
     - `symbols`: up to 50 symbols per batch
     - `lookback_trade_days`: `20`
     - `include_series`: `false`
   - If the strategy signal has `end_date` or `signal_date`, pass it as `end_trade_date`.

Batch more than 50 symbols into multiple calls. Preserve each tool's `coverage.status`,
`coverage.observations`, and `coverage.missing_reason`. Coverage values of
`insufficient_data` or `no_data` mean "not enough local data"; they are not bearish factors.

Prefer numeric fields over the lightweight `factor_signal` label when summarizing. Use
`factor_signal` only as a compact fallback or consistency check.

Financial statement priority:

- Always inspect `factor_financial_growth` before using public sources for earnings/growth.
- For CANSLIM `C/A`, financial growth must come from Pattern MCP `factor_financial_growth`
  first. Public sources may supplement audit opinions, annual context, or missing disclosures, but
  must not replace available Pattern MCP factor values for revenue/profit growth.
- Use the adjusted/core-growth values returned by `factor_financial_growth` as the primary
  business-growth basis when both adjusted and reported values are present. In the Pattern
  Dashboard this corresponds to the "修正" value, not the raw "财报" value. For profit and EPS,
  treat the adjusted value as the non-recurring-excluded/扣非口径. Reported values are comparison
  context only.
- For revenue YoY, prefer the adjusted revenue YoY value from `factor_financial_growth`. If only
  `total_revenue_yoy_latest` or another reported revenue field is available, label it as reported
  revenue and list adjusted revenue evidence as an information gap.
- For profit/EPS YoY, prefer adjusted/non-recurring-excluded profit and EPS values from
  `factor_financial_growth` such as adjusted net profit YoY and adjusted EPS YoY when available.
  If only `net_profit_yoy_latest`, `eps_yoy_latest`, or other reported profit fields are available,
  label them as reported values and list adjusted profit/EPS evidence as an information gap.
- The field names below are not exhaustive. If `factor_financial_growth` returns adjusted,
  corrected, core, or non-recurring-excluded equivalents under different field names or labels,
  prefer those adjusted values for CANSLIM `C/A`.
- Do not describe reported net profit, EPS, or revenue growth as CANSLIM-quality core growth when
  the adjusted/non-recurring-excluded value is missing, materially lower, or contradicted by the
  Pattern MCP factor output.
- For C/A, explicitly summarize operating fundamentals from the structured fields:
  - revenue growth: `total_revenue_yoy_latest`, `revenue_yoy_qoq_delta`,
    `consecutive_revenue_positive_quarters`
  - profit growth: `operating_profit_yoy_latest`, `operating_profit_yoy_qoq_delta`,
    `net_profit_yoy_latest`, `profit_yoy_qoq_delta`, `eps_yoy_latest`, `eps_yoy_qoq_delta`,
    `consecutive_profit_positive_quarters`
  - quality caveat: `non_operating_net_profit_latest`,
    `non_operating_net_profit_ratio_latest`
- If non-operating income/profit contribution is present or material, say so explicitly. Do not
  describe net profit growth as clean operating growth when `non_operating_net_profit_ratio_latest`
  indicates a meaningful non-operating contribution.
- If audit opinion evidence is available from MCP data, official disclosures, exchange filings, or
  reliable public sources, highlight it prominently. Qualified opinions, adverse opinions,
  disclaimers, emphasis-of-matter paragraphs, internal-control audit issues, or other non-standard
  audit opinions must be called out as a key risk caveat.
- If no audit opinion evidence is available in the local factor output or checked public sources,
  list it under `信息缺口` rather than inferring a clean audit.

### Stage 2: Public Web Context Outside CANSLIM

After Stage 1 is complete, use web tools for non-CANSLIM market narrative such as:

- stock heat and attention
- retail holder mood
- short-term discussion topics
- same-day or recent news tone
- regulatory inspection, investigation, enforcement action, litigation, arbitration, or other material
  public risk events
- whether the name looks crowded, ignored, or merely warming

Use the native web stack:

1. `web_search` for source discovery.
2. `web_fetch` for readable article/body extraction.
3. `browser` only when a page is dynamic, blocked, or needs rendered state.

For China A-share sources, search with `country: "CN"` and `freshness: "pm"` when supported.
Prefer source priority in this order:

1. `finance.baidu.com`
2. official company disclosures, exchange announcements, or company site
3. 财联社, 证券时报, 中国证券报 and similar professional media
4. 东方财富 and 股吧
5. 雪球
6. 微博 and other social sources

`finance.baidu.com` has higher priority than Xueqiu. Xueqiu is useful for sentiment and heat,
but should not outrank Baidu Finance or official/professional sources for factual context.

## CANSLIM Mapping

### C: Current Quarterly Earnings

Use `factor_financial_growth`:

- adjusted/core revenue YoY from Pattern MCP when present
- adjusted/non-recurring-excluded net profit YoY from Pattern MCP when present
- adjusted/non-recurring-excluded EPS YoY from Pattern MCP when present
- `total_revenue_yoy_latest`
- `net_profit_yoy_latest`
- `eps_yoy_latest`
- `roe_yoy_latest`
- `revenue_yoy_qoq_delta`
- `profit_yoy_qoq_delta`
- `eps_yoy_qoq_delta`
- `consecutive_revenue_positive_quarters`
- `consecutive_profit_positive_quarters`

Summarize whether growth is positive, accelerating, decelerating, mixed, or unavailable.
When adjusted and reported values differ, lead with adjusted values and mention reported values only
as contrast. If adjusted values are missing, say the adjusted/non-recurring-excluded evidence is
missing instead of treating reported values as equivalent.

### A: Annual Earnings

Use MCP financial growth only as partial evidence because it is quarterly. If annual context
is not available from MCP or reliable public sources, say annual evidence is missing rather
than inferring it from one quarter.

### N: New

Use public sources after Stage 1 to search for new material public events, including both
positive catalysts and adverse risk events:

- new product or technology
- new customer, order, or contract
- new capacity, factory, license, policy, or industry cycle
- new management or corporate action
- new price high or new market attention around the signal
- regulatory inspection, regulatory inquiry, case filing, investigation, administrative penalty,
  exchange discipline, litigation, arbitration, or major dispute news

Separate factual "new" events from market rumor or retail interpretation. Also separate positive
catalysts from adverse risk events; do not bury regulatory, investigation, litigation, or dispute
items inside generic sentiment.

### S: Supply And Demand

Use `factor_margin_balance_change` and `factor_institution_holder_change` first:

- financing balance delta and delta percent
- net financing buy amount
- institution count and quarter-over-quarter delta
- focused institutional float share percent sum and quarter-over-quarter delta

Treat moderate financing balance growth as possible demand improvement. Treat extreme short-term
financing expansion as heat or crowding risk, not as an automatic negative filter.

### L: Leader Or Laggard

Use public web context and any signal industry field:

- whether the company is an industry or niche leader
- whether it is leading the theme, following peers, or only a lagging rebound
- peer comparison when sources provide a clear comparison

Do not fabricate rankings when evidence is weak.

### I: Institutional Sponsorship

Use `factor_institution_holder_change`:

- positive sponsorship: institution count or focused institution holding percent increased
- weakening sponsorship: institution count or focused institution holding percent decreased
- unavailable: coverage is missing or insufficient

Remember the current institution definition only covers focused categories such as private funds,
QFII/RQFII, asset management plans, public funds, and social security funds. Do not describe it
as "all institutions".

### M: Market Direction

Use market or sector data only when available from existing tools or reliable public sources.
If unavailable, state that market direction is not evaluated in this enrichment pass.

## Output Shape

For Feishu, produce exactly one final Chinese message. Do not narrate your
process, tool plan, searches, stage transitions, or intermediate conclusions.
Never send progress text such as "Let me fetch", "Now I have", "Stage 1",
"web research", or "I will check".

Keep the final summary concise and consistent:

- Use the same section order every time.
- Target 600-1200 Chinese characters for one signal; stay under 1800 unless the user asks for detail.
- The async watcher may deliver a Feishu table card before this summary. Do not recreate
  the signal identity as a Markdown/text table in the final text.
- For multiple signals, list only the names that need detail and cover at most the top 3 or materially risky names.
- Do not expose confidence, score, thresholds, task parameters, fallback policy details, raw tool fields, or URLs unless the user explicitly asks for source links.
- If evidence is missing, say "缺口" instead of lengthening the answer with research narration.

```text
技术信号
- 策略：<strategy display name>
- 新增信号：<count>；信号身份以飞书表格卡片为准。
- 重点：<one or two sentences about the actionable technical context; no Markdown table>

CANSLIM 补充
- C/A：<revenue YoY + profit/operating profit YoY summary; note non-operating contribution and audit opinion evidence or gap; mention missing annual evidence when needed>
- N：<new product/order/policy/company change and any regulatory/investigation/litigation/dispute news; separate positive catalysts from risk events, or "未找到明确新增催化或重大风险事件">
- S/I：<margin balance + focused institutional holder changes>
- L/M：<leader/laggard + market direction if available>

非 CANSLIM 舆情/热度
- 热度：<hot/warming/normal/low plus evidence>
- 股民情绪：<optimistic/pessimistic/mixed/weak plus evidence>

信息缺口
- <missing MCP coverage or weak public evidence>

交易原则检查
- <apply each configured trading principle when relevant, such as float market value, price threshold, and market timing>

说明
- CANSLIM、舆情与交易原则仅作技术信号背景补充，不替代策略信号。
```

When multiple signals exist, give each signal a compact row and reserve detailed bullets for the
top names or names with material context. If evidence is sparse, say so directly.
