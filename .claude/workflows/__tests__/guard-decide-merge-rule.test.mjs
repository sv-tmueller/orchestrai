/**
 * Tests for the merge-rule group of the guard (issue #539, batch #538).
 *
 * The group lives in `.claude/guard/rules/merge-rule.mjs` and has six entries:
 * push-default, force-push, admin-merge, branch-rule, visibility and
 * delete-repo. Every row runs through `decide` in the two classes where the
 * group applies (personal and set up, and no GitHub repo). Each deny entry has
 * look-alike allow rows next to it.
 *
 * Every command text below is a string handed to the decision function. None
 * of them is ever run. Repo names are invented (`acme/widget`).
 *
 * Rows marked (F) change their result if "force push" is read as every force
 * spelling (option A) or as force to the default branch only (option B). They
 * are written for the lead's decision, option C: blind force spellings are
 * denied on every branch, and `--force-with-lease` to a named branch that is
 * not the default branch passes.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { decide } from '../../guard/decide.mjs'

const BASE_FACTS = {
  repoClass: 'personal-set-up',
  repo: 'acme/widget',
  defaultBranch: 'main',
  currentBranch: 'feat/1-x',
  enforceList: ['acme/widget'],
  pluginRoot: null,
}

const CLASSES = ['personal-set-up', 'no-github-repo']

function run(command, over = {}, repoClass = 'personal-set-up') {
  return decide(
    { tool: 'Bash', input: { command }, mode: 'bypassPermissions', folder: '/work/widget' },
    { ...BASE_FACTS, repoClass, ...over },
  )
}

// A row is a command, or [command, facts override].
function defineDenyRows(entry, rows) {
  for (const row of rows) {
    const [command, over] = Array.isArray(row) ? row : [row, {}]
    for (const repoClass of CLASSES) {
      test(`${entry} denies in ${repoClass}: ${command}`, () => {
        const answer = run(command, over, repoClass)
        assert.equal(answer.decision, 'deny', JSON.stringify(answer))
        assert.equal(answer.rule, `merge-rule/${entry}`, JSON.stringify(answer))
        assert.ok(answer.reason.length > 0)
      })
    }
  }
}

function defineAllowRows(label, rows) {
  for (const row of rows) {
    const [command, over] = Array.isArray(row) ? row : [row, {}]
    for (const repoClass of CLASSES) {
      test(`${label} allows in ${repoClass}: ${command}`, () => {
        const answer = run(command, over, repoClass)
        assert.equal(answer.decision, 'allow', JSON.stringify(answer))
        assert.equal(answer.rule, 'no-rule', JSON.stringify(answer))
      })
    }
  }
}

const ON_MAIN = { currentBranch: 'main' }
const SHA = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567'
const API = 'repos/acme/widget'
const TEMPLATE_API = "'repos/{owner}/{repo}'"

describe('merge-rule: push-default, denied', () => {
  describe('the default branch by name', () => {
    defineDenyRows('push-default', [
      'git push origin main',
      'git push -u origin main',
      'git push origin refs/heads/main',
      'git push origin main:main',
      'git push origin HEAD:main',
      'git push origin HEAD:refs/heads/main',
      'git push origin feat/x:main',
      'git push origin 0a1b2c3:main',
      'git push origin @:main',
      'git push --force-with-lease origin main',
      'git push --force-with-lease --force-if-includes origin main',
      'git push --force-with-lease origin HEAD:refs/heads/main',
    ])
  })

  describe('deleting the default branch', () => {
    defineDenyRows('push-default', [
      'git push origin :main',
      'git push origin --delete main',
      'git push -d origin main',
      'git push origin :refs/heads/main',
    ])
  })

  describe('all branches', () => {
    defineDenyRows('push-default', [
      'git push --all',
      'git push --branches origin',
      "git push origin 'refs/heads/*:refs/heads/*'",
      'git push --all origin feat/x',
    ])
  })

  describe('a push with no branch named, while on the default branch', () => {
    defineDenyRows('push-default', [
      ['git push', ON_MAIN],
      ['git push origin', ON_MAIN],
      ['git push origin HEAD', ON_MAIN],
      ['git push origin HEAD:', ON_MAIN],
      ['git push --follow-tags', ON_MAIN],
      ['git push -u origin HEAD', ON_MAIN],
    ])
  })

  describe('a destination the guard cannot know', () => {
    defineDenyRows('push-default', [
      ['git push', { currentBranch: null }],
      ['git push origin HEAD', { currentBranch: null }],
      'git push origin "$BRANCH"',
      'git push origin $(echo main)',
      'git push origin HEAD:$TARGET',
      'git -C ../other push',
      'cd ../other && git push',
      'git --git-dir=../other/.git push',
      'git --work-tree ../other push',
      ['git push origin feat/x', { defaultBranch: null }],
      ['git push', { defaultBranch: null }],
    ])
  })

  describe('a default branch with another name', () => {
    defineDenyRows('push-default', [
      ['git push origin trunk', { defaultBranch: 'trunk' }],
      ['git push origin HEAD:refs/heads/trunk', { defaultBranch: 'trunk' }],
    ])
  })

  describe('the same push in every spelling', () => {
    defineDenyRows('push-default', [
      '/usr/bin/git push origin main',
      'git --no-pager push origin main',
      'git -c core.askpass=x push origin main',
      'git -C . push origin main',
      'GIT_TRACE=1 git push origin main',
      'env GIT_TRACE=1 git push origin main',
      'timeout 60 git push origin main',
      'git add -A && git commit -m x && git push origin main',
      'git status; git push origin main',
      'git status || git push origin main',
      'git status | git push origin main',
      '(git push origin main)',
      '{ git push origin main; }',
      'echo $(git push origin main)',
      'echo `git push origin main`',
      'bash -c "git push origin main"',
      "sh -c 'git push origin main'",
      'eval git push origin main',
      'git push origin \\\nmain',
      'git pu\\\nsh origin main',
      'if git push origin main; then echo ok; fi',
      'git push "origin" "main"',
      "git push 'origin' 'main'",
      'git push -- origin main',
      'git push --no-verify origin main',
      'git push --repo=origin origin main',
      'git push -o ci.skip origin main',
    ])
  })
})

describe('merge-rule: pushes that pass', () => {
  describe('to another branch', () => {
    defineAllowRows('push', [
      'git push origin feat/x',
      'git push -u origin feat/x',
      'git push',
      'git push origin',
      'git push origin HEAD',
      'git push origin HEAD:refs/heads/feat/x',
      'git push origin main:feat/x',
      'git push origin feat/x:feat/y',
      'git push --follow-tags',
      'git push origin refs/heads/feat/x',
      'git push --no-verify origin feat/x',
      'git push -o ci.skip origin feat/x',
      'git push --repo=origin feat/x',
    ])
  })

  describe('to a name that only contains the default branch name', () => {
    defineAllowRows('push', [
      'git push origin feat/main-fix',
      'git push origin mainline',
      'git push origin main-fix',
      'git push origin refs/heads/main2',
    ])
  })

  describe('tags', () => {
    defineAllowRows('push', [
      'git push origin v1.2.0',
      'git push origin refs/tags/v1.2.0',
      'git push origin tag v1.2.0',
      ['git push --tags', ON_MAIN],
      ['git push --tags origin', ON_MAIN],
    ])
  })

  describe('deleting another branch', () => {
    defineAllowRows('push', [
      'git push origin --delete feat/x',
      'git push origin :feat/x',
      'git push -d origin feat/x',
    ])
  })

  describe('a named branch from another folder', () => {
    defineAllowRows('push', [
      'git -C ../wt push origin HEAD:refs/heads/feat/x',
      'cd ../wt && git push origin feat/x',
    ])
  })

  describe('a different default branch', () => {
    defineAllowRows('push', [
      ['git push origin main', { defaultBranch: 'trunk' }],
      ['git push', { defaultBranch: 'trunk', currentBranch: 'main' }],
    ])
  })

  describe('text that looks like a push but is not one', () => {
    defineAllowRows('push', [
      'git stash push -m main',
      'git commit -m "git push origin main"',
      'echo "git push origin main"',
      'grep -rn "git push origin main" docs',
      'git status # git push origin main',
      "echo 'git push origin main'",
      'git log --grep "git push origin main"',
      'gh pr create --title t --body "$(cat <<\'EOF\'\n## Summary\ngit push origin main\nEOF\n)"',
      'cat <<EOF\ngit push origin main\nEOF',
      'git push-fake origin main',
      'echo git push origin main',
    ])
  })
})

describe('merge-rule: force-push', () => {
  describe('denied', () => {
    defineDenyRows('force-push', [
      'git push --force origin feat/x', // (F)
      'git push -f origin feat/x', // (F)
      'git push -fu origin feat/x', // (F)
      'git push -uf origin feat/x', // (F)
      'git push origin +feat/x', // (F)
      'git push --force-with-lease origin +HEAD:refs/heads/feat/x', // (F)
      'git push --mirror',
      'git push --mirror origin',
      'git push --force origin main',
      'git push --force',
      'git push -f',
      'git push origin +main',
      'git push origin +HEAD',
    ])
  })

  describe('passes', () => {
    defineAllowRows('force', [
      'git push --force-with-lease origin HEAD:refs/heads/feat/539-x', // (F)
      'git push --force-with-lease=feat/x:0a1b2c3 origin feat/x', // (F)
      'git push --force-with-lease --force-if-includes origin feat/x', // (F)
      'git push --force-with-lease origin feat/x', // (F)
      'git push --force-with-lease', // (F)
      'git push --no-force origin feat/x',
      'git push -o force origin feat/x',
      'gh label create "size:S" --color c2e0c6 --force',
      'git worktree remove --force .worktrees/pkg-1',
      'git checkout -f feat/x',
      'git branch -D feat/x',
      'git clean -fd',
    ])
  })
})

describe('merge-rule: admin-merge', () => {
  describe('denied', () => {
    defineDenyRows('admin-merge', [
      'gh pr merge 12 --admin',
      'gh pr merge 12 --squash --admin',
      'gh pr merge --admin=true 12',
      'gh pr merge --admin 12 --squash',
      'env GH_TOKEN=x gh pr merge 12 --admin',
      '/usr/local/bin/gh pr merge 12 --admin',
      "bash -c 'gh pr merge 12 --admin'",
    ])
  })

  describe('passes', () => {
    defineAllowRows('admin', [
      `gh pr merge 12 --squash --auto --match-head-commit ${SHA}`,
      'gh pr merge 12 --disable-auto',
      'gh pr merge 12 --squash --body "never --admin"',
      'gh pr merge 12 --admin=false',
      'gh pr view 12 --json mergeStateStatus',
      'gh pr list --search admin',
    ])
  })
})

describe('merge-rule: branch-rule', () => {
  describe('denied', () => {
    defineDenyRows('branch-rule', [
      `gh api -X PUT ${API}/branches/main/protection --input -`,
      "gh api --method DELETE 'repos/{owner}/{repo}/branches/main/protection'",
      `gh api -XPATCH ${API}/branches/main/protection/required_status_checks -f strict=false`,
      `gh api ${API}/branches/main/protection/enforce_admins -X DELETE`,
      `gh api ${API}/branches/main/protection/required_signatures -f x=y`,
      `gh api -X POST ${API}/rulesets --input r.json`,
      `gh api -X PUT ${API}/rulesets/42 --input -`,
      `gh api --method=DELETE /${API}/rulesets/42`,
      `gh api -X PUT https://api.github.com/${API}/branches/main/protection --input -`,
      `gh api -X put ${API}/branches/main/protection --input -`,
      `gh api --method=put ${API}/branches/main/protection --input -`,
      `gh api -X DELETE orgs/acme/rulesets/42`,
      `gh api ${API}/branches/feat/x/protection -F required=true`,
      `gh api -H 'Accept: application/vnd.github+json' -X PUT ${API}/branches/main/protection --input -`,
      `gh api -X PUT ${API}/branches/main/protection --input -`,
      `gh api -X PUT ${API}/rulesets/42?x=1 --input -`,
    ])
  })

  describe('passes', () => {
    defineAllowRows('branch-rule', [
      `gh api ${API}/branches/main/protection`,
      `gh api ${API}/branches/main/protection --jq .enforce_admins.enabled`,
      `gh api -X GET ${API}/branches/main/protection`,
      "gh api 'repos/{owner}/{repo}/rules/branches/main' --jq length",
      "gh api 'repos/{owner}/{repo}/branches/main' --jq .protected",
      `gh api ${API}/rulesets`,
      `gh api ${API}/rulesets/42`,
      'gh ruleset list',
      'gh ruleset view 42',
      `gh api -X POST 'repos/{owner}/{repo}/statuses/${SHA}' -f state=success -f context=orchestrai/test -f description='x'`,
      `gh api -X PUT 'repos/{owner}/{repo}/pulls/12/update-branch' -f expected_head_sha=${SHA}`,
      `gh api ${API}/branches`,
    ])
  })
})

describe('merge-rule: visibility', () => {
  describe('denied', () => {
    defineDenyRows('visibility', [
      'gh repo edit --visibility private --accept-visibility-change-consequences',
      'gh repo edit acme/widget --visibility=public',
      `gh api -X PATCH ${API} -f visibility=private`,
      `gh api -X PATCH ${API} -F private=true`,
      `gh api --method PATCH ${TEMPLATE_API} --input body.json`,
      `gh api ${API} -X PATCH -f visibility=public`,
      `gh api -X patch ${API} -f visibility=public`,
      `gh api -X PATCH ${API} --field private=false`,
      `gh api -X PATCH ${API} --raw-field=visibility=public`,
      `gh api -X PATCH /${API} -fvisibility=public`,
      `gh api -X PATCH https://api.github.com/${API} -f visibility=private`,
    ])
  })

  describe('passes', () => {
    defineAllowRows('visibility', [
      'gh repo edit --enable-auto-merge',
      'gh repo edit --description "visibility notes"',
      'gh repo view --json visibility',
      `gh api -X PATCH ${API} -f allow_auto_merge=true`,
      `gh api ${TEMPLATE_API} --jq '.allow_auto_merge, .default_branch'`,
      'gh repo create acme/new --private',
      `gh api ${API}`,
      `gh api ${API} --jq .visibility`,
      `gh api -X PATCH ${API} -f description=visibility`,
    ])
  })
})

describe('merge-rule: delete-repo', () => {
  describe('denied', () => {
    defineDenyRows('delete-repo', [
      'gh repo delete',
      'gh repo delete acme/widget --yes',
      `gh api -X DELETE ${API}`,
      "gh api --method DELETE '/repos/{owner}/{repo}'",
      `gh api -XDELETE ${API}`,
      `gh api --method=DELETE ${API}`,
      'env GH_TOKEN=x gh repo delete acme/widget --yes',
      "bash -c 'gh repo delete acme/widget --yes'",
      `gh api -X DELETE https://api.github.com/${API}`,
    ])
  })

  describe('passes', () => {
    defineAllowRows('delete', [
      'gh repo deploy-key delete 7',
      'gh release delete v1 --yes',
      'gh label delete bug --yes',
      `gh api -X DELETE ${API}/labels/bug`,
      `gh api -X DELETE ${API}/git/refs/heads/feat/x`,
      'gh repo view acme/widget',
      'gh issue delete 5 --yes',
      'rm -rf node_modules',
    ])
  })
})

describe('merge-rule: the pipeline commands that must keep working', () => {
  defineAllowRows('pipeline', [
    'git ls-remote --exit-code origin feat/1-x && git fetch origin feat/1-x && git checkout --detach FETCH_HEAD',
    'gh pr ready 12',
    'gh pr ready --undo 12',
    `node "\${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-kickoff/ship-decision.mjs" --track full --head ${SHA}`,
    'git push --force-with-lease origin HEAD:refs/heads/feat/539-guard-core',
    'gh pr create --draft --title "feat: x" --body "Closes #539"',
    'git fetch origin && git checkout --detach origin/main',
    'git add -A && git commit -m "feat: x"',
    'npm test',
  ])
})

describe('merge-rule: how the answer is shaped', () => {
  test('a deny names the group and the entry', () => {
    const answer = run('git push origin main')
    assert.equal(answer.rule, 'merge-rule/push-default')
  })

  test('the reason names the cause of a push-default deny', () => {
    assert.match(run('git push --all').reason, /--all/)
    assert.match(run('git push origin main').reason, /main/)
  })

  test('a deny on an enforced repo carries enforced true', () => {
    assert.equal(run('git push --force origin main').enforced, true)
  })

  test('a deny on a repo off the list carries enforced false', () => {
    assert.equal(run('git push --force origin main', { enforceList: [] }).enforced, false)
  })

  test('the first entry that hits wins: force-push comes before push-default', () => {
    assert.equal(run('git push --force origin main').rule, 'merge-rule/force-push')
  })

  for (const mode of ['bypassPermissions', 'auto', 'dontAsk', undefined, 'someNewMode']) {
    test(`a push to the default branch is denied in mode ${String(mode)}`, () => {
      const answer = decide(
        { tool: 'Bash', input: { command: 'git push origin main' }, mode, folder: '/work/widget' },
        BASE_FACTS,
      )
      assert.equal(answer.decision, 'deny')
      assert.equal(answer.rule, 'merge-rule/push-default')
    })
  }

  for (const mode of ['default', 'manual', 'acceptEdits', 'plan']) {
    test(`a push to the default branch is allowed in mode ${mode}`, () => {
      const answer = decide(
        { tool: 'Bash', input: { command: 'git push origin main' }, mode, folder: '/work/widget' },
        BASE_FACTS,
      )
      assert.equal(answer.rule, 'mode')
    })
  }

  test('the group is not applied in an organization repo', () => {
    assert.equal(run('gh repo delete acme/widget --yes', {}, 'organization').rule, 'organization')
  })

  test('the group ignores tools other than Bash', () => {
    for (const name of ['Edit', 'Write', 'Read', 'PowerShell']) {
      const answer = decide(
        { tool: name, input: { command: 'git push origin main' }, mode: 'bypassPermissions', folder: '/work/widget' },
        BASE_FACTS,
      )
      assert.equal(answer.decision, 'allow', name)
      assert.equal(answer.rule, 'no-rule', name)
    }
  })
})

describe('merge-rule: the rule file says what it does not cover', () => {
  test('the header has a Not covered section', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../../guard/rules/merge-rule.mjs', import.meta.url), 'utf8')
    assert.match(source, /Not covered/)
    for (const topic of ['curl', 'graphql', 'git/refs', 'xargs']) {
      assert.ok(source.includes(topic), `the Not covered header does not mention ${topic}`)
    }
  })
})
