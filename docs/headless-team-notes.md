# Headless Team implementation notes

## Demo

```sh
bun packages/coding-agent/scripts/demo-headless-team.ts
```

The deterministic demo uses a temporary `.gjc` fixture and an in-process fake control plane. It exercises two workers, heartbeat rendering, dependency blocking and release, interrupts Lane B while its claim is in progress, makes production `resumeGjcTeam` observe an authoritative dead probe, verifies release and re-claim with a new token, and completes through runtime operations. The script no longer writes lifecycle files or recovery events itself. It removes the fixture in `finally`, exits nonzero on assertion failure, and is the source for `docs/assets/team-watch-demo.txt` without ANSI escapes. It does not claim to prove a live SDK broker or model turn.

## Changed files

- `README.md`
- `packages/coding-agent/src/commands/team.ts`
- `packages/coding-agent/src/commands/team-watch.ts`
- `packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md`
- `packages/coding-agent/src/coordinator-mcp/server.ts`
- `packages/coding-agent/src/gjc-runtime/ralplan-runtime.ts`
- `packages/coding-agent/src/gjc-runtime/team-control-plane.ts`
- `packages/coding-agent/src/gjc-runtime/team-control-plane-headless.ts`
- `packages/coding-agent/src/gjc-runtime/team-control-plane-tmux.ts`
- `packages/coding-agent/src/gjc-runtime/team-runtime.ts`
- `packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts`
- `packages/coding-agent/scripts/demo-headless-team.ts`
- `packages/coding-agent/test/gjc-runtime/ralplan-runtime.test.ts`
- `packages/coding-agent/test/gjc-runtime/team-headless-control-plane.test.ts`
- `packages/coding-agent/test/gjc-runtime/team-runtime.test.ts`
- `packages/coding-agent/test/gjc-runtime/team-tmux-control-plane.test.ts`
- `packages/coding-agent/test/gjc-runtime/team-watch.test.ts`
- `packages/coding-agent/test/gjc-runtime/ultragoal-runtime.test.ts`
- `docs/assets/team-watch-demo.txt`
- `docs/assets/headless-team-verification.json`
- `packages/coding-agent/src/internal-urls/docs-index.generated.ts`
- `docs/headless-team-notes.md`

## Approved-plan invariant evidence

| Invariant | Compliance evidence |
| --- | --- |
| §3.1 Data-plane compatibility | Existing config/manifest/task/worker records are preserved; new backend and SDK fields are optional additions. `team-runtime.test.ts`, `team-headless-control-plane.test.ts`, and `team-tmux-control-plane.test.ts` cover legacy/default and additive paths. |
| §3.2 Ultragoal ownership | `ultragoal-runtime.ts` launches parallel teams from the leader and keeps checkpointing in `checkpointUltragoalParallelGroup`; workers receive only lane objectives. Tests reject non-leader checkpoint ownership and assert `team_name` ledger references. |
| §3.3 Claim/lease ordering | Existing owner, role, liveness, and lease checks remain in place. Explicit lane dependencies add `blocked_by_dependency:<task-id>` after those checks; focused runtime tests cover dependency release and priority. |
| §3.4 Explicit lanes only | Existing ambiguous inline split rejection remains. New `(after: ...)` parsing applies only to explicit markdown `Lane` headings, with missing/self/cycle validation. |
| §3.5 Shutdown safety | `TmuxControlPlane.stopWorker` rejects leader/foreign handles and kills only owned worker panes. `HeadlessControlPlane.stopWorker` reaps only delegate-created sessions. Adapter tests cover both scopes. |
| §3.6 SDK security boundary | Headless control uses the canonical coordinator/SDK lifecycle and loopback discovery. Persisted identity/config contains only `.gjc/state/sdk/<sessionId>.json`, never tokens; the production lifecycle test captures the initial and replacement session's actual generated tokens, excludes only each token's own canonical private discovery file, and scans every other discovery/state/log/output byte for both tokens. Removed rpc/bridge modes are not reintroduced. |
| §3.7 Flag-off compatibility | `resolveGjcTeamControlPlaneKind` defaults to `tmux`; Ultragoal execution metadata defaults to `sequential`; `GJC_ULTRAGOAL_PARALLEL` gates launch. Focused tests cover unset/explicit tmux and legacy complete-goals output. |
| §3.8 Repository gates | Focused feature tests and the required repository gates are recorded in the final DoD evidence table; this document does not pre-claim unrun gates. |

## Approved §7 Definition-of-Done evidence

Statuses report the leader's observed commands. Fake-coordinator evidence never satisfies a real-broker row; the machine-readable receipt is `docs/assets/headless-team-verification.json`.

| Approved §7 item | Command / evidence path | Test name(s) | Current status |
| --- | --- | --- | --- |
| Six §6.5 repository gates green | `bun scripts/check-visible-definitions.ts`; `bun scripts/verify-g002-gates.ts`; `bun scripts/rebrand-inventory.ts --strict`; `bun test packages/coding-agent/test/default-gjc-definitions.test.ts`; `bun run check:ts`; `bun test packages/coding-agent` | Approved §6.5 gates | **Baseline recorded** — the first five pass; the package suite reports 10,824 pass, 352 skip, 7 fail, 3 errors. Three workflow-emitter failures are active-Ultragoal environment contamination and pass with session variables unset; the remaining session-identity race, tmux harness timeouts, and `/tmp` canonicalization mismatch are outside the changed feature surfaces. |
| Backend unset: §6.4 regressions green and tmux dry-run snapshot diff 0 | Focused six-file command in the verification receipt; unset/explicit tmux cases | tmux default/status/resume/shutdown and dry-run golden tests | **Verified by focused tests**; no pre-refactor byte snapshot artifact exists. |
| PATH without tmux: real headless E2E completes with failed=0 | Focused six-file command and `docs/assets/headless-team-verification.json` | `uses the production coordinator and broker lifecycle without tmux` | **Verified** — production coordinator, Broker, SDK host and Team runtime reach `phase=complete`, completed=1, failed=0 with tmux absent from PATH. |
| Concurrent watch satisfies §6.3 and demo prints PASS | Demo command; CLI JSON/plain/PTY receipt; `docs/assets/team-watch-demo.txt` | Demo assertions; `team-watch.test.ts` | **Verified** — demo 11/11 and PTY six frames. |
| Lane B `(after: A)` order in automatic test and demo | Demo command; focused feature command | dependency block/release tests; demo dependency and recovery-sequence assertions | **Verified** — 327 focused tests pass and demo 11/11. |
| Worker kill → resume recovery green | Production broker lifecycle test and demo | authoritative dead-probe, forced stale-endpoint reap, claim release, replacement generation, new-token re-claim | **Verified** with the production coordinator/Broker/SDK host and the approved scripted-worker seam. |
| Approved-plan fixture populates `execution`/`lanes_ref`; mismatch rejected | Focused feature command | create-goals execution-plan acceptance and mismatch rejection tests | **Verified** within 327 passing focused tests. |
| Parallel headless team → barrier → leader checkpoint; flag-off sequential | Focused feature command plus production broker lifecycle tests | durable launch binding, strict barrier, leader provenance, flag-off tests, direct automatic production lifecycle | **Verified directly** — automatic `complete-goals` launches a production headless Team without tmux, joins the strict barrier, checkpoints durably, reaps workers, and completes the aggregate; flag-off and explicit tmux remain manual/sequential. |
| No raw token in logs, state, or test output | Production broker lifecycle test and focused suite | every actual generated SDK token (initial and replacement) excluded only from its own canonical private discovery file, cross-checked against the other session's discovery contents, then scanned across remaining temp state and captured output | **Verified by the recorded focused run**. |
| Notes include changed files and §3 evidence | Review this document | Documentation review | **Present**. |
| Plain watch capture exists | `docs/assets/team-watch-demo.txt` | deterministic demo capture comparison | **Verified**, SHA-256 `8729f58acb804f575597f980d77e95577534fb0ff9b4db78dbb275e04011c0aa`. |

### Watch evidence fields

| Surface | Required evidence | Artifact / hash | Status |
| --- | --- | --- | --- |
| JSON snapshot | `gjc team watch <team> --json` normalized golden | `docs/assets/headless-team-verification.json` | **Verified** |
| Plain frame | `gjc team watch <team> --plain` / demo capture | SHA-256 `8729f58acb804f575597f980d77e95577534fb0ff9b4db78dbb275e04011c0aa` | **Verified** |
| PTY live mode | PTY run ≥1 second, ≥1 rerender, no crash | 1.1 seconds, six frames and six ANSI clears | **Verified** |
| Read-only behavior | Before/after state-tree content hash | Both `637d568513fb3c4af17b0aae5d1a77502c18553565eca2b87311a5133cbd7303` | **Verified** |

## Fake-coordinator versus real-broker coverage

The demo proves parser/runtime/watch integration against an in-process `TeamControlPlane`: dependency blocking, an in-progress claim, authoritative `probe(...).live === false`, production resume-driven release and replacement, re-claim with a different token, ordered runtime events, and terminal completion. It does not spawn, kill, reconnect, or execute a real SDK session.

The production integration tests exercise `createCoordinatorMcpServer`, `Broker`, the shipped SDK session host, `HeadlessControlPlane`, and Team start/resume/shutdown without tmux. They terminate a delegate host, force-reap the stale endpoint, observe authoritative death, release and reclaim with a replacement generation and new token, complete the task, and prove terminal `phase: "complete"` with failed=0. A direct automatic Ultragoal test additionally drives `complete-goals` through production Team launch, strict join, durable checkpoint, worker reap, and final aggregate completion. The deterministic boundary replaces model execution with an immediate prompt-acceptance receipt while preserving the production broker, coordinator, SDK host, and Team runtime.

## Evidence boundary

The demo remains deterministic fake-worker evidence. Production integration independently proves broker discovery, real session spawning and process death, reconnection, completion, token-safe persisted/captured output, and direct automatic Ultragoal-to-Team launch/join/checkpoint/reap behavior without relying on the demo.
