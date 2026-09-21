# C06 Linux supplement

Original Mac report `docs/migration/reports/C06.md` is unchanged.

Mac AT-W01/W02 kernel RO-bind was NOT_RUN (Darwin fail-closed path policy is not EROFS). Linux required a narrow preflight fix: `preflightBubblewrap` used `execFileSync("command")` (ENOENT) and probed `true` without filesystem binds. C15L resolves `bwrap` via `which`/`command -v` and probes with the same RO binds as production wrap, then `/bin/true`.

Linux tests now wrap a Python neighbour write and expect EROFS / Errno 30; neighbour bytes unchanged. Darwin assertions remain fail-closed.

```bash
cd gsd-pi
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types \
  --test --test-concurrency=1 src/runtime-control/tests/c06-native.test.ts
# included in the 45-pass C05–C07 admission/native/events batch
```

C14 `test_at_w01_w02_neighbour_write_fail_closed` also ran a kernel bwrap with `/usr/bin/python3` against a symlink into the neighbour (`AT-W01-W02-kernel.json`).

Uncommitted files: `src/runtime-control/workspace-profile.ts`, `src/runtime-control/tests/c06-native.test.ts` on sealed SHA `35d288be0b5ae2de163187d239b8822bc0d368c2`.

See raid-night `docs/migration/linux-bridge/acceptance-ledger.json`.
