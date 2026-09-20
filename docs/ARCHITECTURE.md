---
title: architecture
code:
  - bin/**
  - lib/**
---

# Architecture

How docs-doctor is put together, why it is shaped this way, and where to change
things.

## The idea in one line

**A doc declares the code it describes; git already knows when each last changed;
the number of commits in between is the drift.**

No index, no database, no watcher, no dependencies. Two `git log` calls per doc
and some arithmetic.

## Shape

```
  --docs pathspecs                       front matter of each doc
        |                                        |
        v                                        v
  git.docFiles                           frontmatter.parseFrontMatter
  (git ls-files)                         frontmatter.inferCodePaths
        |                                        |
        |   list of doc paths                    |  code: / ignore:
        |                                        v
        |                                scan.withExclusions
        |                                (the pathspec given to git)
        \________________  ______________________/
                         \/
                   scan.inspect                    ← one per doc, 8 at a time
                    |        |
                    |        └─ git.lastCommitFor(codePaths)   ─┐
                    └─ git.lastCommitFor([docPath])             ├─ git log -1
                                    |                           │
                       git.countCommitsSince(docTime, codePaths) ─ git rev-list
                                    |
                                    v
                           drift.classify  →  fresh | behind | stale
                                              unmapped | orphan | untracked
                                    |
                    ┌───────────────┼────────────────┐
                    v               v                v
            drift.renderTable   JSON.stringify   bin: explainOne
              (the table)         (--json)       (git.commitsSince)
```

Everything flows one way. `frontmatter.mjs` and `drift.mjs` know nothing about
git or the filesystem; `git.mjs` knows nothing about docs; `scan.mjs` is the only
module that joins the two; `bin/docs-doctor.mjs` only parses arguments and
prints.

## The modules

| Module | Lines | Responsibility | Depends on |
|---|---|---|---|
| `lib/frontmatter.mjs` | 93 | Read `title`, `code`, `ignore` out of a doc's front matter; name a system; guess a mapping when none is declared | nothing |
| `lib/drift.mjs` | 119 | Turn two timestamps and a commit count into a status; summarise; render the table | nothing |
| `lib/git.mjs` | 121 | Every subprocess: `rev-parse`, `log`, `rev-list`, `ls-files`. Plus bounded-concurrency `mapConcurrently` | `node:child_process` |
| `lib/scan.mjs` | 131 | The join: find docs, build each pathspec, ask git, classify. `scan`, `inspect`, `withExclusions`, `explain` | all three above |
| `bin/docs-doctor.mjs` | 355 | Argument parsing, command dispatch, the `new` templates, output, exit codes | `drift`, `git`, `scan` |
| `test/unit.test.mjs` | 232 | 22 tests on the pure modules, no git, no filesystem | — |
| `test/cli.test.sh` | 264 | End-to-end against throwaway repositories with fixed commit dates | — |

`bin/docs-doctor.mjs` has a shebang and is the `bin` entry in `package.json`, so
a clone runs without a build step. Node 22+, ESM, zero dependencies.

## The data model

One object per doc, built by `scan.inspect` and passed unchanged into `--json`:

```js
{
  name,                 // title:, else the directory (for README.md), else the filename
  doc,                  // repository-relative path, as git reports it
  codePaths,            // the declared (or guessed) patterns, before exclusions
  ignorePaths,          // ignore: from the front matter
  inferredMapping,      // true when the mapping was guessed, not declared
  matchedFileCount,     // 1 if the code pathspec has any commit at all, else 0
  deadPatterns,         // declared patterns matching no tracked file
  docCommittedAtMs,     // committer date of the doc's last commit, or null
  codeCommittedAtMs,    // committer date of the code's last commit, or null
  driftCommits,         // commits touching the code after docCommittedAtMs
  status,               // from drift.classify
}
```

`docCommittedAtMs` is the **baseline**: the moment the doc was last known to
match. Everything else is measured from it. It is a committer date (`%ct`), not
an author date, because `git log --since` filters on committer date — mixing the
two clocks would inflate drift on any rebased or cherry-picked history. The
consequence is that rebasing a doc's commit moves its baseline forward and resets
its drift, which is the honest reading: on that history, that is when the doc
last landed.

`matchedFileCount` is misnamed — it is a 0/1 flag, not a count. It exists only so
`bin`'s `nextStep` can spot the dangerous case: a mapping that still matches
*something* while also listing dead patterns, so the doc reads as current while
covering code nobody is checking.

## Three ideas that drive most of the code

### 1. The mapping lives in the doc, not in a config file

A doc says what it documents in its own front matter:

```markdown
---
title: Billing
code:
  - src/billing/**
ignore:
  - src/billing/**/__tests__/**
---
```

The point is review: moving `src/billing` and forgetting the mapping shows up in
the same pull request as the move. A central config file is edited by nobody and
rots faster than the docs it tracks.

`parseFrontMatter` is deliberately **not a YAML parser**. It takes the lines
between two `---` fences, reads `key: value` pairs, and treats exactly two keys
(`code`, `ignore`) as lists — accepting a block list, an inline `[a, b]` list, or
a bare scalar promoted to a one-element list. Anything it does not understand is
skipped rather than rejected. An unterminated opening fence is not front matter
at all, so a doc that happens to start with a horizontal rule is left alone.

When there is no `code:`, `inferCodePaths` guesses `**/<name>/**` from the
directory and returns `inferred: true`. The flag matters: a guess that matches
nothing is reported `unmapped`, never `fresh`. A bare `README.md` at the root
gets no guess at all (the name would be "README"), so the project README reports
`unmapped` until you map it or scope the run with `--docs`.

### 2. git does the glob expansion, and pathspecs are never expanded into files

`git.mjs` hands patterns straight to git. `trackedFiles` is `git ls-files --
<patterns>`; `lastCommitFor` is `git log -1 -- <patterns>`. This buys two things:
one definition of "tracked file" (so untracked and ignored files never count as
drift), and no glob dependency.

The default doc patterns carry explicit glob magic:

```js
[":(glob)docs/**/*.md", ":(glob)doc/**/*.md", ":(glob)*.md"]
```

`:(glob)` makes `**` mean "zero or more directories" and stops a single `*` from
crossing a slash — which is what makes the third pattern root-level only, while
`docs/**/*.md` matches both `docs/api.md` and `docs/system/api/README.md`.

Code paths go to git as patterns too, never as an expanded file list. A mapping
like `src/**` in a monorepo would otherwise produce an argument list long enough
to fail. This is also why drift is counted with `rev-list --count` rather than by
formatting and parsing every commit: the count is all a drift number needs.

Scans run `mapConcurrently(docs, inspect, 8)`: enough git processes in flight to
hide their startup cost, capped so a large repository does not fork hundreds at
once.

### 3. Drift is counted in commits, and the doc's own commit must not count

`countCommitsSince` runs:

```
git rev-list --count --since=<baseline + 1s> HEAD -- <codePaths and exclusions>
```

Counting commits rather than days is a persuasion decision, stated plainly in the
code: "28 commits since anyone updated this" gets a doc fixed where "34 days"
does not, and a doc untouched for a year is fine if its code has not moved
either.

The `+ 1000` milliseconds in `sinceArgument` is load-bearing. The common good
case is a commit that changes the code *and* the doc together; without the
offset that very commit would be counted as drift against itself and no doc could
ever be fresh. The cost is that a code commit sharing a whole second with the
doc's commit is not counted — a fair trade at one-second resolution.

`classify` then applies thresholds in a fixed order, and the order is the design:

1. no code paths at all → `unmapped`
2. the doc has no commit → `untracked`
3. the code has no commit → `orphan` if the mapping was declared, `unmapped` if
   it was guessed (a guess that misses is the tool's fault, not the repository's)
4. `driftCommits >= staleCommits` (10) → `stale`
5. any drift at all, sitting for `staleDays` (30) or more → `stale`
6. `driftCommits >= behindCommits` (1) → `behind`
7. otherwise `fresh`

Rule 5 is why a doc two commits behind for three months is escalated: a small
gap that nobody closes is a gap nobody is looking at. `needsAttention` covers
`stale`, `unmapped` and `orphan` — the three states where the tool cannot tell
you the doc is trustworthy. `behind` is not one of them, so ordinary churn does
not fail a build.

## Which docs are deliberately exempt

There are two separate exemptions, and they solve two different failure modes.

**A companion file is not a system.** `scan.mjs` holds:

```js
const COMPANION_FILES = new Set(["todo.md", "feedback.md", "changelog.md"]);
```

Any doc whose basename (lower-cased) is in that set is dropped from the scan
unless `--all` is passed. A `TODO.md`, `FEEDBACK.md` or `CHANGELOG.md` documents
no code of its own — it belongs to the README beside it. Counted as systems they
would each report `unmapped`, so `docs-doctor new payments`, which scaffolds
exactly a README plus a TODO and a FEEDBACK, would immediately fail its own
`--ci` with two docs that can never be mapped. `--all` exists for anyone who does
want to track a CHANGELOG against code.

**A guessed mapping must not match its own siblings.** `withExclusions` builds
the pathspec actually given to git:

```js
[...paths,
 `:(exclude)${docPath}`,                                  // always
 `:(exclude,glob)${dirname(docPath)}/**/*.md`,            // only when inferred
 ...ignore.map((p) => `:(exclude)${p}`)]
```

The doc excludes itself always, so editing the doc never registers as its own
code moving. The second exclusion applies only to a *guessed* mapping, and it is
the subtler bug: `docs/system/widgets/README.md` with no front matter guesses
`**/widgets/**`, which matches `docs/system/widgets/TODO.md`. Without the
exclusion the README's own companion files are its "code", the last code commit
exists, drift is zero, and a doc tied to nothing reports `fresh`. With it, the
mapping matches nothing, `codeCommittedAtMs` is null, and a guessed mapping with
no match reports `unmapped`. The CLI test "a README whose only match is its own
TODO is unmapped, not fresh" pins exactly this.

Declared mappings are not given that exclusion, because a doc that explicitly
declares a path to markdown means it.

## Dead patterns

For a declared mapping, `inspect` runs one `git ls-files -z -- <pattern>` per
pattern and collects those matching nothing into `deadPatterns`. Guessed mappings
are skipped: a guess that misses is already `unmapped`, and checking every guess
would cost a git call for nothing.

This catches the case the status codes cannot. A doc declaring
`[src/ledger/**, src/ledger-archive/**]` where the archive was deleted still gets
a real last-code-commit from the surviving path, so it classifies as `fresh` or
`behind` while silently covering less than it claims. `explain` prints a
`WARNING:` line and `nextStep` promotes it above `unmapped` in the suggestions,
with the reason spelled out: "Fix the mapping, or its drift is understated."

## A worked trace: `docs-doctor explain scraper`

```
main()
 ├─ parseArguments(["explain", "scraper"])
 │    → { command: "explain", target: "scraper", docPatterns: DEFAULT_DOC_PATTERNS, … }
 ├─ repositoryRoot(cwd)                     git rev-parse --show-toplevel
 └─ explainOne(options, root)
      ├─ scan({root, docPatterns, thresholds, includeCompanions:false})
      │    ├─ docFiles(patterns)            git ls-files -- :(glob)docs/**/*.md …
      │    ├─ filter out todo/feedback/changelog
      │    └─ mapConcurrently(docs, inspect, 8)
      │         └─ inspect("docs/system/scraper/README.md")
      │              ├─ readDoc → parseFrontMatter   → { code: ["src/scraper/**"] }
      │              ├─ inferCodePaths               → { paths:[…], inferred:false }
      │              ├─ withExclusions               → ["src/scraper/**",
      │              │                                  ":(exclude)docs/system/scraper/README.md"]
      │              ├─ lastCommitFor([docPath])     git log -1 --format=… -- <doc>
      │              ├─ lastCommitFor(codePaths)     git log -1 --format=… -- <pathspec>
      │              ├─ countCommitsSince(docTime)   git rev-list --count --since=… HEAD -- <pathspec>
      │              ├─ matchesAnything per pattern  git ls-files -z -- src/scraper/**
      │              └─ classify(system)             → "stale" (12 >= 10)
      ├─ find the system by name or by doc path
      ├─ explain({root, docPath, limit:20})
      │    └─ inspect(…) again, then commitsSince()  git log --format=… --since=… -20 -- <pathspec>
      └─ print status, code paths, dead-pattern warning, then the commit list
```

`explain` re-runs `inspect` and re-parses the front matter even though `scan`
just did both. That is three reads of the same doc and a duplicate set of git
calls for one command. It keeps `explain` usable on its own — `scan.explain` is
a complete entry point that takes only a root and a doc path — at the cost of
roughly doubling the work of the `explain` command. On one doc it is not worth
optimising.

## Output and exit codes

`check` sorts by `driftCommits` descending so the worst doc is the first line,
prints the fixed-width table, a one-line summary, and then a **single** next
step from `nextStep`. That function is ordered by what is most likely to be
actionable:

1. nothing is mapped at all → show the front-matter snippet, because the tool has
   nothing to say until a doc declares something
2. a `stale` doc exists → `docs-doctor explain <doc>`
3. a partly dead mapping → name the dead patterns
4. an `unmapped` doc → add front matter, or narrow the run with `--docs`
5. otherwise → "Every doc is current."

`--ci` is not a separate mode. It runs the normal report — the table still
prints, so the build log shows what failed — and only then, if
`summary.needsAttention > 0`, exits 2. It composes with `--stale`, `--json` and
`--docs`, which is what makes gating one subsystem possible:

```bash
docs-doctor --ci --docs "docs/system/billing/**/*.md"
```

Note the counts in the summary line come from `summary`, which covers every
scanned doc, while `--stale` filters only the table. The number is deliberately
the whole repository's; the table is the shortlist.

| Exit | Meaning |
|---|---|
| 0 | Ran and, under `--ci`, nothing needs attention |
| 1 | Bad usage, or any error surfaced by `fail()` |
| 2 | `--ci` and at least one doc is stale, unmapped or an orphan |
| 3 | `--dir` is not inside a git repository |

Every failure becomes a `docs-doctor: <message>` line on stderr, never a stack
trace. `GitError` carries git's own stderr. A doc that is tracked but missing
from the working tree — deleted and not committed, or a sparse checkout — is read
as the empty string rather than crashing the scan, which makes it `unmapped`.

One consequence of `git ls-files` being the source of truth: a doc that has never
been `git add`ed does not appear in the report at all. The `untracked` status is
reached only by a doc that is staged but not yet committed — in the index, so
`ls-files` lists it, but with no commit, so `lastCommitFor` returns null.

## Testing

| File | Covers |
|---|---|
| `test/unit.test.mjs` | Front-matter parsing, name and mapping inference, every branch of `classify`, `summarize`, `toRows`, table alignment, git log-line parsing |
| `test/cli.test.sh` | The real binary against real repositories: drift counts, `--stale`, `--json`, thresholds, `--ci` exit codes, `explain`, `new`, dead patterns, companions, error paths |

```bash
npm test            # unit, then end-to-end
npm run test:unit   # node --test, no git, no filesystem
npm run test:cli    # bash, builds throwaway repositories
```

There are no mocks anywhere. The pure modules need none, and the CLI suite gets
determinism instead by **fixing commit dates**: `commit_at` sets both
`GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` to a computed "N days ago", so a
repository where the scraper's code moved twelve times and its doc did not
reports exactly twelve commits of drift, today and next year. The `date -u -v-Nd`
/ `date -u -d "N days ago"` pair covers BSD and GNU `date`.

CI runs the unit tests on Node 22 and 24 across Ubuntu, macOS and Windows; the
CLI suite on all three under `bash`; `shellcheck` over the test script; and a
**dogfood** job, `node bin/docs-doctor.mjs --docs "docs/**/*.md" --ci`, so the
tool's own docs must pass their own check. Every job that counts commits sets
`fetch-depth: 0` — a shallow clone has no history and drift would read as zero.

This is why this file carries `code: [bin/**, lib/**]` front matter. Without it
the dogfood job would classify it `unmapped` and fail the build, which is the
behaviour working as intended.

## Where to change things

| To change | Edit |
|---|---|
| Front-matter keys understood | `lib/frontmatter.mjs` — `LIST_KEYS` and `parseFrontMatter` |
| How an unmapped doc is guessed | `lib/frontmatter.mjs` — `inferCodePaths`, `systemName` |
| Thresholds or a new status | `lib/drift.mjs` — `STATUS`, `DEFAULT_THRESHOLDS`, `classify`, `needsAttention` |
| Table columns | `lib/drift.mjs` — `toRows` and the `columns` list in `renderTable` |
| Which docs are scanned by default | `lib/scan.mjs` — `DEFAULT_DOC_PATTERNS` |
| Which docs are exempt | `lib/scan.mjs` — `COMPANION_FILES`, `isCompanion` |
| What git is actually asked | `lib/scan.mjs` — `withExclusions`; `lib/git.mjs` for the commands |
| Concurrency | `lib/git.mjs` — the `limit` default in `mapConcurrently` |
| A new flag | `bin/docs-doctor.mjs` — `FLAGS` or `VALUE_FLAGS`, plus `defaultOptions` and `HELP` |
| A new command | `bin/docs-doctor.mjs` — the dispatch in `main`; put the logic in `lib/scan.mjs` |
| The `new` templates | `bin/docs-doctor.mjs` — `TEMPLATES` |
| The first-run guidance | `bin/docs-doctor.mjs` — `nextStep` |
| The JSON contract | `lib/scan.mjs` — the `system` object in `inspect`; then update `agents/` |

## Deliberate omissions

Not oversights:

- **No dependencies, and no YAML parser.** Three keys are read with two regular
  expressions. A real YAML parser would be the only dependency in the project,
  to support syntax no doc here needs.
- **No content analysis.** The tool never reads what a doc *says*, only when it
  changed. It cannot tell a typo fix from a rewrite in either the doc or the
  code, and does not pretend to. Drift is a signal for where to look, not proof
  that anything is wrong.
- **No cache, no index, no daemon.** Every run asks git from scratch. Bounded
  concurrency and `rev-list --count` keep that cheap enough that a cache would
  only add a staleness problem of its own.
- **No rename tracking.** A directory move is counted as commits touching the
  new paths, which lights up every affected doc once. That is usually correct —
  the paths really did change — and the alternative is `--follow`, which does not
  work with multiple pathspecs.
- **No write-back.** The tool never edits a doc. `new` scaffolds empty templates
  and refuses to overwrite an existing file; everything else is read-only.
- **No `--explain-limit` flag.** `explain` shows the 20 most recent missed
  commits. If a doc is more than twenty commits behind, the exact number is in
  the table and the list is already past the point of being read.
