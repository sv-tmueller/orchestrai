# Autonomous runs

Date: 2026-11-10
Status: approved design. Decisions settled with the owner on 2026-11-10.
Part of batch #470. Resolves issue #471, which records the design only. It
changes no code, skill, agent, or workflow.

## 1. Goal

Runs with no stops: no permission prompts, no agent questions to the owner
mid-run, no run ending at batch end, no manual merge.

The owner works alone on all personal repos.

## 2. Structure

- A lead session with subagents stays. There are no peer sessions that
  message each other, and no council of personas.
- The lead decides questions inside the contract and logs them. Anything
  outside the contract parks that package and its dependents, and the run
  continues.
- One live run per repo. The batch issue records which run owns it. A lead
  that finds a live run on the repo refuses to start a second one. Resuming
  a dropped run happens only on explicit request.
- Several lead sessions in parallel are fine across different repos. They do
  not communicate.
- Autonomous runs are allowed on the Claude Code host only. Seats on other
  hosts start as separate processes that a Claude Code hook cannot see, so
  those hosts stay attended.

## 3. Merge

Every PR merges by itself once it meets the rule. PRs that change the
orchestrator's own machinery are included.

### 3.1 The rule

GitHub holds the rule:

- The default branch is protected.
- Repo auto merge is on.
- The lead queues the merge with squash.
- The rule applies to admins too.

Required to merge: the CI jobs that run on PRs, where a repo has them, plus
two commit statuses, `orchestrai/review` and `orchestrai/test`. The same rule
applies to hand-made PRs.

`orchestrai/review` is a success only when the approving review ran on the
run's configured judgment model. A fallback review never counts.

### 3.2 Keeping PRs current

The lead brings PRs up to date and repairs them one at a time. The developer
resolves conflicts and the tests rerun. There is one repair attempt per PR,
then the package parks. A new review is needed only when the update touched
the PR's own changes.

### 3.3 Repos without CI

- Where tests exist, CI is added first. The repo counts as not set up until
  that lands.
- Where no tests exist, runs are allowed on the agent verdicts alone, the
  lean track is off, and the report flags the repo.

### 3.4 When the machinery breaks itself

The owner repairs it by hand: a revert PR, CI must pass, and the owner posts
the two statuses. There is no admin exception to the rule.

## 4. Guard and bypass

### 4.1 Bypass mode

- Bypass permission mode is per repo. It exists only together with the merge
  rule and the guard.
- Project settings cannot switch bypass on, so it is chosen when the session
  is launched.
- The guard refuses work in bypass on a personal repo that is not set up.

### 4.2 The guard

- The guard only denies. It never asks, because nobody answers in an
  unattended run.
- If the guard cannot run, the command is refused.
- Repos owned by an organization are never touched, and the guard does
  nothing there.
- The guard stops carelessness, not intent. The GitHub rule is the hard stop
  for the default branch.

### 4.3 The base deny list

- Going around the merge rule: push to the default branch, force push, admin
  merge, changing the rule, changing visibility, deleting a repo.
- Data loss: recursive deletes outside the repo or worktree, hard resets and
  cleans on the main checkout, dropping databases.
- Secrets in a commit, or writes to credential files.
- Changes to the guard and to permission settings.
- Edits to issue text during a run.
- Posting verdict statuses outside a pipeline run.

Each repo can add its own entries, for commands with effects outside the
code.

## 5. Contract and run bounds

### 5.1 The contract

The contract is the batch issue:

- Up to 6 packages.
- Dependencies between packages are allowed.
- 3 packages run at once.
- As many waves as the packages need.

### 5.2 Bounds

- A run stops and reports after 40 agent dispatches.
- A run ends when every package is merged or parked. A parked package parks
  its dependents.
- Nothing outside the contract is done. Work discovered during a run becomes
  a labelled backlog issue.
- Fix rounds stay at 3 per stage. A finding that blocks a contract criterion
  counts as that package's fix round.

### 5.3 Frozen contract

Frozen means four things:

1. The contract text is never edited after sign-off. The live checklist moves
   into comments.
2. A fingerprint of the contract and of each package's criteria is recorded
   at sign-off by a script.
3. The fingerprint is compared before every merge. A mismatch parks the
   package.
4. A new contract version comes only from the owner between runs.

### 5.4 Queued contract

- "File only" also files the batch issue, marked as queued. There is one
  queued contract per repo.
- A queued contract starts by itself after a clean end: every package merged
  and the default branch green. After a park, a hit ceiling, or a red default
  branch it waits for the owner.
- The lead compacts its context between the two runs.

### 5.5 Notification

One push notification per run, at its end. Nothing for a mid-run park or for
progress.

## 6. Rollout

- A `tm-repo-guard` command checks and applies the setup on the owner's
  personal repos, and prints the repair commands. Only repos owned by the
  owner's own account are in scope. `tm-new-project` calls it.
- Private repos can only get the rule on a paid GitHub plan. The command
  reports them as blocked until then.
- Plugin auto update stays on, in every config dir. The owner accepted that a
  faulty merge reaches every repo. Switching it on is a manual step per
  config dir.
- The plugin carries no version field, so every commit on the default branch
  is a new plugin version. This replaces the earlier idea of one version bump
  per wave. There are no tags and no releases.

## 7. Build order

Each step is used for real on orchestrai before the next one is built.

1. Merge rule, `tm-repo-guard`, auto merge in the pipeline, the repair step,
   the dropped version field.
2. The guard, and bypass tied to it.
3. Contract with dependencies and waves, the dispatch ceiling, one live run
   per repo, the queued contract, the notification.

Then the other repos: public repos with CI first, repos whose agents can
cause effects outside the code last, private repos once the plan allows it.

## 8. Unverified items and open points

Unverified:

- That a hook denial holds in bypass mode and inside subagents. Step 2 starts
  with that test.
- Whether a plugin auto update applies in the running session or the
  following one.

Open points for steps 2 and 3:

- Remote runners: a stage can be handed to a runner on another machine. The
  guard and the one-live-run rule have to account for that.
- Subprocess seats: seats can run as separate headless Claude Code processes
  with their own permission mode. The guard design has to cover them.

## 9. References

- Issue #471 (this design's issue) and batch #470.
