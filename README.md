# docs-doctor

**Which of your docs have quietly fallen behind the code?** docs-doctor asks git, and answers in commits.

```
$ docs-doctor
SYSTEM             DOC AGE  CODE AGE  DRIFT        STATUS
carrier-scrape     34d      1d        28 commits   stale
commissions        9d       3d        4 commits    behind
object-storage     12d      —         unmapped     unmapped
firelight          2d       2d        0 commits    fresh

4 docs · 2 need attention · worst drift 28 commits

Start with: docs-doctor explain carrier-scrape
```

```
$ docs-doctor explain carrier-scrape
carrier-scrape (docs/system/carrier-scrape/README.md)
  status stale · 28 commits of drift
  code   src/carrier-scraper/**, src/packages/carrier-book/**

Commits the doc has not caught up with:
  4f21ac09  2026-09-17  Ada    fix: count rows nobody could read
  9c0e7731  2026-09-15  Lin    feat: settle findings in bulk
  …
```

## Why

Documentation doesn't announce that it's wrong. It just ages, until someone follows it into a wall. Linters check a doc's *style*; nothing checks whether it still matches the code it describes.

Drift is counted in **commits**, not days, because "28 commits since anyone updated this" is the number that gets a doc fixed. A doc nobody has touched in six months is fine if its code hasn't moved either.

This matters more now that AI agents read your docs before they plan. A stale doc doesn't just mislead people; it misleads every agent that trusts it.

## Install

Needs **Node 22+**, git, and no dependencies.

```bash
npm install -g github:prroha/docs-doctor
docs-doctor
```

Or clone and run `bin/docs-doctor.mjs` directly.

## How a doc says what it documents

Each doc declares its own code paths in front matter, so the mapping travels with the doc and gets reviewed in the same pull request:

```markdown
---
title: Carrier scrape
code:
  - src/carrier-scraper/**
  - src/packages/carrier-book/**
ignore:
  - src/carrier-scraper/**/__tests__/**
---

# Carrier scrape
```

Paths are git pathspecs, so `**` works as you'd expect and `ignore` entries are excluded.

**No front matter?** docs-doctor guesses from the directory (`docs/system/scraper/README.md` → paths containing `scraper`) and marks the result `unmapped` if the guess matches nothing, so unmapped docs are visible rather than silently "fine".

## Statuses

| Status | Meaning |
|---|---|
| `fresh` | The code hasn't moved since the doc did |
| `behind` | A few commits ahead of the doc, under the stale threshold |
| `stale` | Past the threshold: 10 commits of drift, or any drift older than 30 days |
| `unmapped` | The doc declares no code, or its guess matched nothing |
| `orphan` | The code the doc names no longer exists |
| `untracked` | The doc isn't committed yet |

`stale`, `unmapped` and `orphan` count as needing attention; `--ci` exits 2 when any doc does.

## Commands

```bash
docs-doctor                      # the table
docs-doctor --stale              # only what needs attention
docs-doctor --json               # for a dashboard or a bot
docs-doctor --ci                 # exit 2 if anything needs attention
docs-doctor explain <name>       # the commits a doc hasn't caught up with
docs-doctor new <name>           # scaffold README, TODO and FEEDBACK
```

| Option | Meaning |
|---|---|
| `--docs <glob>` | Where the docs are; repeatable. Default: `docs/**/*.md`, `doc/**/*.md`, `*.md` |
| `--stale-commits <n>` | Commits of drift that mean stale (default 10) |
| `--stale-days <n>` | Days of drift that mean stale (default 30) |
| `--dir <path>` | Run against another repository |
| `-v`, `--version` · `-h`, `--help` | Version, help |

Exit codes: `0` fine · `1` bad usage · `2` docs need attention (`--ci`) · `3` not a git repository.

## In CI

Fail the build when docs fall behind:

```yaml
- run: npx github:prroha/docs-doctor --ci
```

Start gently on an existing codebase: `--stale-commits 50` first, then tighten as you catch up. Or gate only the systems that matter:

```bash
docs-doctor --ci --docs "docs/system/billing/**/*.md"
```

## With an AI coding agent

Agents plan from your docs, so the stale ones do real damage. Two useful habits:

```bash
docs-doctor --stale --json     # before planning: which docs not to trust
docs-doctor explain <system>   # after changing code: what the doc now misses
```

Paste into your `CLAUDE.md`, `AGENTS.md` or `.cursorrules`:

```markdown
Before planning work on a system, run `docs-doctor explain <system>`. If the doc
is stale, read the commits it lists rather than trusting the doc. After changing
code, update the doc in the same change.
```

## Scaffolding

```bash
docs-doctor new payments
# created:
#   docs/system/payments/README.md
#   docs/system/payments/TODO.md
#   docs/system/payments/FEEDBACK.md
```

The README template carries the front matter and the headings worth having: what it does, entry points, how it works, key decisions, invariants, gotchas. `TODO.md` records known gaps between the doc and the code; `FEEDBACK.md` collects notes for a later pass.

## How it works

1. `git ls-files` finds the docs matching your patterns.
2. Each doc's front matter gives its code paths; `git ls-files` expands them.
3. `git log -1` gives the last commit for the doc and for its code.
4. `git log --since` counts the commits that touched the code after the doc last changed. That count is the drift.
5. Thresholds turn drift into a status.

Everything except the `git` calls is a pure function, which is why the unit tests need no repository.

## Tests

```bash
npm test            # unit tests, then the end-to-end suite
npm run test:unit   # 22 tests on pure logic, milliseconds
npm run test:cli    # 27 tests against throwaway git repos with fixed commit dates
```

The end-to-end tests build real repositories where the history is known in advance — a doc left behind by twelve commits, a doc kept in step, a doc whose code was deleted — and assert what the tool reports.

## Limitations

- **Drift is a signal, not proof.** A formatting change counts as a commit; a subtle behaviour change might not need a doc edit. Use it to decide where to look.
- **Renames** are counted as commits touching the path, which is usually what you want, but a big directory move will light everything up once.
- **Shallow clones** have no history to count. Use `fetch-depth: 0` in CI.
- **Monorepos with many docs** run one `git log` per doc; on hundreds of docs that takes a few seconds.

## License

MIT
