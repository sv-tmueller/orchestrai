/**
 * The guard's rule groups, in the order `decide` runs them (issue #539).
 *
 * One group per file under `rules/`. A later group adds one import line and
 * one entry here and touches no other group. Each group is
 * `{ id, check(ctx) }`, where `check` returns null or `{ entry, reason }`.
 */

import { mergeRule } from './rules/merge-rule.mjs'

export const GROUPS = [mergeRule]
