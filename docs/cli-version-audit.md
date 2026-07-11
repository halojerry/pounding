# CLI Version Audit (2026-07-11)

Full audit of the 5 managed CLI agents' sourcing, version pins, and ACP
compatibility. Performed during v0.1.44 upstream sync; corrections applied
around the same time.

## Dual-Runtime Architecture

The backend has two parallel runtime systems whose versions must stay aligned:

| Layer | claude / codex | hermes / opencode / openclaw |
|---|---|---|
| ACP bridge | `acp_tool_runtime` — npm → Rust `prepare-managed-resources` | — |
| Native CLI | — | `native_cli_runtime` — npm/pip or system PATH; order: (1) PATH, (2) installed managed-root, (3) bundled `cli/{slug}/{version}/` |
| Frontend installer | `managedCliInstallerBridge.ts` (bun/npm install, no version pin → gets latest) |

There is also a **hardcoded GitHub download fallback** (for `native_cli`) pointing at `halojerry/poundingcore/releases/download/native-cli-{slug}-v{version}` — this release type **has never been produced by any CI workflow** and always 404s. It fires only in dev mode when the CLI is not on PATH and not bundled.

## Per-Agent Reference

| Agent | Package(s) | Source | POUNDING Rust `version()` | Vendor pin |
|---|---|---|---|---|
| Claude | (a) `@agentclientprotocol/claude-agent-acp` (ACP bridge), (b) `@anthropic-ai/claude-code` (CLI) | (a) npm, (b) official `claude.ai/install.sh` standalone binary | `0.39.0` (acp_tool) | ACP `0.39.0`, CLI `2.1.195` |
| Codex | (a) `@zed-industries/codex-acp` (ACP bridge), (b) `@openai/codex` (CLI) | (a) npm (Zed), (b) npm (OpenAI) | `0.16.0` | ACP `0.16.0`, CLI `0.142.3` |
| OpenCode | `opencode-ai` | npm (`anomalyco/opencode`) | `1.17.18` | `1.17.18` |
| Hermes | `hermes-agent[acp]` | PyPI (Nous Research) | `0.18.2` | `0.18.2` |
| OpenClaw | `openclaw` | npm (`openclaw`) | `2026.6.11` | `2026.6.11` |

## Version Correction History

All three `native_cli_runtime` version pins were `"0.1.0"` since the fork's
inception. That version:

- **hermes**: did not exist on PyPI (latest = `0.18.2`, `0.1.0` was fictional)
- **opencode**: was a three-year-old ancient release (latest = `1.17.18`)
- **openclaw**: did not exist on npm (`ETARGET` — vendor `npm install openclaw@0.1.0` always silently failed via `|| return 0`)

`CLAUDE_ACP_VERSION` in `prepare-vendor.sh` was `0.52.0` while Rust
`acp_tool` pinned `0.39.0` — the vendor's ACP copy is not consumed by the
bundle (Rust's `prepare-managed-resources` generates the real ACP), but the
discrepancy was confusing. Aligned vendor → `0.39.0`.

### Related Commits

- AionCore `1f774d16`: Rust `native_cli_runtime/types.rs` version pins updated
- AionUi `e5403ed70`: `prepare-vendor.sh` vendor pins aligned with Rust

## Key Structural Notes

- **Codex is the only fully-working native CLI end-to-end** — ACP version
  consistent between Rust and vendor at `0.16.0`.
- **Claude's official distribution** now uses `curl claude.ai/install.sh`
  (standalone binary from `downloads.claude.ai`), NOT npm for the CLI. The
  ACP bridge (`@agentclientprotocol/claude-agent-acp`) remains the correct
  POUNDING mechanism.
- **OpenCode `acp` subcommand** verified working at v1.17.18
  (`opencode acp — start ACP (Agent Client Protocol) server`). Structure
  unchanged (Native binary, `runtime_kind=Native`).
- **OpenClaw** requires Node ≥22.19 (hard-coded min in `openclaw.mjs`). Uses
  `openclaw acp`; still needs Gateway daemon at `127.0.0.1:18789`.
- **Hermes `[acp]` extra** confirmed intact at v0.18.2
  (`agent-client-protocol==0.9.0`).

## Known Gaps (Not Addressed by Version Correction)

- **Hermes bundled-mode path**: vendor puts hermes under `runtimes/hermes`
  (no version segment) but Rust bundled lookup expects
  `cli/hermes/{version}/`. Bundled-mode hermes will not resolve. This is a
  pre-existing architectural inconsistency independent of version pins.
- **Native-cli dead-link fallback**: the GitHub download URL
  `native-cli-{slug}-v{version}` has never been produced by any CI. It only
  fires in unbundled dev mode when the CLI is not on PATH. The error message
  is misleading (404 on a nonexistent release) — should be a clear install
  instruction.
- **Frontend installer** (`managedCliInstallerBridge.ts`) does not pin
  versions — it installs whatever npm/pip latest gives. This means dev
  installs and vendor builds may use different versions over time unless
  the vendor script pins are regularly updated.

## Relevant Files

- `AionCore/crates/aionui-runtime/src/native_cli_runtime/types.rs:27-33` — `version()` pins
- `AionCore/crates/aionui-runtime/src/native_cli_runtime/mod.rs:36-44` — download URL template + bundled lookup
- `AionCore/crates/aionui-runtime/src/native_cli_runtime/mod.rs:227-248` — `entrypoint_path` + `runtime_kind` dispatch
- `AionCore/crates/aionui-runtime/src/acp_tool_runtime/types.rs:21-25` — ACP tool `version()` pins
- `AionCore/crates/aionui-db/migrations/014_native_cli_managed_tools.sql` — `args: ["acp"]` seed
- `AionCore/crates/aionui-ai-agent/src/registry.rs:1170` — `cli_dir` bundled probe
- `AionCore/crates/aionui-ai-agent/src/factory/acp.rs:440-500` — native CLI spawn + env setup
- `AionUi/scripts/prepare-vendor.sh:297-301` — vendor `*_VERSION` pins
- `AionUi/scripts/prepare-vendor.sh:304-360` — `vendor_cli_one` (npm install + path)
- `AionUi/scripts/prepare-vendor.sh:464-570` — `vendor_hermes` (Python venv)
- `AionUi/packages/desktop/src/process/bridge/managedCliInstallerBridge.ts:740-862` — frontend installer
