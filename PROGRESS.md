# gsd-pi progress

Save-point for future agents. This is the GSD fork worktree
(`migration/raidnight-native`) used for RaidNight native migration.
Do not write raid-night, product, or quake-cockpit from a gsd-pi C03/C04
session unless the prompt names that repo.

## C03 required verification (2026-09-20)

Portable C03 in worktree `migration/raidnight-native` starting at
`fa83b795f3ef5fd7d2c02b37d4e96cbd9dc94f88`. Schema SHA256
`0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
unchanged. No schema edits. Proceeded under the Mac addendum portable
C01-C15 exception: C02 is overall BLOCKED with `development_status: READY`
(Intel Mac RDKit wheel gap only).

- Report: `docs/migration/reports/C03.md` Status PASS; development_status READY; acceptance_status PASS
- Registry: `src/resources/extensions/gsd/required-policy.ts`
  - Host-owned `configureProjectRequiredPolicy(basePath, policyId)`
  - S4 callbacks: selfCheck, validatePlan, verifyTask, admission, workspace
  - `isRequiredPolicyReady` does not consult RPC `extensionsReady`
  - Unmanaged (no binding) skips the compulsory gate
- Test-only policy: `test-policy/v1` via
  `src/resources/extensions/gsd/tests/required-policy-test-harness.ts`.
  Production GSD never auto-selects it. Real FTM chemistry is C08.
- Runner: `src/resources/extensions/gsd/host-check-runner.ts`
  - async spawn, POSIX process group, AbortSignal, approved timeoutMs never clamped
  - bounded 10KB capture plus durable `file://` artefact refs
  - TERM then KILL; tests inject shorter grace via `setHostCheckCleanupBudgetsForTest`
  - ordinary checks use `shellCommand`; FTM/test-policy use `argv`
- Wiring: AND-gate in `auto-verification.ts`, custom-engine
  `custom-task-host-verification.ts`, and
  `publishVerifiedTaskCompletion` / `requireCurrentVerifiedSource`.
  Native verdicts stay pass|fail|inconclusive; cancelled maps to inconclusive
  with `environment.cancelled=true`. Policy id/version/verdict stored on
  evidence environment. Host-check logs excluded from source snapshots via
  `HOST_CHECK_LOG_EXCLUDE_PATHS`.
- Tests: AT-S06, AT-S07, AT-L01, AT-S08 plus unmanaged regressions.
  `npx --yes pnpm@10.12.1 run typecheck:extensions` exit 0.
  Targeted `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test`
  on the verification suites: 383 passed across four batches (38 + 224 + 22 + 99).
- Uncommitted: C03 implementation and this report. User git rule: do not commit
  unless asked. No push.
- Next portable task: C04 liveness. Do not start C04, C05 HTTP admission, or
  C08 FTM chemistry in a C03 session. No live GSD/monitor/inference.
- C00/C02 overall remain BLOCKED (Linux bwrap/systemd/model/legacy/Quake;
  RDKit lockfile wheel). Those are not C03 failures.

## Predecessor pins (do not rewrite)

- C00 gsd-pi HEAD pin remains `fa83b795f3ef5fd7d2c02b37d4e96cbd9dc94f88`
- C02 raid-night `migration/gsd-native` `d31b87399a491bd4b7ac0df65189c5b3c9ebd6fe`
  overall BLOCKED, development_status READY
- Pack 1.0.0 schema SHA256 `0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01`
