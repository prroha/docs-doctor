---
name: doc-drift
description: Use before planning work on a system, to check whether its documentation still matches the code, and after changing code, to update the doc. Also use when asked which docs are out of date, or to set up documentation for a new system.
---

# Checking documentation against the code

A stale doc is worse than no doc: it sends you confidently the wrong way. `docs-doctor` counts the commits that touched a system's code after its doc last changed.

Install once: `npm install -g github:prroha/docs-doctor`

## Before planning

```bash
docs-doctor --json
```

Find the system you are about to work on. Then:

- **`fresh`** — trust the doc.
- **`behind`** — mostly fine; check the commits if details matter.
- **`stale`** — do not trust it. Run `docs-doctor explain <doc-path>` and read the commits it lists; they are what the doc misses.
- **`unmapped`** — the doc declares no code, so nothing was checked. Treat it as unverified, and say so rather than implying it was confirmed.
- **`orphan`** — the code it names is gone.

## After changing code

```bash
docs-doctor explain <doc-path>
```

Update the doc to cover what those commits changed, in the same change as the code. Re-run to confirm the drift is back to zero.

## Setting up a new system's docs

```bash
docs-doctor new <name>
```

Then set the `code:` paths in the README's front matter, or the doc will report `unmapped` forever:

```markdown
---
title: billing
code:
  - src/billing/**
---
```

## Checking a whole repository

```bash
docs-doctor --stale          # only what needs attention
docs-doctor --ci             # exit 2 if anything does: use in a build
```

## Rules

- Never describe behaviour from a `stale` or `unmapped` doc as confirmed; read the code or the commits.
- Never raise `--stale-commits` or `--stale-days` to make a report look clean.
- Keep the doc's `code:` paths accurate when files move; a wrong mapping silently reports `fresh`.
