# Using docs-doctor with AI coding agents

Agents plan from your docs, so a stale doc misleads every one of them. These files teach an agent to check before it trusts.

| File | What to do with it |
|---|---|
| [`INSTRUCTIONS.md`](INSTRUCTIONS.md) | Paste into `CLAUDE.md`, `AGENTS.md`, `.cursorrules` or a system prompt |
| [`claude-skill/SKILL.md`](claude-skill/SKILL.md) | Copy to `.claude/skills/doc-drift/SKILL.md` for Claude Code |

## Claude Code

```bash
npm install -g github:prroha/docs-doctor
mkdir -p .claude/skills/doc-drift
curl -o .claude/skills/doc-drift/SKILL.md \
  https://raw.githubusercontent.com/prroha/docs-doctor/main/agents/claude-skill/SKILL.md
```

Let the commands run without a prompt each time, in `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Bash(docs-doctor:*)"] } }
```

## Any other agent

Paste [`INSTRUCTIONS.md`](INSTRUCTIONS.md) into whichever instruction file it reads. docs-doctor is a normal CLI with `--json` output and meaningful exit codes, so anything that can run a command can use it.

## Why this matters more with agents than with people

A person who reads a doc that contradicts the code usually notices. An agent takes the doc as fact and plans on it, then writes code against an interface that changed three months ago. `docs-doctor --json` before planning, and `explain` after changing code, closes that gap.
