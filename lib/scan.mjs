// Putting it together: find the docs, read their mappings, ask git, classify.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inferCodePaths, parseFrontMatter, systemName } from "./frontmatter.mjs";
import { classify, DEFAULT_THRESHOLDS, summarize } from "./drift.mjs";
import { commitsSince, countTrackedFiles, docFiles, lastCommitFor } from "./git.mjs";

// :(glob) makes ** mean "zero or more directories", so docs/api.md is matched as
// well as docs/system/api/README.md, and a bare *.md stays root-level.
export const DEFAULT_DOC_PATTERNS = [":(glob)docs/**/*.md", ":(glob)doc/**/*.md", ":(glob)*.md"];

// A companion belongs to the README beside it: it documents no code of its own.
const COMPANION_FILES = new Set(["todo.md", "feedback.md", "changelog.md"]);

export function scan({
  root,
  docPatterns = DEFAULT_DOC_PATTERNS,
  thresholds = DEFAULT_THRESHOLDS,
  includeCompanions = false,
}) {
  const docs = docFiles(docPatterns, root).filter(
    (docPath) => includeCompanions || !isCompanion(docPath),
  );
  const systems = docs.map((docPath) => inspect({ root, docPath, thresholds }));
  return { systems, summary: summarize(systems) };
}

function isCompanion(docPath) {
  const file = (docPath.split("/").pop() ?? "").toLowerCase();
  return COMPANION_FILES.has(file);
}

// A tracked doc can be missing from the working tree (deleted but not committed,
// or a sparse checkout). Treat it as empty rather than crashing.
function readDoc(root, docPath) {
  try {
    return readFileSync(join(root, docPath), "utf8");
  } catch {
    return "";
  }
}

function inspect({ root, docPath, thresholds }) {
  const { data } = parseFrontMatter(readDoc(root, docPath));
  const declared = inferCodePaths(docPath, data);
  const codePaths = withExclusions({ paths: declared.paths, ignore: data.ignore, docPath, inferred: declared.inferred });

  const docCommit = lastCommitFor([docPath], root);
  // Pathspecs go to git as patterns, never as an expanded file list: a mapping
  // like src/** in a monorepo would otherwise blow past the argument limit.
  const matchedFileCount = codePaths.length > 0 ? countTrackedFiles(codePaths, root) : 0;
  const codeCommit = matchedFileCount > 0 ? lastCommitFor(codePaths, root) : null;

  const driftCommits =
    docCommit && matchedFileCount > 0
      ? commitsSince(docCommit.committedAtMs, codePaths, root).length
      : 0;

  const system = {
    name: systemName(docPath, data),
    doc: docPath,
    codePaths: declared.paths,
    ignorePaths: Array.isArray(data.ignore) ? data.ignore : [],
    inferredMapping: declared.inferred,
    matchedFileCount,
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
    exclusions.push(`:(exclude,glob)${dirname(docPath)}/**/*.md`);
  }
  if (Array.isArray(ignore)) {
    exclusions.push(...ignore.map((pattern) => `:(exclude)${pattern}`));
  }
  return [...paths, ...exclusions];
}

// Which commits a doc has not caught up with, newest first.
export function explain({ root, docPath, limit = 20, thresholds = DEFAULT_THRESHOLDS }) {
  const system = inspect({ root, docPath, thresholds });
  const { data } = parseFrontMatter(readDoc(root, docPath));
  const pathspec = withExclusions({
    paths: inferCodePaths(docPath, data).paths,
    ignore: data.ignore,
    docPath,
    inferred: system.inferredMapping,
  });
  const commits =
    system.docCommittedAtMs == null
      ? []
      : commitsSince(system.docCommittedAtMs, pathspec, root, limit);
  return { system, commits };
}
