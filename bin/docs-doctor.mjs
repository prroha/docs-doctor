#!/usr/bin/env node
// docs-doctor — find the documentation that has fallen behind its code.
//
// A doc says which code it describes, in its own front matter. docs-doctor asks
// git when each last changed and counts the commits in between.
//
// Full docs: README.md

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix as posixPath } from "node:path";
import { DEFAULT_THRESHOLDS, needsAttention, renderTable, toRows } from "../lib/drift.mjs";
import { GitError, repositoryRoot } from "../lib/git.mjs";
import { DEFAULT_DOC_PATTERNS, explain, scan } from "../lib/scan.mjs";

const EXIT = { ok: 0, error: 1, stale: 2, notARepository: 3 };

const HELP = `docs-doctor — find the docs that have fallen behind their code

Usage: docs-doctor [command] [options]

Commands:
  check                  report every doc (the default)
  explain <name|path>    the commits one doc has not caught up with
  new <name>             scaffold README, TODO and FEEDBACK for a subsystem

Options:
  --stale                only docs needing attention
  --ci                   exit 2 if any doc needs attention
  --json                 machine-readable output
  --all                  include companion docs (TODO, FEEDBACK, CHANGELOG)
  --docs <glob>          where the docs are (repeatable, git pathspecs)
                         default: docs/**/*.md, doc/**/*.md, *.md (root)
  --stale-commits <n>    commits of drift that mean stale (default ${DEFAULT_THRESHOLDS.staleCommits})
  --stale-days <n>       days of drift that mean stale (default ${DEFAULT_THRESHOLDS.staleDays})
  --dir <path>           run against another repository
  -v, --version          print the version
  -h, --help             this help

A doc declares the code it documents in its front matter:

  ---
  title: Billing
  code:
    - src/billing/**
    - src/packages/invoices/**
  ignore:
    - src/billing/**/__tests__/**
  ---

Statuses: fresh (code has not moved since the doc did) · behind (a few commits)
          stale (past a threshold) · unmapped (no code declared or matched)
          orphan (the code it names is gone) · untracked (doc not committed yet)`;

function defaultOptions() {
  return {
    command: "check",
    target: null,
    stale: false,
    ci: false,
    json: false,
    includeCompanions: false,
    docPatterns: [],
    thresholds: { ...DEFAULT_THRESHOLDS },
    dir: process.cwd(),
    help: false,
    version: false,
  };
}

const FLAGS = {
  "--stale": (options) => (options.stale = true),
  "--ci": (options) => (options.ci = true),
  "--json": (options) => (options.json = true),
  "--all": (options) => (options.includeCompanions = true),
  "-h": (options) => (options.help = true),
  "--help": (options) => (options.help = true),
  "-v": (options) => (options.version = true),
  "--version": (options) => (options.version = true),
};

const VALUE_FLAGS = {
  "--docs": (options, value) => options.docPatterns.push(value),
  "--dir": (options, value) => (options.dir = value),
  "--stale-commits": (options, value) => (options.thresholds.staleCommits = positiveNumber("--stale-commits", value)),
  "--stale-days": (options, value) => (options.thresholds.staleDays = positiveNumber("--stale-days", value)),
};

function positiveNumber(flag, raw) {
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${flag} expects a number, got ${raw}`);
  }
  return number;
}

function parseArguments(argv) {
  const options = defaultOptions();
  const positional = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (FLAGS[argument]) {
      FLAGS[argument](options);
      continue;
    }
    if (VALUE_FLAGS[argument]) {
      const value = argv[++index];
      if (value == null || value.startsWith("--")) {
        throw new Error(`${argument} needs a value`);
      }
      VALUE_FLAGS[argument](options, value);
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`unknown option: ${argument}`);
    }
    positional.push(argument);
  }

  if (positional.length > 0) {
    options.command = positional[0];
    options.target = positional[1] ?? null;
  }
  if (options.docPatterns.length === 0) {
    options.docPatterns = DEFAULT_DOC_PATTERNS;
  }
  return options;
}

function fail(message, code = EXIT.error) {
  console.error(`docs-doctor: ${message}`);
  process.exit(code);
}

function readVersion() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

const TEMPLATES = {
  "README.md": (name) => `---
title: ${name}
code:
  - src/${name}/**
---

# ${name}

What it does, in two sentences.

**Entry points:** the files to read first.

## How it works

The main flow, step by step.

## Key decisions

Each decision and why. This is what stops someone "fixing" something deliberate.

## Invariants

What must always hold.

## Gotchas

What surprised us.
`,
  "TODO.md": (name) => `# ${name} — TODO

Known gaps between this design and the code. Remove an item once it is closed.

-
`,
  "FEEDBACK.md": (name) => `# ${name} — feedback

Notes to address in a later pass. Anyone may append; remove once addressed.

-
`,
};

function scaffold(options) {
  if (!options.target) {
    fail("say which system to scaffold: docs-doctor new <name>");
  }
  const directory = join(options.dir, "docs", "system", options.target);
  mkdirSync(directory, { recursive: true });
  const written = [];
  for (const [file, template] of Object.entries(TEMPLATES)) {
    const path = join(directory, file);
    if (existsSync(path)) {
      continue;
    }
    writeFileSync(path, template(options.target));
    written.push(posixPath.join("docs", "system", options.target, file));
  }
  if (written.length === 0) {
    console.log(`docs/system/${options.target} already has its docs.`);
    return;
  }
  console.log(`created:\n${written.map((path) => `  ${path}`).join("\n")}`);
  console.log(`\nEdit the 'code:' paths in README.md so docs-doctor can track drift.`);
}

async function report(options, root) {
  const { systems, summary } = await scan({
    root,
    docPatterns: options.docPatterns,
    thresholds: options.thresholds,
    includeCompanions: options.includeCompanions,
  });
  const shown = options.stale ? systems.filter((system) => needsAttention(system.status)) : systems;
  const ordered = [...shown].sort((a, b) => (b.driftCommits ?? 0) - (a.driftCommits ?? 0));

  if (options.json) {
    console.log(JSON.stringify({ summary, systems: ordered }, null, 2));
  } else if (ordered.length === 0) {
    console.log(options.stale ? "Every doc is current." : "No docs found.");
  } else {
    console.log(renderTable(toRows(ordered, Date.now())));
    const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    console.log(
      `\n${plural(summary.total, "doc")} · ${summary.needsAttention} ${summary.needsAttention === 1 ? "needs" : "need"} attention · worst drift ${plural(summary.worstDrift, "commit")}`,
    );
    console.log(`\n${nextStep(ordered, summary)}`);
  }

  if (options.ci && summary.needsAttention > 0) {
    process.exit(EXIT.stale);
  }
}

function nextStep(systems, summary) {
  const mapped = systems.filter((system) => !system.inferredMapping && system.codePaths.length > 0);
  if (mapped.length === 0 && summary.total > 0) {
    return [
      "No doc says which code it covers yet, so nothing can be checked for drift.",
      "Add front matter to a doc and run it again:",
      "",
      "  ---",
      "  title: billing",
      "  code:",
      "    - src/billing/**",
      "  ---",
    ].join("\n");
  }
  const stale = systems.find((system) => system.status === "stale");
  if (stale) {
    return `Start with: docs-doctor explain ${stale.doc}`;
  }
  // A partly dead mapping is the dangerous case: the doc still matches
  // something, so it reads as current while covering code nobody checks.
  const partlyDead = systems.find(
    (system) => system.matchedFileCount > 0 && system.deadPatterns?.length > 0,
  );
  if (partlyDead) {
    return `${partlyDead.doc} declares paths that match nothing (${partlyDead.deadPatterns.join(", ")}). Fix the mapping, or its drift is understated.`;
  }
  const unmapped = systems.find((system) => system.status === "unmapped");
  if (unmapped) {
    return `Unmapped: add 'code:' front matter to ${unmapped.doc}, or scope the run with --docs.`;
  }
  return "Every doc is current.";
}

async function explainOne(options, root) {
  if (!options.target) {
    fail("say which doc to explain: docs-doctor explain <name|path>");
  }
  const { systems } = await scan({
    root,
    docPatterns: options.docPatterns,
    thresholds: options.thresholds,
    includeCompanions: options.includeCompanions,
  });
  const match = systems.find(
    (system) => system.name === options.target || system.doc === options.target,
  );
  if (!match) {
    fail(`no doc called ${options.target}. Run docs-doctor to list them.`);
  }

  const { commits } = await explain({ root, docPath: match.doc, thresholds: options.thresholds });
  if (options.json) {
    console.log(JSON.stringify({ system: match, commits }, null, 2));
    return;
  }

  console.log(`${match.name} (${match.doc})`);
  console.log(`  status ${match.status} · ${match.driftCommits} commits of drift`);
  console.log(`  code   ${match.codePaths.join(", ") || "none declared"}${match.inferredMapping ? " (guessed)" : ""}`);
  if (match.ignorePaths.length > 0) {
    console.log(`  ignore ${match.ignorePaths.join(", ")}`);
  }
  if (match.deadPatterns.length > 0) {
    console.log(`  WARNING: these declared paths match no tracked file: ${match.deadPatterns.join(", ")}`);
  }
  if (commits.length === 0) {
    console.log("\nNothing has touched its code since the doc last changed.");
    return;
  }
  console.log(`\nCommits the doc has not caught up with:`);
  for (const commit of commits) {
    const when = new Date(commit.committedAtMs).toISOString().slice(0, 10);
    console.log(`  ${commit.hash.slice(0, 8)}  ${when}  ${commit.author}  ${commit.subject}`);
  }
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }

  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.version) {
    console.log(readVersion());
    return;
  }

  if (options.command === "new") {
    scaffold(options);
    return;
  }

  let root;
  try {
    root = await repositoryRoot(options.dir);
  } catch (error) {
    if (error instanceof GitError) {
      fail(`${options.dir} is not inside a git repository.`, EXIT.notARepository);
    }
    throw error;
  }

  try {
    if (options.command === "explain") {
      await explainOne(options, root);
      return;
    }
    if (options.command !== "check") {
      fail(`unknown command: ${options.command}. Run docs-doctor --help.`);
    }
    await report(options, root);
  } catch (error) {
    fail(error instanceof GitError ? error.message : `${error.message}`);
  }
}

await main();
