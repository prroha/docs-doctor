// Turning "when did the doc last change" and "when did its code last change"
// into a status a person can act on.

export const STATUS = {
  fresh: "fresh",
  behind: "behind",
  stale: "stale",
  unmapped: "unmapped",
  orphan: "orphan",
  untracked: "untracked",
};

export const DEFAULT_THRESHOLDS = {
  behindCommits: 1,
  staleCommits: 10,
  staleDays: 30,
};

const MS_PER_DAY = 86400000;

export function daysBetween(fromMs, toMs) {
  if (fromMs == null || toMs == null) {
    return null;
  }
  return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

// Drift is counted in commits that touched the code after the doc last changed,
// because "28 commits since anyone updated this" persuades where "34 days" does not.
export function classify(system, thresholds = DEFAULT_THRESHOLDS) {
  const { codePaths, inferredMapping, docCommittedAtMs, codeCommittedAtMs, driftCommits } = system;

  if (codePaths.length === 0) {
    return STATUS.unmapped;
  }
  if (docCommittedAtMs == null) {
    return STATUS.untracked;
  }
  if (codeCommittedAtMs == null) {
    return inferredMapping ? STATUS.unmapped : STATUS.orphan;
  }
  if (driftCommits >= thresholds.staleCommits) {
    return STATUS.stale;
  }
  const codeAheadDays = daysBetween(docCommittedAtMs, codeCommittedAtMs) ?? 0;
  if (driftCommits > 0 && codeAheadDays >= thresholds.staleDays) {
    return STATUS.stale;
  }
  if (driftCommits >= thresholds.behindCommits) {
    return STATUS.behind;
  }
  return STATUS.fresh;
}

export function needsAttention(status) {
  return status === STATUS.stale || status === STATUS.unmapped || status === STATUS.orphan;
}

export function summarize(systems) {
  const counts = Object.fromEntries(Object.values(STATUS).map((status) => [status, 0]));
  for (const system of systems) {
    counts[system.status] = (counts[system.status] ?? 0) + 1;
  }
  return {
    total: systems.length,
    counts,
    needsAttention: systems.filter((system) => needsAttention(system.status)).length,
    worstDrift: systems.reduce((worst, system) => Math.max(worst, system.driftCommits ?? 0), 0),
  };
}

function ageInDays(timestampMs, nowMs) {
  const days = daysBetween(timestampMs, nowMs);
  return days == null ? "—" : `${days}d`;
}

export function describeDrift(system) {
  switch (system.status) {
    case STATUS.unmapped:
      return "unmapped";
    case STATUS.orphan:
      return "orphan";
    case STATUS.untracked:
      return "untracked";
    default:
      return `${system.driftCommits} commit${system.driftCommits === 1 ? "" : "s"}`;
  }
}

export function toRows(systems, nowMs) {
  return systems.map((system) => ({
    system: system.name,
    docAge: ageInDays(system.docCommittedAtMs, nowMs),
    codeAge: ageInDays(system.codeCommittedAtMs, nowMs),
    drift: describeDrift(system),
    status: system.status,
  }));
}

// A fixed-width table, so output stays readable in a terminal and in a PR comment.
export function renderTable(rows) {
  const columns = [
    { key: "system", label: "SYSTEM" },
    { key: "docAge", label: "DOC AGE" },
    { key: "codeAge", label: "CODE AGE" },
    { key: "drift", label: "DRIFT" },
    { key: "status", label: "STATUS" },
  ];
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => String(row[column.key] ?? "").length), 0),
  );
  const line = (values) =>
    values.map((value, index) => String(value ?? "").padEnd(widths[index])).join("  ").trimEnd();

  return [
    line(columns.map((column) => column.label)),
    ...rows.map((row) => line(columns.map((column) => row[column.key]))),
  ].join("\n");
}
