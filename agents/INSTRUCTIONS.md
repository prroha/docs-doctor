# docs-doctor instructions for an AI coding agent

Paste into the file your agent reads: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`, or a system prompt. Trim what doesn't apply.

---

## Trusting the docs in this repository

Docs go stale quietly, and a stale doc will send you down the wrong path with confidence. `docs-doctor` says which ones have fallen behind their code.

### Before planning work on a system

```bash
docs-doctor --json                 # status of every doc
docs-doctor explain <doc-path>     # the commits one doc never caught up with
```

If a doc is `stale`, **read the commits `explain` lists instead of trusting the doc**. They are what changed since anyone updated it.

If a doc is `unmapped`, it declares no code, so nothing has been checked: treat it as unverified.

### After changing code

```bash
docs-doctor explain <doc-path>     # what the doc now misses
```

Update the doc in the same change, then confirm the drift is gone.

### Reading the statuses

| Status | What it means for you |
|---|---|
| `fresh` | The code hasn't moved since the doc did. Trust it. |
| `behind` | A few commits ahead. Mostly trustworthy; check `explain` if the detail matters. |
| `stale` | Past the threshold. Read the commits, not the doc. |
| `unmapped` | The doc claims no code, so drift is unknown. Unverified. |
| `orphan` | The code the doc names is gone. Probably describes something deleted. |

### Creating a doc for a new system

```bash
docs-doctor new <name>
```

Then fill in the `code:` paths in the front matter so the doc is tracked from the start:

```markdown
---
title: billing
code:
  - src/billing/**
ignore:
  - src/billing/**/__tests__/**
---
```

### Rules

- **Check a doc's status before relying on it.** A confident wrong answer built on a stale doc is worse than admitting the doc is out of date.
- **Update the doc in the same change as the code.** That is what keeps drift at zero.
- **When you write a new doc, give it `code:` front matter.** An unmapped doc is invisible to drift checking.
- **Don't raise the thresholds to make a report look clean.** The numbers are the point.
