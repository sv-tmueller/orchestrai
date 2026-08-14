# Codex TOML personas for the orchestrator team roles.
#
# Each persona maps a role from the neutral role contracts
# (docs/architecture/role-contracts.md) to a Codex model and reasoning
# effort. Personas are consumed by the Codex adapter (codex-adapter.mjs)
# when dispatching role agents via `codex exec -c <persona>`.
#
# These are NOT copied from the Claude Code frontmatter. They are mapped
# from the neutral role contracts: the job description, report contract,
# and constraints come from role-contracts.md; the model and effort come
# from the adapter table (codex.json).
#
# The tier assignment lives in codex.json under `roles`. These persona
# files carry the role-specific prompt supplement (the job description
# and report contract), not the model/effort (which the adapter resolves
# from the tier at dispatch time).
