#!/usr/bin/env node
// docs-doctor — find the documentation that has fallen behind its code.
//
// A doc says which code it describes, in its own front matter. docs-doctor asks
// git when each last changed and counts the commits in between.
//
// Full docs: README.md

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  --docs <glob>          where the docs are (repeatable)
                         default: ${DEFAULT_DOC_PATTERNS.join(", ")}
  --stale-commits <n>    commits of drift that mean stale (default ${DEFAULT_THRESHOLDS.staleCommits})
  --stale-days <n>       days of drift that mean stale (default ${DEFAULT_THRESHOLDS.staleDays})
  --dir <path>           run against another repository
  -v, --version          print the version
  -h, --help             this help

A doc declares the code it documents in its front matter:

  ---
  title: Carrier scrape
  code:
    - src/carrier-scraper/**
    - src/packages/carrier-book/**
  ignore:
    - src/carrier-scraper/**/__tests__/**
  ---

Statuses: fresh (code has not moved since the doc did) · behind (a few commits)
          stale (past a threshold) · unmapped (no code declared or matched)
          orphan (the code it names is gone) · untracked (doc not committed yet)`;

function parseArguments(argv) {
  const options = {
    command: "check",
    target: null,
    stale: false,
    ci: false,
    json: false,
    docPatterns: [],
    thresholds: { ...DEFAULT_THRESHOLDS },
    dir: process.cwd(),
    help: false,
    version: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next == null || next.startsWith("--")) {
        throw new Error(`${argument} needs a value`);
      }
      return next;
    };
    const positiveNumber = () => {
      const raw = value();
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0) {
        throw new Error(`${argument} expects a number, got ${raw}`);
      }
      return number;
    };

    switch (argument) {
      case "--stale":
        options.stale = true;
        break;
      case "--ci":
        options.ci = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--docs":
        options.docPatterns.push(value());
        break;
      case "--stale-commits":
        options.thresholds.staleCommits = positiveNumber();
        break;
      case "--stale-days":
        options.thresholds.staleDays = positiveNumber();
        break;
      case "--dir":
        options.dir = value();
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      default:
        if (argument.startsWith("-")) {
          throw new Error(`unknown option: ${argument}`);
        }
        positional.push(argument);
    }
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
    written.push(join("docs", "system", options.target, file));
  }
  if (written.length === 0) {
    console.log(`docs/system/${options.target} already has its docs.`);
    return;
  }
  console.log(`created:\n${written.map((path) => `  ${path}`).join("\n")}`);
  console.log(`\nEdit the 'code:' paths in README.md so docs-doctor can track drift.`);
}

function report(options, root) {
  const { systems, summary } = scan({
    root,
    docPatterns: options.docPatterns,
    thresholds: options.thresholds,
  });
  const shown = options.stale ? systems.filter((system) => needsAttention(system.status)) : systems;
  const ordered = [...shown].sort((a, b) => (b.driftCommits ?? 0) - (a.driftCommits ?? 0));

  if (options.json) {
    console.log(JSON.stringify({ summary, systems: ordered }, null, 2));
  } else if (ordered.length === 0) {
    console.log(options.stale ? "Every doc is current." : "No docs found.");
  } else {
    console.log(renderTable(toRows(ordered, Date.now())));
    console.log(
      `\n${summary.total} docs · ${summary.needsAttention} need attention · worst drift ${summary.worstDrift} commits`,
    );
    const stale = ordered.filter((system) => system.status === "stale");
    if (stale.length > 0) {
      console.log(`\nStart with: docs-doctor explain ${stale[0].name}`);
    }
  }

  if (options.ci && summary.needsAttention > 0) {
    process.exit(EXIT.stale);
  }
}

function explainOne(options, root) {
  if (!options.target) {
    fail("say which doc to explain: docs-doctor explain <name|path>");
  }
  const { systems } = scan({
    root,
    docPatterns: options.docPatterns,
    thresholds: options.thresholds,
  });
  const match = systems.find(
    (system) => system.name === options.target || system.doc === options.target,
  );
  if (!match) {
    fail(`no doc called ${options.target}. Run docs-doctor to list them.`);
  }

  const { commits } = explain({ root, docPath: match.doc, thresholds: options.thresholds });
  if (options.json) {
    console.log(JSON.stringify({ system: match, commits }, null, 2));
    return;
  }

  console.log(`${match.name} (${match.doc})`);
  console.log(`  status ${match.status} · ${match.driftCommits} commits of drift`);
  console.log(`  code   ${match.codePaths.join(", ") || "none declared"}`);
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

function main() {
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
    root = repositoryRoot(options.dir);
  } catch (error) {
    if (error instanceof GitError) {
      fail(`${options.dir} is not inside a git repository.`, EXIT.notARepository);
    }
    throw error;
  }

  try {
    if (options.command === "explain") {
      explainOne(options, root);
      return;
    }
    if (options.command !== "check") {
      fail(`unknown command: ${options.command}. Run docs-doctor --help.`);
    }
    report(options, root);
  } catch (error) {
    if (error instanceof GitError) {
      fail(error.message);
    }
    throw error;
  }
}

main();
