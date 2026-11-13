/**
 * Tests for the merge-rule group of the guard (issue #539, batch #538).
 *
 * The group lives in `.claude/guard/rules/merge-rule.mjs` and has seven entries:
 * push-default, force-push, admin-merge, branch-rule, visibility, delete-repo
 * and api-unknown. Every row runs through `decide` in the two classes where the
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

// Tester round 1 (issue #539). Every row below is a spelling no earlier row
// covered. The rule behind them: a word the guard cannot read is unknown, and
// unknown is denied where the worst reading is one of the entries.

describe('merge-rule round 1, finding 1: gh flags before the subcommand', () => {
  describe('denied', () => {
    defineDenyRows('admin-merge', [
      'gh -R acme/widget pr merge 12 --admin',
      'gh --repo acme/widget pr merge 12 --admin',
      'gh --repo=acme/widget pr merge 12 --admin',
      'gh pr -R acme/widget merge 12 --admin',
      'gh pr --repo acme/widget merge 12 --admin',
      'gh pr --repo=acme/widget merge --admin 12',
      'gh pr merge -R acme/widget 12 --admin',
    ])
    defineDenyRows('delete-repo', [
      'gh -R acme/widget repo delete --yes',
      'gh repo --repo acme/widget delete --yes',
      'gh repo --repo=acme/widget delete',
      'gh -R acme/widget api -X DELETE repos/acme/widget',
    ])
    defineDenyRows('visibility', [
      'gh -R acme/widget repo edit --visibility private',
      'gh repo -R acme/widget edit --visibility=public',
      'gh -R acme/widget api -X PATCH repos/acme/widget -f visibility=private',
    ])
    defineDenyRows('branch-rule', [
      'gh -R acme/widget api -X PUT repos/acme/widget/branches/main/protection --input -',
    ])
  })

  describe('passes', () => {
    defineAllowRows('gh flag', [
      'gh -R acme/widget pr view 12',
      'gh pr -R acme/widget merge 12 --squash --auto',
      'gh --repo acme/widget repo view',
      'gh repo -R acme/widget edit --enable-auto-merge',
      'gh -R acme/widget api repos/acme/widget',
    ])
  })
})

describe('merge-rule round 1, finding 2: gh api with a word the guard cannot read', () => {
  describe('a path with variables, denied by what it ends in', () => {
    defineDenyRows('branch-rule', [
      'gh api -X PUT "repos/$REPO/branches/main/protection" --input rule.json',
      'gh api -X DELETE "repos/$REPO/branches/$B/protection"',
      'gh api -X PATCH "repos/$REPO/branches/main/protection/required_status_checks" -f strict=false',
      'gh api -X POST "repos/$REPO/rulesets" --input r.json',
      'gh api -X PUT "repos/$O/$R/rulesets/42" --input -',
      'gh api -X DELETE "repos/${O}/widget/rulesets/42"',
      'gh api -X DELETE "orgs/$ORG/rulesets/42"',
      'gh api -X "$M" repos/acme/widget/branches/main/protection',
      'gh api -X "$M" "repos/$REPO/rulesets"',
    ])
    defineDenyRows('delete-repo', [
      'gh api -X DELETE "repos/$REPO"',
      'gh api -X DELETE repos/$REPO',
      'gh api -X DELETE repos/$OWNER/$REPO',
      'gh api -X DELETE "repos/${O}/widget"',
      'gh api -X DELETE repos/acme/$R',
      'gh api -X "$M" repos/acme/widget',
      'gh api -X$M repos/acme/widget',
      'gh api --method="$M" repos/acme/widget',
      'gh api -X "$M" "repos/$REPO"',
      'gh api -X "$(echo DELETE)" repos/acme/widget',
    ])
    defineDenyRows('visibility', [
      'gh api -X PATCH "repos/$REPO" -f visibility=private',
      'gh api -X PATCH "repos/$REPO" -F private=true',
      'gh api -X PATCH "repos/$REPO" --input body.json',
      'gh api -X PATCH repos/$OWNER/$REPO -f visibility=public',
      'gh api -X PATCH repos/acme/widget -f "$K=private"',
      'gh api --method PATCH "repos/$REPO" -f visibility="$V"',
    ])
  })

  describe('an endpoint that is entirely unknown, with a write method', () => {
    defineDenyRows('api-unknown', [
      'gh api -X DELETE "$EP"',
      'gh api -X DELETE $(echo repos/acme/widget)',
      'gh api -X PUT "$EP" --input -',
      'gh api "$EP" -f x=y',
      'gh api -X "$M" "$EP"',
      'gh api -X POST "$BASE/branches/main/protection" --input r.json',
    ])
  })

  describe('passes: a literal tail that is something else', () => {
    defineAllowRows('gh api variable', [
      'gh api -X POST "repos/$REPO/statuses/$SHA" -f state=success -f context=orchestrai/test -f description=x',
      'gh api -X PUT "repos/$REPO/pulls/$PR/update-branch" -f expected_head_sha=$SHA',
      'gh api "repos/$REPO"',
      'gh api "repos/$REPO/branches/main/protection"',
      'gh api "repos/$REPO/rulesets"',
      'gh api -X DELETE "repos/$REPO/labels/bug"',
      'gh api -X PATCH "repos/$REPO" -f allow_auto_merge=true',
      'gh api -X PATCH "repos/$REPO" -f description="$D"',
      'gh api -X "$M" repos/acme/widget/labels',
      'gh api "$EP"',
      'gh api -X GET "$EP"',
      'gh api -X DELETE "repos/$REPO/git/refs/heads/feat/x"',
      'gh api -X DELETE repos/acme/widget/labels/rulesets',
    ])
  })
})

describe('merge-rule round 1, finding 3: a branch switch earlier in the line', () => {
  describe('denied: the current branch is no longer known', () => {
    defineDenyRows('push-default', [
      'git checkout main && git push',
      'git switch main && git push',
      'git checkout main; git push origin HEAD',
      'git checkout -- file.txt && git push',
      'git checkout main && git push origin @',
      'git checkout main && git push -u origin HEAD',
      "bash -c 'git checkout main && git push'",
      'git -c advice.detachedHead=false switch main && git push',
      'git -C ../wt checkout main && git push',
      'git switch -c feat/y && git commit -m x && git push',
    ])
  })

  describe('passes: the push names its branch', () => {
    defineAllowRows('switch', [
      'git checkout -b feat/x && git push -u origin feat/x',
      'git switch main && git push origin feat/x',
      'git switch -c feat/y && git push origin feat/y:feat/y',
      'git checkout feat/x && git push origin HEAD:refs/heads/feat/x',
      'git push && git checkout main',
      'git checkout main',
    ])
  })
})

describe('merge-rule round 1, finding 4: an expanding word in the remote position', () => {
  // The word in the remote position can hide a refspec: an unquoted
  // `$REMOTE` that holds "origin main" splits into two words. The parser does
  // not record whether a word was quoted, so a quoted one is denied as well.
  describe('denied', () => {
    defineDenyRows('push-default', [
      'git push $ARGS',
      'git push $(echo origin main)',
      'git push "$REMOTE"',
      'git push "$REMOTE" feat/x',
      'git push $REMOTE feat/x',
      'git push -u "$REMOTE" feat/x',
      'git push `echo origin main`',
    ])
  })
})

describe('merge-rule round 1, finding 5: heads/<x> as a destination', () => {
  defineDenyRows('push-default', [
    'git push origin feat/x:heads/main',
    'git push origin heads/main',
  ])
  defineAllowRows('heads', [
    'git push origin feat/x:heads/feat/y',
    'git push origin heads/feat/y',
  ])
})

describe('merge-rule round 1, finding 7: -f=name=value', () => {
  defineDenyRows('visibility', [
    'gh api -X PATCH repos/acme/widget -f=private=true',
    'gh api -X PATCH repos/acme/widget -F=visibility=public',
    'gh api -X=PATCH repos/acme/widget -f visibility=private',
  ])
  defineAllowRows('field', [
    'gh api -X PATCH repos/acme/widget -f=allow_auto_merge=true',
    'gh api -X=GET repos/acme/widget',
  ])
})

describe('merge-rule round 1, finding 8: a variable in the destination', () => {
  // Denied even when it would be harmless. The fix is to write the branch
  // name out in the command.
  defineDenyRows('push-default', [
    'git push --force-with-lease origin HEAD:refs/heads/$BRANCH',
    'git push --force-with-lease origin "HEAD:refs/heads/${BRANCH}"',
  ])
  defineAllowRows('literal branch', [
    'git push --force-with-lease origin HEAD:refs/heads/feat/539-guard-core',
  ])
})

describe('merge-rule round 1: pipeline commands written with variables still pass', () => {
  defineAllowRows('pipeline', [
    'git fetch origin "$BRANCH" && git checkout --detach FETCH_HEAD',
    'gh pr merge "$PR" --squash --auto --match-head-commit "$SHA"',
    'gh pr ready "$PR"',
    'gh api -X POST "repos/$REPO/statuses/$SHA" -f state=success -f context=orchestrai/review -f description="ok"',
    'gh api "repos/$REPO/pulls/$PR" --jq .head.sha',
    'gh label create "size:S" --color c2e0c6 --force',
    'git push --force-with-lease origin HEAD:refs/heads/feat/12-x',
  ])
})

// Tester round 2 (issue #539).

describe('merge-rule round 2, finding 2: git commands that can move HEAD onto a branch', () => {
  // After any earlier git command in the line, the current branch is unknown,
  // unless the command is on the list of commands that never change which
  // branch is checked out. A push that names its destination is judged by it.
  describe('denied: a bare push, or a push of HEAD, after a command not on the list', () => {
    defineDenyRows('push-default', [
      'git branch -M main && git push',
      'git branch -m main && git push',
      'git branch --move main && git push',
      'git rebase main main && git push',
      'git rebase --onto x y main && git push',
      'git symbolic-ref HEAD refs/heads/main && git push',
      'git bisect reset main && git push',
      'git checkout main && git push',
      'git switch main && git push origin HEAD',
      'git worktree add ../w main && git push',
      'git checkout -- file.txt && git push',
      'git -C ../x branch -M main && git push',
      "bash -c 'git branch -M main && git push'",
      'git branch -M main; git push origin @',
      'git $SUB main && git push',
      'git && git push',
      'git -c x=y && git push',
    ])
  })

  describe('passes: commands on the list, and pushes that name their branch', () => {
    defineAllowRows('git list', [
      'git add -A && git commit -m x && git push',
      'git fetch origin && git merge origin/main && git push',
      'git pull --rebase && git push',
      'git stash && git push',
      'git commit --amend --no-edit && git push --force-with-lease origin HEAD:refs/heads/feat/1-x',
      'git rebase origin/main && git push --force-with-lease origin HEAD:refs/heads/feat/1-x',
      'git checkout --detach FETCH_HEAD && git push --force-with-lease origin HEAD:refs/heads/feat/1-x',
      'git branch -D feat/old && git push origin feat/1-x',
      'git status && git log --oneline && git diff && git push',
      'git tag v1 && git push',
      'git ls-remote origin && git remote -v && git push',
      'git reset --hard origin/feat/1-x && git push',
      'git cherry-pick abc && git revert def && git push',
      'git push && git push',
    ])
  })

  describe('every command on the list keeps the branch known', () => {
    const list = [
      'add', 'commit', 'status', 'fetch', 'pull', 'merge', 'log', 'diff', 'show', 'tag', 'stash', 'reset',
      'restore', 'rm', 'mv', 'rev-parse', 'remote', 'config', 'ls-remote', 'ls-files', 'describe',
      'cherry-pick', 'revert', 'clean', 'blame', 'grep', 'format-patch', 'apply', 'am', 'gc', 'notes',
      'shortlog', 'cat-file', 'diff-tree', 'for-each-ref', 'rev-list', 'merge-base', 'update-index', 'push',
    ]
    defineAllowRows('git list', list.map((sub) => `git ${sub} x && git push`))
  })
})

describe('merge-rule round 3: git stash branch checks out a new branch', () => {
  // `stash` stays on the list of commands that keep the branch known, except
  // its `branch` form. After `git stash branch <name>` the current branch is
  // unknown, whatever the name, the same way it is after a checkout.
  describe('denied', () => {
    defineDenyRows('push-default', [
      'git stash branch main && git push',
      'git stash branch main && git push origin HEAD',
      'git stash branch feat/x && git push',
      'git -C . stash branch main && git push',
      'git stash branch main stash@{0} && git push',
      'git stash -q branch main && git push',
      'git stash $VERB main && git push',
    ])
  })

  describe('passes', () => {
    defineAllowRows('stash', [
      'git stash && git push',
      'git stash push -m wip && git push',
      'git stash push -m branch && git push',
      'git stash pop && git push',
      'git stash list && git push',
      'git stash drop && git push',
      'git stash apply && git push',
      'git stash branch feat/x && git push origin feat/x',
      'git stash branch feat/x && git push --force-with-lease origin HEAD:refs/heads/feat/x',
    ])
  })
})

describe('merge-rule round 2, finding 3: a flag that expands in gh pr merge and gh repo edit', () => {
  describe('denied', () => {
    defineDenyRows('admin-merge', [
      'gh pr merge 12 --$F',
      'gh pr merge 12 "--adm$in"',
      'gh pr merge 12 --admin=$V',
      'gh pr merge 12 -$F',
      'gh -R acme/widget pr merge 12 --$F',
    ])
    defineDenyRows('visibility', [
      'gh repo edit --$OPT private',
      'gh repo edit "--vis$X" private',
      'gh repo edit acme/widget --visibility=$V',
    ])
  })

  describe('passes: a word that is entirely an expansion, or a value that expands', () => {
    defineAllowRows('gh expansion', [
      'gh pr merge "$PR" --squash --auto --match-head-commit "$SHA"',
      'gh pr merge $PR --disable-auto',
      'gh repo edit "$REPO" --enable-auto-merge',
      'gh pr merge 12 --match-head-commit=$SHA',
      'gh pr merge 12 --subject "$S"',
      'gh pr merge 12 --body "$B" --squash',
      'gh repo edit --description "$D"',
    ])
  })

  describe('not covered: a flag hidden entirely inside an expansion', () => {
    // The "Not covered" header of rules/merge-rule.mjs names these two. The
    // guard reads the words as written; the flag only shows when the shell runs
    // the substitution. These rows pin the gap.
    defineAllowRows('hidden flag', [
      'gh pr merge 12 $(echo --admin)',
      'gh repo edit $(echo --visibility) private',
    ])
  })
})

describe('merge-rule round 2, finding 4: more shell spellings', () => {
  defineDenyRows('push-default', [
    "bash -c -l 'git push origin main'",
    "sh -c -e 'git push origin main'",
    "$SHELL -c 'git push origin main'",
    "\"$SH\" -lc 'git push origin main'",
    "${SHELL} --login -c 'git push origin main'",
  ])
  defineAllowRows('shell', [
    "bash -c -l 'git push origin feat/x'",
    "$SHELL -c 'git status'",
  ])
})

describe('merge-rule round 2, finding 5: protection in a gh api path', () => {
  describe('denied', () => {
    defineDenyRows('branch-rule', [
      'gh api "repos/$REPO/$X/main/protection" --method PUT --input -',
      'gh api "repos/$REPO/branches/$B/$X" --method DELETE',
      'gh api -X PUT "repos/$REPO/protection" --input -',
      'gh api -X "$M" "repos/$REPO/$X/main/protection"',
      'gh api -X DELETE "repos/$O/$R/branches/main/$X"',
    ])
  })

  describe('passes', () => {
    defineAllowRows('protection', [
      'gh api "repos/$REPO/branches/$B"',
      'gh api -X POST "repos/$REPO/branches/$B/rename" -f new_name=x',
      'gh api "repos/$REPO/branches/main/protection"',
      'gh api "repos/$REPO/$X/main/protection"',
      'gh api "repos/$REPO/$X" --method PUT',
      'gh api -X POST "repos/$REPO/statuses/$SHA" -f state=success -f context=orchestrai/test',
    ])
  })
})

// Reviewer round 1 (issue #539).

describe('merge-rule review round 1, finding 2: another folder named through the environment', () => {
  describe('denied: a bare push is judged against another folder', () => {
    defineDenyRows('push-default', [
      'GIT_DIR=../other/.git git push',
      'GIT_WORK_TREE=../w git push',
      'env -C ../other git push',
      'sudo -D ../other git push',
      'env GIT_DIR=../other/.git git push',
      'env --chdir=../other git push',
      'env --chdir ../other git push',
      "GIT_DIR=../other/.git bash -c 'git push'",
      'GIT_DIR=../other/.git git push origin HEAD',
    ])
  })

  describe('passes: the push names its branch, or the variable is unrelated', () => {
    defineAllowRows('environment', [
      'GIT_DIR=../o/.git git push origin feat/x',
      'env -C ../o git push origin feat/x',
      'FOO=1 git push',
      'env FOO=1 git push',
      'GIT_TRACE=1 git push',
    ])
  })
})

describe('merge-rule review round 1, finding 3: a git or gh subcommand that expands', () => {
  describe('denied', () => {
    defineDenyRows('push-default', [
      'git $GIT_OPTS push origin main',
      'git $SUB origin main',
      'git "$SUB" origin main',
      'git $SUB origin HEAD:refs/heads/main',
    ])
    defineDenyRows('admin-merge', [
      'gh pr $S 12 --admin',
      'gh $G merge 12 --admin',
      'gh pr "$S" 12 --admin',
    ])
    defineDenyRows('delete-repo', [
      'gh repo $S acme/widget --yes',
      'gh $G delete acme/widget --yes',
    ])
    defineDenyRows('visibility', [
      'gh repo $S --visibility private',
      'gh $G edit --visibility private',
    ])
  })

  describe('passes: a word after the subcommand that expands is not the subcommand', () => {
    defineAllowRows('subcommand', [
      'gh pr merge "$PR" --squash --auto --match-head-commit "$SHA"',
      'gh pr ready "$PR"',
      'gh repo edit "$REPO" --enable-auto-merge',
      'gh issue edit "$N" --add-label in-progress',
      'git fetch origin "$BRANCH" && git checkout --detach FETCH_HEAD',
    ])
  })
})

describe('merge-rule review round 1, finding 4: gh api paths whose segments expand', () => {
  describe('denied', () => {
    defineDenyRows('branch-rule', [
      'gh api -X POST "repos/acme/widget/$X" --input r.json',
      'gh api -X POST "orgs/acme/$X" --input r.json',
      'gh api -X DELETE "repos/$O/$R/$X"',
      'gh api -X POST "repos/acme/$R/$X" --input r.json',
      'gh api -X POST "orgs/$ORG/$X" --input r.json',
    ])
    defineDenyRows('delete-repo', [
      'gh api -X DELETE "repos/$A/$B"',
    ])
  })

  describe('passes: a literal resource word after the repo part', () => {
    // `repos/$REPO/$X` stays allowed: it has the same shape as `repos/$O/$R`,
    // which is a repo path, and an earlier decision keeps a PUT to it allowed.
    // The Not covered header names it.
    defineAllowRows('gh api expansion', [
      'gh api -X POST "repos/acme/widget/statuses/$SHA" -f state=success',
      'gh api -X POST "repos/$O/$R/statuses/$SHA" -f state=success',
      'gh api -X PUT "repos/acme/widget/pulls/$PR/update-branch" -f expected_head_sha=$SHA',
      'gh api -X POST "repos/$REPO/$X" --input r.json',
      "gh api -X POST 'repos/acme/widget/$X' --input r.json",
    ])
  })
})

describe('merge-rule review round 1, finding 5: escapes in $\'...\'', () => {
  defineDenyRows('delete-repo', [
    "gh api -X DELETE $'\\x72epos/acme/widget'",
    "gh api -X DELETE $'\\162epos/acme/widget'",
    "gh api -X $'DELE\\x54E' repos/acme/widget",
  ])
  defineDenyRows('push-default', [
    "git push origin $'\\x6dain'",
    "git push origin $'ma\\151n'",
  ])
  defineAllowRows('ansi-c', [
    "gh api -X DELETE $'repos/acme/widget/labels/bug'",
  ])
})

describe('merge-rule review round 1, finding 7: positional parameters', () => {
  defineDenyRows('push-default', [
    'git push origin "$1"',
    'git push "$@"',
    'git push origin $?',
    'git push $*',
  ])
})

describe('merge-rule review round 1, finding 9: an empty branch fact is unknown', () => {
  defineDenyRows('push-default', [
    ['git push origin main', { defaultBranch: '' }],
    ['git push origin feat/x', { defaultBranch: '' }],
    ['git push', { currentBranch: '' }],
    ['git push origin HEAD', { currentBranch: '' }],
  ])
  defineAllowRows('empty branch', [
    ['git push origin feat/x', { currentBranch: '' }],
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
    // Header lines wrap, so the comment markers are folded into single spaces.
    const source = readFileSync(new URL('../../guard/rules/merge-rule.mjs', import.meta.url), 'utf8')
      .replace(/\s*\n\s*\*\s*/g, ' ')
    assert.match(source, /Not covered/)
    const topics = [
      'curl', 'graphql', 'git/refs', 'xargs', '<<<', 'piped into a shell',
      'variable in its destination', 'write the branch name out', 'inside a variable or substitution',
      'never change which branch',
      // the boundary sentence
      'The group reads Bash calls only', 'it reads the words as written',
      'A word that expands is denied only where this header says so',
      // review round 1, finding 1
      'MCP tools', 'held in a variable', 'gh pr checkout', 'pulls/<n>/merge', 'transferring',
      'watch, flock, caffeinate, direnv exec', '${...}', 'case', 'assignment prefix', 'repos/$REPO/$X',
    ]
    for (const topic of topics) {
      assert.ok(source.includes(topic), `the Not covered header does not mention ${topic}`)
    }
  })
})
