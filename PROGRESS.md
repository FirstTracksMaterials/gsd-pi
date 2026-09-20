# gsd-pi progress

Save-point for future agents. This is the GSD fork worktree
(`migration/raidnight-native`) used for RaidNight native migration.
Do not write raid-night, product, or quake-cockpit from a gsd-pi C05/C06
session unless the prompt names that repo.

## C05 HTTP admission (2026-09-20)

Portable C05 in worktree `migration/raidnight-native` starting at
`7dacd57a2f641c9571067c9b321e0ef911abcba5` (C04). Schema SHA256
`0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
copied verbatim into `packages/contracts/runtime-v1/` and hash-verified.
No schema edits. Proceeded under the Mac addendum portable C01-C15
exception: C00/C02 remain overall BLOCKED (Linux/RDKit). Those are
allowed deferrals and are not C05 failures.

- Report: `docs/migration/reports/C05.md` Status PASS; development_status READY; acceptance_status PASS
- Runtime control: `src/runtime-control/`
  - Read-only registration from `GSD_RUNTIME_REGISTRATION`; IDs and realpaths allowlisted
  - Durable operations: atomic JSON files plus request-id index; single writer; startup reconcile
  - R3-R5: fingerprint before revision rejection; 202 after durable admit; no LLM wait
  - One global model lease across registered projects for prepare/review/replan/start/resume
  - Cancel/recover do not take the lease; GET/read-only RPC does not
  - Production handlers: not-ready (`runtime_unavailable`) until C06; test-only inject via `registerCommandHandlerForTest`
  - Crash after dispatch intent: `recovery_required`, not auto-replayed
- HTTP: `web/app/api/runtime/v1/` capabilities, projects, commands, operation lookup
  - Import/answers/snapshots/events/history return 503 not-ready (C06/C07)
  - Existing bearer proxy covers `/api/runtime/v1`
- Entry guards: registered FTM `POST /api/session/command` model RPC and managed `gsd` PTY starts check `isRequiredPolicyReady` and the model lease. Unregistered cwd stays general-purpose GSD.
- Tests: AT-C01, AT-C02, AT-C03, AT-C04 plus contracts manifest verify and C03 required-policy regression.
  `npx --yes pnpm@10.12.1 run typecheck:extensions` exit 0.
  Contracts package tests: 8 passed. Targeted node tests: 32 passed.
- C05 implementation and this report are on `migration/raidnight-native`.
- Next portable task: C06 native commands and workspace. Do not start C06, C07, C08,
  live GSD/monitor/inference, production services, or Mac sandbox/launchd
  substitutes in a C05 session.
- C00/C02 overall remain BLOCKED (Linux bwrap/systemd/model/legacy/Quake;
  RDKit lockfile wheel). Those are not C05 failures.

## C04 required liveness (2026-09-20)

Portable C04 in worktree `migration/raidnight-native` starting at
`ef842340fa64bb72acb0d139add255013294a3df` (C03). Schema SHA256
`0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
unchanged. No schema edits. Proceeded under the Mac addendum portable
C01-C15 exception: C00/C02 remain overall BLOCKED (Linux/RDKit). Those
are allowed deferrals and are not C04 failures.

- Report: `docs/migration/reports/C04.md` Status PASS; development_status READY; acceptance_status PASS
- Useful progress: `src/resources/extensions/gsd/useful-progress.ts`
  - Content identity = Git HEAD + SHA256 of relevant dirty/untracked files
  - Compared with previous identity on the unit runtime record
  - Excludes `.gsd/runtime/**`, journals, heartbeats, `.gsd/evidence/**`, host-check logs
  - Cached for the idle-watchdog period (15s); mtime/size invalidate file hashes but are not the identity
- Idle watchdog (`auto-timers.ts`): `lastProgressAt` rearms only on identity change or in-budget tool/input exemptions. Token/stream writes `lastTransportAt` / `lastTransportKind` and does not rearm idle.
- Diagnostics on `AutoUnitRuntimeRecord` (version 1, additive): lastSourceIdentity, lastSourceChangeAt, lastTransportAt/Kind, activeTool, pendingInput, cancellationPhase.
- Cancellation: `auto-cancellation.ts` plus `stopAuto` sets `cancellationRequested` immediately, aborts the model turn, and refuses retry/compaction/continuation/dispatch. `publishVerifiedTaskCompletion` rejects PASS from cancelled attempts.
- Host-check runner: terminateProcessGroup always SIGKILLs remaining group members after parent exit (child-held stdout). Wait on process `exit`, not stdout `close`.
- Supervisor defaults unchanged: soft 20 / idle 10 / hard 30 / stalled-tool 5 minutes. No max-token/turn caps.
- Tests: AT-L02, AT-L03, AT-L04, AT-L05 plus token-churn, stop/compact/late-PASS, and existing idle/host-check/verification regressions.
  `npx --yes pnpm@10.12.1 run typecheck:extensions` exit 0.
  Targeted node test batches: 21 + 13 + 206 + 7 passed.
- C04 implementation and this report are on `migration/raidnight-native`.
- Next portable task: C05 HTTP admission. Do not start C05, C08 FTM chemistry,
  live GSD/monitor/inference, production services, or Mac sandbox/launchd
  substitutes in a C04 session.
- C00/C02 overall remain BLOCKED (Linux bwrap/systemd/model/legacy/Quake;
  RDKit lockfile wheel). Those are not C04 failures.

## C03 required verification (2026-09-20)

Committed on this branch as `ef842340fa64bb72acb0d139add255013294a3df`.
Report: `docs/migration/reports/C03.md` Status PASS; development_status READY;
acceptance_status PASS. Host-owned required-policy registry plus async
process-group runner. Test-only policy `test-policy/v1`. Real FTM chemistry is C08.

## Predecessor pins (do not rewrite)

- C00 gsd-pi pin remains `fa83b795f3ef5fd7d2c02b37d4e96cbd9dc94f88`
- C02 raid-night `migration/gsd-native` `d31b87399a491bd4b7ac0df65189c5b3c9ebd6fe`
  overall BLOCKED, development_status READY
- Pack 1.0.0 schema SHA256 `0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
