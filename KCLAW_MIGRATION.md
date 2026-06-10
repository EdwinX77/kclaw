# KClaw Migration Notes

KClaw is an isolated local solution built from:

- OpenClaw framework baseline: `v2026.6.5`
- MyClaw local overlay: Pattern Strategy, Pattern Quotation, selected local skills, and Docker service helpers

The first migration phase keeps the package and CLI name as `openclaw` to avoid introducing rename risk while framework compatibility is being validated.

## Source Boundaries

- Framework code comes from upstream OpenClaw `v2026.6.5`.
- Local business plugins are copied from `myclaw`:
  - `extensions/pattern-strategy`
  - `extensions/pattern-quotation`
- Local skills copied from `myclaw`:
  - `skills/agent-skills-context-engineering`
  - `skills/summarize-pro`
  - `skills/web-research-assistant`
- Docker helpers copied from `myclaw`:
  - `scripts/docker/openclaw-docker-common.sh`
  - `scripts/docker/openclaw-selfcheck.sh`
  - `scripts/docker/openclaw-service.sh`
  - `config/kclaw/docker-compose.override.example.yml`

The repository root `docker-compose.override.yml` is intentionally ignored by upstream OpenClaw and should remain a local runtime file. Copy `config/kclaw/docker-compose.override.example.yml` to `docker-compose.override.yml` only inside a validation checkout that is meant to run KClaw.

## Config Policy

Do not commit real runtime config or credentials.

The old MyClaw runtime config at `.openclaw-runtime/openclaw.json` should be migrated into a new, local-only KClaw state directory after validation. Treat these as runtime data, not repository source:

- `.env`
- `.openclaw-runtime/openclaw.json`
- credentials and auth profiles
- session stores
- pairing stores
- generated workspace data

## Docker Runtime Policy

MyClaw is Docker deployed. KClaw must therefore validate with an isolated Docker runtime before production cutover.

Use a separate runtime directory and ports for the first KClaw run. Do not mount the current MyClaw `.openclaw-runtime` directory into KClaw until the custom plugins and gateway startup are verified.

Recommended validation layout:

```sh
OPENCLAW_IMAGE=kclaw:local
OPENCLAW_CONFIG_DIR=/home/edwin/workspace/kclaw/.runtime/openclaw
OPENCLAW_WORKSPACE_DIR=/home/edwin/workspace/kclaw/.runtime/openclaw/workspace
OPENCLAW_GATEWAY_PORT=18889
OPENCLAW_BRIDGE_PORT=18890
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_TZ=Asia/Shanghai
```

Runtime migration order:

1. Start KClaw with an empty isolated `.runtime/openclaw` directory.
2. Copy only a redacted/test version of `openclaw.json` into that directory.
3. Validate custom plugins are discovered.
4. Validate Docker gateway startup and health checks.
5. Migrate production runtime data only after a successful dry run.

Manual dependency install command if Codex/network installation fails:

```sh
cd /home/edwin/workspace/kclaw
pnpm install
```

If the same registry timeout repeats, retry from a normal interactive shell where registry/network/proxy settings are available. The failed Codex-run command was `pnpm install`; the actionable error was registry tarball download timeout (`[23] The operation was aborted due to timeout`).

## Provider Migration Notes

OpenClaw `v2026.6.5` has integrated newer official provider plugins for Google, Qwen, and MiniMax. Do not blindly copy old `google-gemini-cli-auth`, `qwen-portal-auth`, or `minimax-portal-auth` plugin source unless a validation step proves a required local behavior is missing.

Expected mapping:

- `google-gemini-cli-auth` -> official `extensions/google` provider `google-gemini-cli`
- `qwen-portal-auth` -> official `extensions/qwen` provider `qwen-oauth` / aliases
- `minimax-portal-auth` -> official `extensions/minimax` provider `minimax-portal`

## BlueBubbles Note

OpenClaw `v2026.6.5` removed BlueBubbles support and documents migration to the `imessage` path. If a MyClaw runtime config uses `channels.bluebubbles`, migrate that runtime config to `channels.imessage` before production cutover.

## Validation Order

1. Install dependencies in the KClaw repository.
2. Run focused type/test checks for `pattern-strategy` and `pattern-quotation`.
3. Validate plugin discovery for both custom plugins.
4. Start the gateway on an isolated port/state directory.
5. Migrate a redacted test copy of runtime config.
6. Only after validation, plan production cutover from MyClaw to KClaw.

## Cutover Guardrails

- Keep MyClaw running until KClaw passes isolated validation.
- Use a separate state directory and gateway port during testing.
- Do not reuse live credentials until plugin discovery, build, and gateway startup are confirmed.
- Keep MyClaw as rollback until the KClaw gateway has handled representative Pattern Strategy and Pattern Quotation flows.
