// Reading the front matter that ties a doc to the code it describes.
//
// A doc declares its code paths itself, so the mapping travels with the doc and
// is reviewed in the same pull request as the doc:
//
//   ---
//   title: Carrier scrape
//   code:
//     - src/carrier-scraper/**
//     - src/packages/carrier-book/**
//   ---
//
// Only the keys docs-doctor needs are read (code, title, ignore), as scalars or
// as a block list. This is not a YAML parser and does not pretend to be one.

const FENCE = "---";
const LIST_KEYS = new Set(["code", "ignore"]);

function stripQuotes(value) {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

function splitInlineList(value) {
  const inner = /^\[(.*)\]$/.exec(value.trim());
  const body = inner ? inner[1] : value;
  return body
    .split(",")
    .map((entry) => stripQuotes(entry))
    .filter(Boolean);
}

// Returns { data, body }: the recognised keys, and the doc with front matter removed.
export function parseFrontMatter(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== FENCE) {
    return { data: {}, body: text };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (closing === -1) {
    return { data: {}, body: text };
  }

  const data = {};
  let currentListKey = null;
  for (const line of lines.slice(1, closing)) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      data[currentListKey].push(stripQuotes(listItem[1]));
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) {
      continue;
    }
    const [, key, rawValue] = pair;
    const value = rawValue.trim();
    if (LIST_KEYS.has(key)) {
      data[key] = value === "" ? [] : splitInlineList(value);
      currentListKey = value === "" ? key : null;
      continue;
    }
    currentListKey = null;
    data[key] = stripQuotes(value);
  }

  return { data, body: lines.slice(closing + 1).join("\n").replace(/^\n+/, "") };
}

// The system name shown in reports: the front-matter title, else the doc's
// directory (docs/system/carrier-scrape/README.md -> carrier-scrape), else its
// file name.
export function systemName(docPath, data) {
  if (data.title) {
    return data.title;
  }
  const parts = docPath.split("/").filter(Boolean);
  const file = parts[parts.length - 1] ?? docPath;
  const directory = parts[parts.length - 2];
  if (/^readme\.md$/i.test(file) && directory) {
    return directory;
  }
  return file.replace(/\.md$/i, "");
}

// When a doc declares no code paths, guess from where it lives, and say that the
// mapping was guessed so a report can still call it out.
export function inferCodePaths(docPath, data) {
  if (Array.isArray(data.code) && data.code.length > 0) {
    return { paths: data.code, inferred: false };
  }
  const name = systemName(docPath, {});
  if (!name || name === "README") {
    return { paths: [], inferred: false };
  }
  return { paths: [`**/${name}/**`], inferred: true };
}
