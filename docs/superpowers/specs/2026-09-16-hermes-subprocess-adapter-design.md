# Hermes adapter: subprocess spawn instead of delegate_task

Date: 2026-09-16
Status: approved design. Amends Phase C of
`docs/superpowers/specs/2026-08-14-portable-orchestrator-design.md`.
The three-layer architecture, the adapter interface, and the tier
abstraction are unchanged. What changes is which Hermes primitive
implements `spawn`.

Resolves issue #351.

## 1. Why Phase C needs amending

Phase C shipped a Hermes adapter built on `delegate_task`. That
primitive cannot express three bindings the design depends on.

Documented `delegate_task` parameters are `goal`, `context`, `tasks[]`,
`background`, and `role`. No model override, no working directory, no
output schema. The measured consequences:

1. The tier table is decorative. `.claude/adapters/hermes.json` maps all
   three tiers to one model, and `delegation.reasoning_effort` in
   `config.yaml` is a single global value. The `judgment=xhigh /
   worker=high` split cannot be expressed, so the `judgment -> worker`
   fallback retries the same model at the same effort. The installed
   Hermes skill admits this in its own "does NOT do" section.
2. No working-directory isolation. `delegate_task` gives an isolated
   context and terminal session, not an isolated checkout. The pipeline
   runs up to 3 packages concurrently, which places 3 developer agents
   in one working directory on one branch.
3. `hermes-adapter.mjs` passes `output_schema`, which appears in no
   Hermes documentation. `docs/architecture/adapter-interface.md`
   section "spawn" and the `hermes.json` description both assert that
   capability. The claim was never verified.

The live path compounds this. It is gated on
`typeof globalThis.delegate_task === 'function'`, but Hermes exposes
tools to the model, not as Node globals in a spawned process. The gate
never opens, so every test exercises `DRY_RUN` and the assertions never
touch the code that would run in production. What actually ran on
Hermes was the prose in the installed `SKILL.md`, not this module.

## 2. Goal and non-goals

Goal: implement `spawn` so that every binding the tier abstraction
declares (model, provider, effort, isolation, tool surface) is actually
applied to the spawned seat, and so the adapter's live path is
executable and testable.

Non-goals:

- No change to the adapter interface. `spawn`, `detectFailure`, and
  `retry` keep their signatures and contracts.
- No change to the process layer. Flat-star, fix caps, parking, sizing,
  and the report contracts stay as they are.
- No change to the Claude Code adapter.
- Not fixing the installed-bundle drift, the five unported skills, or
  the Codex adapter. Those are separate work, listed in section 8.

## 3. The spawn primitive

Verified against Hermes Agent v0.20.1. Every binding has a flag:

| Binding | Flag |
| --- | --- |
| Model and provider per seat | `-m MODEL --provider P` |
| Effort per seat | `--reasoning LEVEL` |
| Tool surface per seat | `-t TOOLSETS` (documented as applying to `-z`) |
| Isolation for code-editing seats | `-w` / `--worktree` |
| Working directory | `--in DIR` |
| Headless approval | `--yolo --accept-hooks` |
| Report capture | `-z` prints only the final response |

`-z` was verified to run headless from a non-TTY pipe: it cleared
argument parsing and session setup and issued a live HTTP request with
stdin closed. A Node `child_process` can therefore drive it. This is
also the path Hermes itself recommends. Its agent skill advises `-w`
when spawning agents that edit code, and its comparison table directs
`delegate_task` at quick subtasks while pointing long autonomous
missions at spawned processes. A developer agent implementing an issue
is the latter.

The command `spawn` builds:

```
hermes -z "<role prompt + task>" \
  -m <tier.model> --provider <tier.provider> \
  --reasoning <tier.effort> \
  -t <seat.toolsets> \
  --in <package worktree path> \
  --yolo --accept-hooks
```

Note the absence of `-w`. Isolation is real, but the driver owns it, for
the reasons in section 3.2.

Rules injection stays on. `--ignore-rules` is not passed, so each seat
picks up the repo's `AGENTS.md` and through it `.claude/process-core.md`.
The process layer reaches every seat without the adapter templating it
into the prompt.

### 3.1 Two consequences

First, the live path becomes ordinary Node. `hermes` is a CLI, so
`child_process` reaches it with no host-injected globals. The
`globalThis.delegate_task` branch is deleted, and the live path becomes
testable by stubbing the spawn call rather than by skipping it.

Second, a Hermes lead session stops being required. A Node driver plus
`hermes -z` workers is the whole team. The Hermes skill becomes one way
to launch the pipeline rather than the only way, which moves the
package closer to the host independence the parent design aims at.

### 3.2 Why the driver owns the worktree, not `-w`

`-w` exists and works, but its lifecycle is built for an interactive
human session, not for a staged pipeline. Read from the Hermes v0.20.1
source (`cli.py`):

- `_cleanup_worktree` runs on process exit via `atexit`. It preserves the
  worktree only when it has unpushed commits. Its own docstring states
  that uncommitted changes alone are not enough to keep it. Otherwise it
  runs `git worktree remove --force` and then `git branch -D <branch>`.
  A developer seat that exits with uncommitted work loses the work and
  the branch.
- `_setup_worktree` names the branch `hermes/hermes-<8hex>` from a UUID.
  That is not `feat/<issue>-<slug>`, so the convention in
  `.claude/process-core.md` would be broken on every dispatch.
- It appends `.worktrees/` to the repo's `.gitignore`, mutating a tracked
  file as a side effect of spawning an agent.
- Each spawn gets a fresh worktree branched from the fetched remote tip.
  Stage handoff would then only work through the remote, and a fix-round
  developer would start from a worktree that does not contain the
  previous round's branch unless it was already pushed.

So the driver creates one worktree per package with `git worktree add`,
names the branch `feat/<issue>-<slug>`, and passes every seat for that
package the same `--in <path>`. The driver owns creation and teardown,
so nothing is deleted on a seat's exit, stage handoff works on the local
filesystem as well as through the remote, and the branch convention
holds.

One thing the driver has to replicate: `.worktreeinclude`. Copying the
gitignored files a seat needs is done by Hermes' `_setup_worktree`, not
by `git worktree add`, so a driver-created worktree does not get it for
free. If any seat needs a gitignored file, the driver copies it after
creating the worktree.

## 4. Adapter table changes

`.claude/adapters/hermes.json` grows two things: a provider per tier,
and a seat binding per role.

```json
{
  "tiers": {
    "judgment": {
      "model": "vllm/release/glm-5-3",
      "fallback_model": "vllm/release/glm-5-2",
      "provider": "custom",
      "effort": "xhigh"
    },
    "worker": {
      "model": "vllm/release/glm-5-3",
      "fallback_model": "vllm/release/glm-5-2",
      "provider": "custom",
      "effort": "high"
    },
    "lead": {
      "model": "vllm/release/glm-5-3",
      "fallback_model": "vllm/release/glm-5-2",
      "provider": "custom",
      "effort": "xhigh"
    }
  },
  "seats": {
    "developer": { "toolsets": ["file", "terminal", "todo", "code_execution"] },
    "architect": { "toolsets": ["file", "terminal"] },
    "reviewer":  { "toolsets": ["file", "terminal"] },
    "tester":    { "toolsets": ["file", "terminal"] }
  }
}
```

The remaining seats (fact-checker, docs-writer, perf-investigator) take
the same shape as architect.

Seats carry no isolation field. Isolation is per package, not per seat:
the driver creates one worktree for a package and every seat working
that package receives the same `--in` path (section 3.2). The
`isolation: "worktree"` hint in the adapter interface is therefore
satisfied by the driver rather than by a spawn flag.

The model choice, decided by the owner on 2026-09-16: GLM 5.3 on every
tier, with GLM 5.2 as the fallback on every tier. The `provider` value
is a label resolved by local Hermes config, so the table names no
infrastructure.

One model across all tiers is a sound configuration here, which it would
not have been under the parent design. With a cross-tier ladder, one
model everywhere makes `retry` a re-roll of the same model at the same
effort. With the within-tier `fallback_model` of section 4.3, every tier
degrades 5.3 to 5.2, so retry means something regardless of how many
distinct models the table holds. What still separates the tiers is
effort: `xhigh` for judgment and lead, `high` for worker, applied per
spawn through `--reasoning`.

A cheaper coding-optimized model on the worker tier (DeepSeek V4 Flash,
confirmed available as `vllm/qsu/deepseek-v4-flash`) is the intended next
step for cost, deliberately deferred. Adopting it is a one-line change to
the `worker` entry and needs no code change, which is the property the
tier abstraction exists to provide. Two things to check at that point:
whether `--reasoning` affects a flash-class model at all, and that the
seats sharing the worker tier (`fact-checker` and `docs-writer` among
them) are ones a coding-tuned model should hold. Neither question
applies while every tier runs the same model.

One item to confirm when a working credential is available: the exact
model ID for GLM 5.3. It is not present in the local config or the
provider catalog. `vllm/release/glm-5-3` follows the existing naming
pattern but is unverified, and every tier now depends on it.

### 4.3 Fallback is within tier, not across tiers

The parent design made the ladder cross-tier: a judgment-tier failure
retries on the worker tier, generalizing the Opus to Sonnet pattern.
That generalization holds on Claude Code, where the worker tier is a
capable generalist. It does not hold here. The worker tier is a
coding-optimized flash model, so a cross-tier fallback would hand an
arbitration or a review verdict to the model least suited to it, in the
one seat where judgment is the product.

So `tiers` gains an optional `fallback_model`. Where a tier declares
one, `retry` uses it and stays in tier. Where a tier declares none,
`retry` falls back across tiers exactly as the parent design specifies.
A worker-tier failure with no `fallback_model` has no lower tier to
reach, so it is a failure: the stage's fix-cap rules apply and the
package parks on exhaustion. The Hermes table declares a
`fallback_model` on every tier, so the cross-tier path never fires
there.
The Claude Code table declares no `fallback_model`, so its Opus to
Sonnet behavior is unchanged. This amends section 3.3 of the parent
design, which stated the ladder is tier-level in all cases.

Hermes also has a native `fallback_model` config and a `hermes fallback`
CLI that would retry at the provider layer. The adapter does not rely on
it, because a provider-layer retry is invisible to the adapter and the
report contract requires the fallback to be logged and flagged. Native
fallback remains available underneath as an independent safety net.

### 4.1 Flat-star enforced at the runtime level

Every seat omits the `delegation` toolset. A spawned seat therefore
cannot delegate further, which enforces "agents never call each other"
mechanically instead of by prompt instruction. This is the first
mechanical enforcement of that invariant on any host.

Seats also omit `browser`, `computer_use`, `image_gen`, `bfl`,
`cronjob`, `memory`, and `session_search`. Dropping `memory` and
`session_search` keeps a seat's judgment a function of its task and the
repo, not of unrelated history in the owner's Hermes state.

### 4.2 Effort ceiling

Hermes `--reasoning` accepts `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, and `ultra`. The team's ceiling is `xhigh`, so the
forbidden list in `hermes.json` must grow from `["max"]` to
`["max", "ultra"]`. The effort-policy test asserts no tier or seat
resolves to either.

## 5. Report capture and failure detection

`-z` prints only the final response, so the report arrives as text on
stdout. The adapter parses the report-contract fields per role, with the
patterns derived once from `docs/architecture/role-contracts.md`
(`STATUS:` for developer, `VERDICT:` for tester and reviewer, and so
on). A parser table keyed by role replaces the `output_schema`
parameter, and the false claim is removed from
`docs/architecture/adapter-interface.md` and the `hermes.json`
description.

`detectFailure` returns true on any of: a nonzero exit code, empty
stdout, an HTTP error line on stdout or stderr (the expired-key
response `HTTP 403: Virtual key has expired` is the reference case), or
a parsed report missing its role's required field.

`retry` keeps its contract with one change from the parent design: it
degrades to the tier's `fallback_model` when the tier declares one, and
across tiers otherwise (section 4.3). It logs the fallback, marks
`modelFallback` on the report, preserves the schema and the effort, and
appends a retry notice so no unchanged prompt is re-dispatched.

## 6. The driver

The Node driver is the primary entry point:

```
node .claude/adapters/hermes-pipeline.mjs --issues 42,43
```

It owns the gate, the wave plan, the per-package stage sequence, the fix
caps, the parking, and the wave-end report. `SKILL.hermes.md` becomes a
thin wrapper that shells out to it rather than prose the lead model
re-implements each run. This matters because the current installed
bundle is a hand-written paraphrase that silently dropped the label
gate, resume detection, `label:` selection, ARBITRATION routing, the
never-re-dispatch-unchanged rule, fix-cap counting, parking semantics,
and the wave-end report format. Rules that live in the driver cannot be
paraphrased away.

Concurrency moves to the driver, which removes two Hermes-specific
hazards: the per-turn truncator that silently drops excess
`delegate_task` calls in one turn, and the model self-limiting a batch
and reporting it as a runtime cap.

## 7. Verification

1. Unit: the adapter builds the expected argv for each role from the
   table. Assert the flags, the tier resolution, the seat toolsets, the
   `-w` presence for developer only, and the absence of `delegation`
   everywhere.
2. Unit: `detectFailure` across all five failure shapes, including the
   HTTP 403 line.
3. Unit: the report parser against a recorded stdout fixture per role.
4. Unit: the adapter table maps every role to a seat and every tier to a
   model, with no forbidden effort. Assert that a tier declaring
   `fallback_model` retries within tier and one without it retries
   across tiers, so the Claude Code path stays covered.
5. Integration, one seat: spawn the architect for a `SUB_PLAN` on a real
   issue and confirm a parsed report.
6. Integration, full pipeline: one `size:S` issue from gate to ready PR.
7. Isolation: two packages concurrently, and confirm two distinct
   driver-created worktrees with `feat/<issue>-<slug>` branch names, no
   cross-contamination, no mutation of the repo's `.gitignore`, and both
   worktrees still present after the seats exit.

Steps 5 through 7 are blocked on a working provider credential. The
current key returns `HTTP 403: Virtual key has expired`, so no live
Hermes verification is possible until it is renewed. Steps 1 through 4
run offline and gate the PR.

## 8. What this deliberately does not fix

Named so they are not mistaken for oversights:

1. The installed bundle at
   `~/.hermes/skills/autonomous-ai-agents/orchestrai/` is a hand-written
   paraphrase of `SKILL.hermes.md`, drifted by 39 lines in the skill and
   140 lines in the vendored renderer, with no sync mechanism. Section 6
   shrinks the blast radius by moving rules into the driver, but
   generating the bundle from source with a drift test is separate work.
2. Five of seven skills have no Hermes variant: `tm-review-changes`,
   `tm-review-codebase`, `tm-map-codebase`, `tm-grill-me`, `tm-ab-test`,
   `tm-new-project`. The three workflow skills need the renderer wired
   to the new spawn before they can run live.
3. The Codex adapter has the same unverified shape and has never been
   live-tested. It needs its own audit against the `codex exec` flags.
4. Read-only seats cannot be enforced through `-t`. Every seat needs
   `terminal` for git, gh, and the check suite, and `terminal` implies
   write capability. Read-only stays a prompt-level contract on Hermes,
   weaker than the Claude Code tool allowlist. The adapter documents
   this rather than implying parity.

## 9. Risk register

1. Medium: subprocess overhead per seat. Each spawn is a fresh process
   that re-reads rules and rebuilds context. Mitigation: the seats are
   long-running by nature (a developer implementing an issue), so
   startup is a small fraction of the run. Measure once live.
2. Resolved during design, kept for the record: `-w` would have deleted
   a developer's work. Its `atexit` cleanup removes the worktree and
   force-deletes the branch unless there are unpushed commits, and
   uncommitted changes do not count. It also names branches from a UUID
   and edits the repo's `.gitignore`. Section 3.2 moves worktree
   ownership to the driver, which removes all three problems. The
   residual risk is ordinary `git worktree` handling in the driver,
   covered by verification step 7.
3. Low: report parsing from prose is looser than a schema. Mitigation:
   the role contracts already mandate a fixed first line per report, and
   `detectFailure` treats a missing required field as failure rather
   than passing a half-parsed report downstream.
4. Blocking, external: the expired provider credential. Nothing live is
   verifiable until it is renewed.

## 10. References

- Issue #351 (this design's issue)
- `docs/superpowers/specs/2026-08-14-portable-orchestrator-design.md`
  (the parent design; this amends Phase C)
- `docs/architecture/adapter-interface.md` (the interface, and the
  `output_schema` claim this corrects)
- `docs/architecture/hermes-adapter.md` (the component map to update)
- `docs/architecture/role-contracts.md` (the source of the report
  parser patterns)
- `.claude/adapters/hermes.json` (the table this extends)
- Hermes Agent v0.20.1 `hermes --help` (the verified flag surface)
