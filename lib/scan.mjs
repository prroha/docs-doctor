// Putting it together: find the docs, read their mappings, ask git, classify.
import { readFileSync } from "node:fs";
import { join, posix as posixPath } from "node:path";
import { inferCodePaths, parseFrontMatter, systemName } from "./frontmatter.mjs";
import { classify, DEFAULT_THRESHOLDS, summarize } from "./drift.mjs";
import {
  commitsSince,
  countCommitsSince,
  docFiles,
  lastCommitFor,
  mapConcurrently,
  matchesAnything,
} from "./git.mjs";

// :(glob) makes ** mean "zero or more directories", so docs/api.md is matched as
// well as docs/system/api/README.md, and a bare *.md stays root-level.
export const DEFAULT_DOC_PATTERNS = [":(glob)docs/**/*.md", ":(glob)doc/**/*.md", ":(glob)*.md"];

// A companion belongs to the README beside it: it documents no code of its own.
const COMPANION_FILES = new Set(["todo.md", "feedback.md", "changelog.md"]);

const PATHSPEC_MAGIC = ":";

// Every doc pattern gets the same :(glob) magic the defaults carry, so a
// caller's "*.md" means root-level only, exactly as the default does. Without
// this a user pattern would reach git as a plain pathspec, where a single * also
// crosses a slash and matches at any depth. A pattern that already spells out
// its own magic (":(exclude)…") is left as it was written.
export function asGlobPathspec(pattern) {
  if (pattern.startsWith(PATHSPEC_MAGIC)) {
    return pattern;
  }
  return `:(glob)${pattern}`;
}

export async function scan({
  root,
  docPatterns = DEFAULT_DOC_PATTERNS,
  thresholds = DEFAULT_THRESHOLDS,
  includeCompanions = false,
}) {
  const docs = (await docFiles(docPatterns.map(asGlobPathspec), root)).filter(
    (docPath) => includeCompanions || !isCompanion(docPath),
  );
  const systems = await mapConcurrently(docs, (docPath) => inspect({ root, docPath, thresholds }));
  return { systems, summary: summarize(systems) };
}

function isCompanion(docPath) {
  const file = (docPath.split("/").pop() ?? "").toLowerCase();
  return COMPANION_FILES.has(file);
}

// A tracked doc can be missing from the working tree (deleted but not committed,
// or a sparse checkout). Treat it as empty rather than crashing.
//
// git reports doc paths with forward slashes everywhere, including on Windows;
// join turns them back into whatever the platform wants. The path goes to the
// filesystem as a path and never as a URL, so a repository directory containing
// a # or a ? is read rather than truncated at a fragment that is not one.
function readDoc(root, docPath) {
  try {
    return readFileSync(join(root, docPath), "utf8");
  } catch {
    return "";
  }
}

// The one place a doc is read and its mapping worked out, so `inspect` and
// `explain` cannot drift apart about what pathspec a doc means.
function mappingFor(root, docPath) {
  const { data } = parseFrontMatter(readDoc(root, docPath));
  const declared = inferCodePaths(docPath, data);
  return {
    data,
    declared,
    pathspec: withExclusions({
      paths: declared.paths,
      ignore: data.ignore,
      docPath,
      inferred: declared.inferred,
    }),
  };
}

async function inspect({ root, docPath, thresholds }) {
  const { data, declared, pathspec: codePaths } = mappingFor(root, docPath);

  // Pathspecs go to git as patterns, never as an expanded file list: a mapping
  // like src/** in a monorepo would otherwise blow past the argument limit.
  const [docCommit, codeCommit] = await Promise.all([
    lastCommitFor([docPath], root),
    codePaths.length > 0 ? lastCommitFor(codePaths, root) : null,
  ]);

  const driftCommits =
    docCommit && codeCommit
      ? await countCommitsSince(docCommit.committedAtMs, codePaths, root)
      : 0;

  // Only declared mappings are checked for dead patterns: a guess that misses is
  // already reported as unmapped, and checking every guess costs a git call.
  const deadPatterns = declared.inferred
    ? []
    : (
        await mapConcurrently(declared.paths, async (pattern) =>
          (await matchesAnything([pattern], root)) ? null : pattern,
        )
      ).filter(Boolean);

  const system = {
    name: systemName(docPath, data),
    doc: docPath,
    codePaths: declared.paths,
    ignorePaths: Array.isArray(data.ignore) ? data.ignore : [],
    inferredMapping: declared.inferred,
    hasMatchedCode: Boolean(codeCommit),
    deadPatterns,
    docCommittedAtMs: docCommit?.committedAtMs ?? null,
    codeCommittedAtMs: codeCommit?.committedAtMs ?? null,
    driftCommits,
  };
  return { ...system, status: classify(system, thresholds) };
}

// The pathspec actually handed to git: the declared paths, minus the ignores,
// minus the doc itself and, for a guessed mapping, the docs beside it. Without
// that last exclusion a README's own TODO.md counts as its code and the doc
// looks current.
export function withExclusions({ paths, ignore, docPath, inferred }) {
  if (paths.length === 0) {
    return [];
  }
  const exclusions = [`:(exclude)${docPath}`];
  if (inferred) {
    exclusions.push(`:(exclude,glob)${posixPath.dirname(docPath)}/**/*.md`);
  }
  if (Array.isArray(ignore)) {
    exclusions.push(...ignore.map((pattern) => `:(exclude)${pattern}`));
  }
  return [...paths, ...exclusions];
}

// `system` is the one `scan` already built for this doc, if the caller has it:
// passing it back skips a second round of git calls. Left out, explain inspects
// the doc itself and remains a complete entry point on its own.
export async function explain({
  root,
  docPath,
  limit = 20,
  thresholds = DEFAULT_THRESHOLDS,
  system = null,
}) {
  const inspected = system ?? (await inspect({ root, docPath, thresholds }));
  const { pathspec } = mappingFor(root, docPath);
  const commits =
    inspected.docCommittedAtMs == null
      ? []
      : await commitsSince(inspected.docCommittedAtMs, pathspec, root, limit);
  return { system: inspected, commits };
}
