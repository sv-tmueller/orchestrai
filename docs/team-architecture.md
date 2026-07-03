# Agent team architecture

How the orchestrator team actually runs. The operating rules live in
`.claude/team-guide.md`; this doc adds the picture. The per-package mechanics
(parking, caps, routing) live in `.claude/skills/tm-kickoff/SKILL.md`.

"Agent team" is this template's name for the flat-star pattern below, not
Claude Code's experimental agent-teams feature (enabled with
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), where separate full sessions
coordinate peer-to-peer. Ours is built from subagents and dynamic workflows:
the lead spawns role agents that report back to it and never call each other.

## Flat star, not a nested tree

Claude Code now lets a subagent spawn its own subagents (a nested tree; the
tutorial this doc draws on reports a fixed depth cap, which we have not measured
here). We deliberately do not nest. The lead session is the only spawner and
routes every handoff. Three of the four role agents are read-only by tool
restriction; the developer writes code but is held to the same no-spawn rule, so
the star is structural, not just convention.

The reason is resumability. A nested tree lives and dies inside one session, so
a dropped connection loses the in-flight sub-tree. Our handoffs go through the
lead and land as GitHub artifacts (sub-plan comments, PR verdict comments,
labels), so a dropped session resumes from GitHub instead of restarting. We keep
the separation a nested model gives (one concern per agent, evidence flows up,
independent review, draft PR with the human merging) without trading away
resumability. Parallelism comes from worktree isolation, not nesting.

```mermaid
graph TD
    H["Human<br/>files and sizes issues, merges PRs"] --> L
    L["LEAD - main session (fable, xhigh effort)<br/>message bus and router<br/>owns no code; durable state lives in GitHub"]

    L -->|"JOB: SUB_PLAN / SPLIT / ARBITRATION"| A["architect (fable)<br/>read-only - approach, splits, arbitration"]
    L -->|"issue + sub-plan"| D["developer (sonnet)<br/>one issue end to end - worktree - TDD - draft PR"]
    L -->|"branch + issue"| T["tester (sonnet)<br/>read-only - re-runs suite, attacks change"]
    L -->|"PR + issue + untested claims"| R["reviewer (fable)<br/>read-only - spec pass then quality pass"]
    L -->|"report text + branch or PR"| F["fact-checker (sonnet)<br/>read-only - audits claims against evidence"]

    A -.->|"SUB_PLAN / NEEDS_DECISION"| L
    D -.->|"STATUS / BRANCH / PR / CHECKS"| L
    T -.->|"VERDICT / FINDINGS"| L
    R -.->|"VERDICT / FINDINGS"| L
    F -.->|"GROUNDED / UNGROUNDED per claim"| L

    L <-->|"sub-plans, PR verdicts, labels = resumable state"| G[("GitHub")]
```

Five peers under one lead, no third level. Evidence flows back to the lead, which
routes it into the next agent. GitHub holds the state that makes a dropped
session resumable. The `fact-checker` sits outside the per-package pipeline:
the lead dispatches it on demand when a report's claims are load-bearing but
carry no evidence, and routes any CONTRADICTED claim back to the agent that
made it.

## The per-package pipeline

For one issue, the lead runs the agents in sequence and loops on failure. This is
the happy path with the two fix loops. It omits parking (`needs-human`),
`NEEDS_CONTEXT`, architect arbitration on developer pushback, and the 3-round fix
caps, all of which live in `.claude/skills/tm-kickoff/SKILL.md`.

```mermaid
sequenceDiagram
    participant L as Lead (router)
    participant A as architect
    participant D as developer
    participant T as tester
    participant R as reviewer
    L->>A: JOB: SUB_PLAN (issue n)
    A-->>L: SUB_PLAN (or NEEDS_DECISION)
    Note over L: post sub-plan comment, label in-progress
    L->>D: issue + sub-plan
    D-->>L: STATUS: DONE (branch, draft PR, CHECKS)
    L->>T: branch + issue
    alt VERDICT: FAIL
        T-->>L: FINDINGS (repro commands)
        L->>D: fix exactly these
        D-->>L: STATUS: DONE
        L->>T: re-test
    end
    T-->>L: VERDICT: PASS
    L->>R: PR + issue + untested claims
    alt CHANGES_REQUESTED
        R-->>L: must-fix FINDINGS
        L->>D: fix exactly these
        Note over L,T: re-test, then re-review
    end
    R-->>L: VERDICT: APPROVE
    Note over L: gh pr ready, summary comment. Human merges.
```

Up to three packages run this pipeline at once, in isolated worktrees. The lead
never edits code; it routes reports and decides escalations.

---

Source: drawn from a tutorial on nested subagents in Claude Code
(owainlewis/youtube-tutorials), adapted to our flat-star model.
