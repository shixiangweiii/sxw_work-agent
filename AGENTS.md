# Repository Guidelines

## Project Identity & Sources of Truth

**Project Atlas** is this Work Agent project's communication codename only; do not rename existing `workagent` / `@workagent/*` code, paths, packages, modules, or types. Build this learning-first Agent Harness to turn user goals into observable, recoverable, verified outcomes—not to clone an office suite or maximize features. Use `方案讨论/WorkAgent目标定位与技术架构三次对焦讨论进展.md` for goals, `架构设计/WorkAgent架构设计_V20260823_05.md` for implementation semantics, and the Roadmap for sequencing.

## Project Structure & Roadmap

This npm-workspaces TypeScript ESM monorepo currently implements Layer 3 in `packages/harness-runtime/`; fakes live in `packages/testkit/`. Provider shapes belong in `adapters/shape-anthropic-messages/`, endpoint behavior in `adapters/endpoint-profiles/`, tool cases in `cases/micro-cases/`, and composition/CLI/verification in `apps/cli/`. `spikes/` is excluded; `sxw_aicoding/` holds design evidence. Stage 1 is complete with an in-memory transcript. Stage 2 adds SQLite durability and restart Resume; Stage 3 validates web archiving against a baseline; GUI work starts in Stage 4.

## Build, Test, and Development Commands

- `npm ci`: install locked workspace dependencies.
- `npm run typecheck`: run strict TypeScript checks; no build step emits files.
- `npm run dev -- --task "list files and write summary.txt"`: run the headless CLI; add `--yes` or `--workspace <path>`.
- `npm run verify:all`: run all acceptance scripts; use an individual `verify:*` command for evidence.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, semicolons, trailing commas, and `.js` suffixes in relative ESM imports. Prefer `PascalCase` for types/classes, `camelCase` for values/functions, and kebab-case filenames. Preserve the dependency direction: apps → packages/adapters/cases and runtime → ports → adapters. Runtime must not import provider SDKs or case packages. Comments should explain rationale and failure modes in Chinese with V05 or evidence references. No formatter/linter is configured; match nearby code.

## Testing Guidelines

D-25 specifies no unit-test framework or coverage target. Scripts in `apps/cli/src/verify/` must print readable evidence through `verify/harness.ts`, not only return a green assertion. Name scripts for the invariant and register them in root `package.json`. Before submitting, run `typecheck`, relevant `verify:*` scripts, and architecture-boundary greps. Verification requires a configured root `.env`, even with fake ports. Never commit `.env`, credentials, `.workagent-workspace/`, or sensitive provider traces.

## Commit & Pull Request Guidelines

Recent history uses short Chinese summaries rather than Conventional Commit prefixes. Keep commits cohesive, for example `修复 resume 预算继承`. Pull requests should state the research question or bug, cite the governing V05 section or ADR, list affected boundaries, commands, results, and limitations, and attach CLI evidence for behavioral changes.
