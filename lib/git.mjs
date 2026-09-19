// The only impure part: asking git when things last changed.
import { execFileSync } from "node:child_process";

// %ct, not %at: --since filters on committer date, and mixing the two clocks
// inflates drift on any rebased or cherry-picked history.
const LOG_FORMAT = "%H%x1f%ct%x1f%an%x1f%s";
const UNIT_SEPARATOR = "\x1f";

export class GitError extends Error {}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    throw new GitError(error.stderr?.trim() || error.message);
  }
}

export function repositoryRoot(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd).trim();
}

// One commit line -> { hash, committedAtMs, author, subject }.
export function parseLogLine(line) {
  const [hash, epochSeconds, author, subject] = line.split(UNIT_SEPARATOR);
  if (!hash || !epochSeconds) {
    return null;
  }
  return {
    hash,
    committedAtMs: Number(epochSeconds) * 1000,
    author: author ?? "",
    subject: subject ?? "",
  };
}

export function parseLog(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseLogLine)
    .filter(Boolean);
}

export function lastCommitFor(paths, cwd) {
  if (paths.length === 0) {
    return null;
  }
  const output = git(["log", "-1", `--format=${LOG_FORMAT}`, "--", ...paths], cwd);
  return parseLog(output)[0] ?? null;
}

// The commits that touched the code after the doc last changed: the drift itself.
export function commitsSince(sinceMs, paths, cwd, limit = 0) {
  if (paths.length === 0 || sinceMs == null) {
    return [];
  }
  const sinceIso = new Date(sinceMs + 1000).toISOString();
  const args = ["log", `--format=${LOG_FORMAT}`, `--since=${sinceIso}`];
  if (limit > 0) {
    args.push(`-${limit}`);
  }
  args.push("--", ...paths);
  return parseLog(git(args, cwd));
}

// Expanding globs with git itself keeps one notion of "tracked file" and needs
// no dependency: git understands pathspecs, including ** patterns.
export function trackedFiles(patterns, cwd) {
  if (patterns.length === 0) {
    return [];
  }
  const output = git(["ls-files", "--", ...patterns], cwd);
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Counting without materialising the list keeps a monorepo mapping cheap.
export function countTrackedFiles(patterns, cwd) {
  return trackedFiles(patterns, cwd).length;
}

export function docFiles(patterns, cwd) {
  return trackedFiles(patterns, cwd);
}
