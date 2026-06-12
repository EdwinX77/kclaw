---
name: strategy-review
description: Review securities strategy signals, backtests, execution readiness, and daily risk attribution without issuing real trade orders.
---

# Strategy Review

Use this skill for securities strategy review, signal evaluation, backtest interpretation, post-trade style attribution, and daily strategy recap.

## Operating Rules

- Treat all outputs as research and operational review, not personalized investment advice.
- Separate observed market data, formal strategy output, agent interpretation, and human-confirmation items.
- Do not invent fills, orders, positions, PnL, or execution status. If a source is missing, say it is missing.
- For any actionable-looking signal, include risk context: liquidity, market regime, volatility, event risk, and invalidation conditions.
- Prefer concise tables for multi-symbol reviews and short prose for conclusions.

## Review Shape

1. State the reviewed universe, date/time window, and data source.
2. Summarize strategy status: run id, terminal/nonterminal state, signal count, and failures.
3. Rank signals by strength only when the source provides enough comparable evidence.
4. Flag conflicts between price action, fundamentals, liquidity, and macro context.
5. End with a review checklist: confirm, watch, defer, or reject.
