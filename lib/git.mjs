// The only impure part: asking git when things last changed.
//
// Calls are async so a scan can run several at once: on a repository with a
// hundred docs, waiting for each git process in turn dominates the runtime.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// %ct, not %at: --since filters on committer date, and mixing the two clocks
// inflates drift on any rebased or cherry-picked history.
const LOG_FORMAT = "%H%x1f%ct%x1f%an%x1f%s";
const UNIT_SEPARATOR = "\x1f";
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export class GitError extends Error {}

async function git(args, cwd) {
  try {
    const { stdout } = await run("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
    return stdout;
  } catch (error) {
    throw new GitError(error.stderr?.trim() || error.message);
  }
}

export async function repositoryRoot(cwd) {
  return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
}

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

export async function lastCommitFor(paths, cwd) {
  if (paths.length === 0) {
    return null;
  }
  const output = await git(["log", "-1", `--format=${LOG_FORMAT}`, "--", ...paths], cwd);
  return parseLog(output)[0] ?? null;
}

function sinceArgument(sinceMs) {
  return `--since=${new Date(sinceMs + 1000).toISOString()}`;
}

// Counting with rev-list is much cheaper than formatting every commit, and the
// count is all a drift number needs.
export async function countCommitsSince(sinceMs, paths, cwd) {
  if (paths.length === 0 || sinceMs == null) {
    return 0;
  }
  const output = await git(["rev-list", "--count", sinceArgument(sinceMs), "HEAD", "--", ...paths], cwd);
  return Number(output.trim()) || 0;
}

export async function commitsSince(sinceMs, paths, cwd, limit = 0) {
  if (paths.length === 0 || sinceMs == null) {
    return [];
  }
  const args = ["log", `--format=${LOG_FORMAT}`, sinceArgument(sinceMs)];
  if (limit > 0) {
    args.push(`-${limit}`);
  }
  args.push("--", ...paths);
  return parseLog(await git(args, cwd));
}

// Expanding globs with git itself keeps one notion of "tracked file" and needs
// no dependency: git understands pathspecs, including ** patterns.
export async function trackedFiles(patterns, cwd) {
  if (patterns.length === 0) {
    return [];
  }
  const output = await git(["ls-files", "--", ...patterns], cwd);
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function matchesAnything(patterns, cwd) {
  if (patterns.length === 0) {
    return false;
  }
  const output = await git(["ls-files", "-z", "--", ...patterns], cwd);
  return output.length > 0;
}

export async function docFiles(patterns, cwd) {
  return trackedFiles(patterns, cwd);
}

// Bounded concurrency: enough git processes to hide their startup cost, no more.
export async function mapConcurrently(items, worker, limit = 8) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
