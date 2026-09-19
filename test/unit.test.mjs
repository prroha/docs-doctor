// Unit tests for the pure parts: front matter, drift classification, rendering,
// and git log parsing. No git, no filesystem.
import { test } from "node:test";
import assert from "node:assert/strict";

import { inferCodePaths, parseFrontMatter, systemName } from "../lib/frontmatter.mjs";
import {
  DEFAULT_THRESHOLDS,
  STATUS,
  classify,
  daysBetween,
  describeDrift,
  needsAttention,
  renderTable,
  summarize,
  toRows,
} from "../lib/drift.mjs";
import { parseLog, parseLogLine } from "../lib/git.mjs";

const DAY = 86400000;

test("reads a block list of code paths", () => {
  const { data, body } = parseFrontMatter(`---
title: Billing
code:
  - src/billing/**
  - src/packages/invoices/**
---

# Billing
`);
  assert.equal(data.title, "Billing");
  assert.deepEqual(data.code, ["src/billing/**", "src/packages/invoices/**"]);
  assert.match(body, /^# Billing/);
});

test("reads an inline list, with or without brackets and quotes", () => {
  assert.deepEqual(parseFrontMatter('---\ncode: [src/a/**, "src/b/**"]\n---\n').data.code, [
    "src/a/**",
    "src/b/**",
  ]);
  assert.deepEqual(parseFrontMatter("---\ncode: src/a/**\n---\n").data.code, ["src/a/**"]);
});

test("reads an ignore list alongside code", () => {
  const { data } = parseFrontMatter(`---
code:
  - src/a/**
ignore:
  - src/a/__tests__/**
---
`);
  assert.deepEqual(data.code, ["src/a/**"]);
  assert.deepEqual(data.ignore, ["src/a/__tests__/**"]);
});

test("a doc without front matter is left alone", () => {
  const text = "# Just a doc\n\nNo front matter here.\n";
  const { data, body } = parseFrontMatter(text);
  assert.deepEqual(data, {});
  assert.equal(body, text);
});

test("an unterminated fence is not treated as front matter", () => {
  const text = "---\ncode: src/a/**\n\n# Doc\n";
  assert.deepEqual(parseFrontMatter(text).data, {});
  assert.equal(parseFrontMatter(text).body, text);
});

test("names a system from the title, the directory, then the file", () => {
  assert.equal(systemName("docs/system/search/README.md", { title: "Billing" }), "Billing");
  assert.equal(systemName("docs/system/search/README.md", {}), "search");
  assert.equal(systemName("docs/architecture.md", {}), "architecture");
});

test("declared paths win; otherwise the directory name is a guess", () => {
  const declared = inferCodePaths("docs/system/search/README.md", { code: ["src/search/**"] });
  assert.deepEqual(declared, { paths: ["src/search/**"], inferred: false });

  const guessed = inferCodePaths("docs/system/search/README.md", {});
  assert.deepEqual(guessed, { paths: ["**/search/**"], inferred: true });

  assert.deepEqual(inferCodePaths("README.md", {}), { paths: [], inferred: false });
});

test("fresh when the code has not moved since the doc did", () => {
  const system = {
    codePaths: ["src/a/**"],
    inferredMapping: false,
    docCommittedAtMs: Date.now(),
    codeCommittedAtMs: Date.now() - DAY,
    driftCommits: 0,
  };
  assert.equal(classify(system), STATUS.fresh);
});

test("behind after a commit, stale past the commit threshold", () => {
  const base = {
    codePaths: ["src/a/**"],
    inferredMapping: false,
    docCommittedAtMs: Date.now() - 2 * DAY,
    codeCommittedAtMs: Date.now(),
  };
  assert.equal(classify({ ...base, driftCommits: 1 }), STATUS.behind);
  assert.equal(classify({ ...base, driftCommits: 9 }), STATUS.behind);
  assert.equal(classify({ ...base, driftCommits: 10 }), STATUS.stale);
});

test("also stale when a little drift has sat there for a long time", () => {
  const system = {
    codePaths: ["src/a/**"],
    inferredMapping: false,
    docCommittedAtMs: Date.now() - 90 * DAY,
    codeCommittedAtMs: Date.now() - 10 * DAY,
    driftCommits: 2,
  };
  assert.equal(classify(system), STATUS.stale);
});

test("thresholds are configurable", () => {
  const system = {
    codePaths: ["src/a/**"],
    inferredMapping: false,
    docCommittedAtMs: Date.now() - DAY,
    codeCommittedAtMs: Date.now(),
    driftCommits: 12,
  };
  assert.equal(classify(system, { ...DEFAULT_THRESHOLDS, staleCommits: 50 }), STATUS.behind);
});

test("a doc with no code declared is unmapped, not fresh", () => {
  assert.equal(
    classify({ codePaths: [], inferredMapping: false, docCommittedAtMs: Date.now(), driftCommits: 0 }),
    STATUS.unmapped,
  );
});

test("declared code that no longer exists is an orphan; a guess that misses is unmapped", () => {
  const base = { codePaths: ["src/gone/**"], docCommittedAtMs: Date.now(), codeCommittedAtMs: null, driftCommits: 0 };
  assert.equal(classify({ ...base, inferredMapping: false }), STATUS.orphan);
  assert.equal(classify({ ...base, inferredMapping: true }), STATUS.unmapped);
});

test("an uncommitted doc is untracked", () => {
  assert.equal(
    classify({ codePaths: ["src/a/**"], inferredMapping: false, docCommittedAtMs: null, driftCommits: 0 }),
    STATUS.untracked,
  );
});

test("stale, unmapped and orphan need attention; fresh and behind do not", () => {
  assert.equal(needsAttention(STATUS.stale), true);
  assert.equal(needsAttention(STATUS.unmapped), true);
  assert.equal(needsAttention(STATUS.orphan), true);
  assert.equal(needsAttention(STATUS.behind), false);
  assert.equal(needsAttention(STATUS.fresh), false);
});

test("summarizes counts, attention and the worst drift", () => {
  const summary = summarize([
    { status: STATUS.fresh, driftCommits: 0 },
    { status: STATUS.stale, driftCommits: 28 },
    { status: STATUS.behind, driftCommits: 3 },
    { status: STATUS.unmapped, driftCommits: 0 },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.needsAttention, 2);
  assert.equal(summary.worstDrift, 28);
  assert.equal(summary.counts[STATUS.stale], 1);
});

test("days between timestamps, and nothing when one is missing", () => {
  const now = Date.now();
  assert.equal(daysBetween(now - 3 * DAY, now), 3);
  assert.equal(daysBetween(null, now), null);
});

test("describes drift in commits, or by the status when there is no count", () => {
  assert.equal(describeDrift({ status: STATUS.behind, driftCommits: 1 }), "1 commit");
  assert.equal(describeDrift({ status: STATUS.stale, driftCommits: 12 }), "12 commits");
  assert.equal(describeDrift({ status: STATUS.unmapped }), "unmapped");
  assert.equal(describeDrift({ status: STATUS.orphan }), "orphan");
});

test("rows show ages in days and an em dash when unknown", () => {
  const now = Date.now();
  const [row] = toRows(
    [
      {
        name: "search",
        status: STATUS.stale,
        driftCommits: 5,
        docCommittedAtMs: now - 10 * DAY,
        codeCommittedAtMs: null,
      },
    ],
    now,
  );
  assert.deepEqual(row, {
    system: "search",
    docAge: "10d",
    codeAge: "—",
    drift: "5 commits",
    status: STATUS.stale,
  });
});

test("the table aligns its columns", () => {
  const table = renderTable([
    { system: "a", docAge: "1d", codeAge: "2d", drift: "3 commits", status: "behind" },
    { system: "long-name", docAge: "10d", codeAge: "20d", drift: "30 commits", status: "stale" },
  ]);
  const [header, first, second] = table.split("\n");
  assert.match(header, /^SYSTEM {5}/);
  assert.equal(first.indexOf("1d"), second.indexOf("10d"));
});

test("parses a git log line into a commit", () => {
  const commit = parseLogLine("abc1231700000000Adafix: the thing");
  assert.deepEqual(commit, {
    hash: "abc123",
    committedAtMs: 1700000000000,
    author: "Ada",
    subject: "fix: the thing",
  });
});

test("skips blank and malformed log lines", () => {
  const commits = parseLog("abc1700000000Adaone\n\nnonsense\n");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].subject, "one");
});
