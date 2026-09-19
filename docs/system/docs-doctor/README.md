---
title: docs-doctor
code:
  - bin/**
  - lib/**
---

# docs-doctor

Reports which documentation has fallen behind the code it describes, by counting
the commits that touched the code after the doc last changed.

**Entry points:** `bin/docs-doctor.mjs` (CLI), `lib/scan.mjs` (the pass that ties
docs to code), `lib/drift.mjs` (statuses), `lib/git.mjs` (the only impure part).

## How it works

1. `git ls-files` finds docs matching the patterns.
2. Front matter gives each doc its code paths; `git ls-files` expands them.
3. `git log -1` dates the doc and its code.
4. `git log --since` counts the commits since the doc last changed: the drift.
5. Thresholds turn drift into a status.

## Key decisions

- **Drift is counted in commits**, because a commit count persuades where a date
  does not, and a doc untouched for a year is fine if its code is too.
- **The mapping lives in the doc**, so it is reviewed with the doc rather than in
  a config file nobody opens.
- **An unmatched guess reports `unmapped`, not `fresh`.** Silence is how drift
  hides; a doc tied to nothing must say so.
- **git expands the globs.** One notion of "tracked file", and no dependency.

## Invariants

- Only `lib/git.mjs` runs commands. Everything else is a pure function.
- A doc is never reported as fresh because information was missing.
- `--ci` exits 2 only for stale, unmapped or orphaned docs.

## Gotchas

- Shallow clones have no history to count: CI needs `fetch-depth: 0`.
- A directory rename lights up every doc once, because the paths did change.
