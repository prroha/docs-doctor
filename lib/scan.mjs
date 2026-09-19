// Putting it together: find the docs, read their mappings, ask git, classify.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inferCodePaths, parseFrontMatter, systemName } from "./frontmatter.mjs";
import { classify, DEFAULT_THRESHOLDS, summarize } from "./drift.mjs";
import { commitsSince, docFiles, lastCommitFor, trackedFiles } from "./git.mjs";

export const DEFAULT_DOC_PATTERNS = ["docs/**/*.md", "doc/**/*.md", "*.md"];

export function scan({
  root,
  docPatterns = DEFAULT_DOC_PATTERNS,
  thresholds = DEFAULT_THRESHOLDS,
  includeCompanions = false,
}) {
  const docs = docFiles(docPatterns, root).filter(
    (docPath) => includeCompanions || documentsASystem(root, docPath),
  );
  const systems = docs.map((docPath) => inspect({ root, docPath, thresholds }));
  return { systems, summary: summarize(systems) };
}

// A system's doc is a README, or any doc that declares the code it describes.
// Companions like TODO.md and FEEDBACK.md belong to a README, not to code.
function documentsASystem(root, docPath) {
  const file = docPath.split("/").pop() ?? "";
  if (/^readme\.md$/i.test(file)) {
    return true;
  }
  const { data } = parseFrontMatter(readFileSync(join(root, docPath), "utf8"));
  return Array.isArray(data.code) && data.code.length > 0;
}

function inspect({ root, docPath, thresholds }) {
  const text = readFileSync(join(root, docPath), "utf8");
  const { data } = parseFrontMatter(text);
  const { paths, inferred } = inferCodePaths(docPath, data);
  const codePaths = excludeIgnored(paths, data.ignore);

  const docCommit = lastCommitFor([docPath], root);
  // An inferred mapping that matches nothing is a doc nobody has tied to code,
  // not a doc whose code was deleted.
  const matchedFiles = trackedFiles(codePaths, root).filter((file) => file !== docPath);
  const codeCommit = matchedFiles.length > 0 ? lastCommitFor(matchedFiles, root) : null;

  const driftCommits =
    docCommit && matchedFiles.length > 0
      ? commitsSince(docCommit.committedAtMs, matchedFiles, root).length
      : 0;

  const system = {
    name: systemName(docPath, data),
    doc: docPath,
    codePaths,
    inferredMapping: inferred,
    matchedFileCount: matchedFiles.length,
    docCommittedAtMs: docCommit?.committedAtMs ?? null,
    codeCommittedAtMs: codeCommit?.committedAtMs ?? null,
    driftCommits,
  };
  return { ...system, status: classify(system, thresholds) };
}

function excludeIgnored(paths, ignore) {
  if (!Array.isArray(ignore) || ignore.length === 0) {
    return paths;
  }
  return [...paths, ...ignore.map((pattern) => `:(exclude)${pattern}`)];
}

// Which commits a doc has not caught up with, newest first.
export function explain({ root, docPath, limit = 20, thresholds = DEFAULT_THRESHOLDS }) {
  const system = inspect({ root, docPath, thresholds });
  const matchedFiles = trackedFiles(system.codePaths, root).filter((file) => file !== docPath);
  const commits =
    system.docCommittedAtMs == null
      ? []
      : commitsSince(system.docCommittedAtMs, matchedFiles, root, limit);
  return { system, commits };
}
