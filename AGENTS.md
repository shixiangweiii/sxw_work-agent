# Repository Guidelines

## Project Identity & Sources of Truth

**Project Atlas** is this Work Agent project's communication codename only; do not rename existing `workagent` / `@workagent/*` code, paths, packages, modules, or types. Build this learning-first Agent Harness to turn user goals into observable, recoverable, verified outcomes—not to clone an office suite or maximize features. Use `方案讨论/WorkAgent目标定位与技术架构三次对焦讨论进展.md` for goals, `架构设计/WorkAgent架构设计_V20260823_05.md` for implementation semantics, and the Roadmap for sequencing.

## Project Structure & Roadmap

This npm-workspaces TypeScript ESM monorepo implements Layer 3 in `packages/harness-runtime/`; fakes live in `packages/testkit/`, SQLite storage in `packages/store-sqlite/`. Provider shapes belong in `adapters/shape-anthropic-messages/`, endpoint behavior in `adapters/endpoint-profiles/`, **Case-agnostic general tools in `tools/common/` (`@workagent/tools-common`)**, and the generic external MCP client in `tools/mcp/` (`@workagent/tools-mcp`). Measurement-only tools stay in `cases/micro-cases/`. `apps/cli/` is the single Composition Root plus CLI and verification; `apps/workagent-service/` is Layer 2, and `apps/workagent-ui/public/` is the build-free Layer 1 UI. `spikes/` is excluded; `sxw_aicoding/` holds design evidence. Stages 1–3.5 are complete; Stage 4 currently includes the white-box UI, workspace switching, external MCP/browser capability, orthogonal approval/execution modes, and configurable per-Run budgets. Case 02 counterexample work is still pending.

Stage 3 added the `tools/` layer, so the dependency direction is now `apps → packages / adapters / cases / tools`, and `cases → tools` is allowed (Case packages may reuse general tools). Two directions are forbidden and each has a boundary grep: `packages/` and `adapters/` must not import `@workagent/tools-*`, and `tools/` must not import any Case package — a general tool that depends on one Case is no longer general, and nothing in the code shows it. MCP protocol/process code must remain in `tools/mcp/`, never in Runtime or adapters (boundary 12). Every tool file header must declare its class: a scene tool lists its office/code/chat use cases; a mechanism tool names the Harness mechanism it serves and what breaks without it. Run `npm run verify:tools` to check these boundaries mechanically.

External MCP is intentionally generic: no production code recognizes Playwright tool names or schemas. Entrypoints connect enabled local stdio servers and finish `tools/list` before `compose()`, then freeze the resulting snapshots into each RunSpec. The service owns one MCP runtime across Runs and workspace switches; therefore server `cwd` is fixed at service startup even if the active workspace later changes. The default config is `.workagent-state/mcp.json`; `--mcp-config <path>` overrides it, and a missing file is not an error. The checked-in example uses `@playwright/mcp@latest`. Treat selecting that config as host-user code-execution authorization: MCP processes start before any Run or approval, are outside the Atlas sandbox/workspace boundary, and per-call approval constrains model-requested `tools/call` only—not autonomous server behavior.

## Build, Test, and Development Commands

- `npm ci`: install locked workspace dependencies.
- `npm run typecheck`: run strict TypeScript checks; no build step emits files.
- `npm run ui`: start the white-box service/UI; use this for browser MCP work because the service keeps the MCP process alive across Runs.
- `npm run dev -- --task "list files and write summary.txt"`: run the headless CLI. While a Run is going, typing a line and pressing Return injects it into the next turn.
- `cp mcp.example.json .workagent-state/mcp.json`: enable the Playwright MCP example. It uses `@latest`; review the command and its host-level privileges before enabling it.
- Both production entrypoints accept `--workspace <path>`, `--endpoint bailian|deepseek`, `--mcp-config <path>`, `--approval confirm|default|auto`, and `--sandbox on|off`. Approval and execution privilege are orthogonal: full access requires both `--approval auto --sandbox off`; there is no `--yolo` alias.
- Budget flags are `--max-turns`, `--max-wallclock`, `--max-total-wallclock`, `--max-model-calls`, `--max-tool-calls`, `--max-billed-input-tokens`, `--max-output-tokens`, and `--max-consecutive-failures`. CLI wall-clock values are milliseconds. These limits are validated as positive integers and frozen into a new RunSpec; they do not alter an existing Run during resume. `--max-output-tokens` limits cumulative Run output, not one provider request's `max_tokens`.
- `npm run verify:all`: run the 15 acceptance scripts / 235 criteria; use an individual `verify:*` command for evidence. `npm run verify:mcp` uses a fake stdio server and does not launch Playwright or access the network.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, semicolons, trailing commas, and `.js` suffixes in relative ESM imports. Prefer `PascalCase` for types/classes, `camelCase` for values/functions, and kebab-case filenames. Preserve the dependency direction: apps → packages/adapters/cases and runtime → ports → adapters. Runtime must not import provider SDKs or case packages. Comments should explain rationale and failure modes in Chinese with V05 or evidence references. No formatter/linter is configured; match nearby code.

## Testing Guidelines

D-25 specifies no unit-test framework or coverage target. The current suite has 15 acceptance scripts / 235 criteria. Scripts in `apps/cli/src/verify/` must print readable evidence through `verify/harness.ts`, not only return a green assertion. Name scripts for the invariant and register them in root `package.json`. Before submitting, run `typecheck`, relevant `verify:*` scripts, and the boundary greps — run them via `npm run verify:tools` (section A), not by hand: the checker filters comment lines, because these files quote the boundary rules themselves everywhere, so copying the raw grep commands gives false reds.

Every new assertion must have discriminating power: state which single line, if broken, would turn it red, and actually run that experiment once. A green assertion that cannot fail is decoration, not a criterion — the 2026-08-28 closeout batch found four of them among 84 supposedly-green checks (see stale-issue list §0.7). Verification requires a configured root `.env`, even with fake ports. Never commit `.env`, credentials, `.workagent-workspace/`, or sensitive provider traces.

## Commit & Pull Request Guidelines

Recent history uses short Chinese summaries rather than Conventional Commit prefixes. Keep commits cohesive, for example `修复 resume 预算继承`. Pull requests should state the research question or bug, cite the governing V05 section or ADR, list affected boundaries, commands, results, and limitations, and attach CLI evidence for behavioral changes.
