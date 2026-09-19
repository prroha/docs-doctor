#!/usr/bin/env bash
# End-to-end tests. Builds throwaway git repositories with controlled commit
# dates, then runs the real CLI against them.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCTOR="$(dirname "$HERE")/bin/docs-doctor.mjs"
WORK="$(mktemp -d)"

pass=0
fail=0

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

check() {
  local name="$1" needle="$2" actual="$3"
  case "$actual" in
    *"$needle"*)
      printf "  ok    %s\n" "$name"
      pass=$((pass + 1))
      ;;
    *)
      printf "  FAIL  %s\n        expected to contain: %s\n        got: %s\n" "$name" "$needle" "$actual"
      fail=$((fail + 1))
      ;;
  esac
}

check_missing() {
  local name="$1" needle="$2" actual="$3"
  case "$actual" in
    *"$needle"*)
      printf "  FAIL  %s\n        should not contain: %s\n" "$name" "$needle"
      fail=$((fail + 1))
      ;;
    *)
      printf "  ok    %s\n" "$name"
      pass=$((pass + 1))
      ;;
  esac
}

check_code() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf "  ok    %s\n" "$name"
    pass=$((pass + 1))
  else
    printf "  FAIL  %s (expected exit %s, got %s)\n" "$name" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

# Commit with a fixed date, so drift is deterministic instead of depending on
# how long the test took to run.
commit_at() {
  local repo="$1" days_ago="$2" message="$3"
  local stamp
  stamp="$(date -u -v-"${days_ago}"d +"%Y-%m-%dT%H:%M:%S" 2>/dev/null \
    || date -u -d "${days_ago} days ago" +"%Y-%m-%dT%H:%M:%S")"
  GIT_AUTHOR_DATE="$stamp" GIT_COMMITTER_DATE="$stamp" \
    git -C "$repo" commit -q -m "$message"
}

build_repo() {
  local repo="$WORK/repo"
  mkdir -p "$repo/src/scraper" "$repo/src/ledger" "$repo/docs/system/scraper" "$repo/docs/system/ledger" "$repo/docs/system/ghost"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name "Test"

  cat > "$repo/docs/system/scraper/README.md" <<'DOC'
---
title: scraper
code:
  - src/scraper/**
---

# scraper
DOC
  cat > "$repo/docs/system/ledger/README.md" <<'DOC'
---
title: ledger
code:
  - src/ledger/**
---

# ledger
DOC
  cat > "$repo/docs/system/ghost/README.md" <<'DOC'
---
title: ghost
code:
  - src/deleted-long-ago/**
---

# ghost
DOC
  echo "one" > "$repo/src/scraper/index.js"
  echo "one" > "$repo/src/ledger/index.js"
  git -C "$repo" add -A
  commit_at "$repo" 40 "initial commit with docs and code"

  # The scraper's code moves twelve times; its doc does not.
  for i in $(seq 1 12); do
    echo "change $i" >> "$repo/src/scraper/index.js"
    git -C "$repo" add -A
    commit_at "$repo" $((30 - i)) "feat(scraper): change $i"
  done

  # The ledger's doc and code move together.
  echo "change" >> "$repo/src/ledger/index.js"
  echo "updated" >> "$repo/docs/system/ledger/README.md"
  git -C "$repo" add -A
  commit_at "$repo" 1 "feat(ledger): change, with the doc"

  echo "$repo"
}

echo "building a repository with known history"
REPO="$(build_repo)" || exit 1

echo "check"
report="$("$DOCTOR" --dir "$REPO")"
check "reports the drifted system as stale" "stale" "$report"
check "counts the drift in commits" "12 commits" "$report"
check "reports the system kept in step as fresh" "fresh" "$report"
check "reports a doc whose code is gone as an orphan" "orphan" "$report"
check "summarizes what needs attention" "need attention" "$report"
check "suggests where to start" "docs-doctor explain" "$report"

echo "--stale"
stale="$("$DOCTOR" --dir "$REPO" --stale)"
check "keeps the stale system" "scraper" "$stale"
check_missing "drops the fresh one" "ledger" "$stale"

echo "--json"
json="$("$DOCTOR" --dir "$REPO" --json)"
check "reports a summary object" '"summary"' "$json"
check "reports each system" '"driftCommits"' "$json"
if command -v python3 >/dev/null 2>&1; then
  parsed="$(printf "%s" "$json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
scraper = [s for s in data['systems'] if s['name'] == 'scraper'][0]
print(scraper['status'] + ',' + str(scraper['driftCommits']) + ',' + str(data['summary']['total']))
")"
  check "json carries the same numbers" "stale,12,3" "$parsed"
fi

echo "thresholds"
check "a raised threshold makes it merely behind" "behind" \
  "$("$DOCTOR" --dir "$REPO" --stale-commits 50)"

echo "--ci"
"$DOCTOR" --dir "$REPO" --ci >/dev/null 2>&1
check_code "fails a build when docs need attention" 2 "$?"
"$DOCTOR" --dir "$REPO" --ci --stale-commits 50 --docs "docs/system/ledger/*.md" >/dev/null 2>&1
check_code "passes when they are current" 0 "$?"

echo "explain"
explanation="$("$DOCTOR" --dir "$REPO" explain scraper)"
check "names the commits the doc missed" "feat(scraper): change 12" "$explanation"
check "shows the drift count" "12 commits of drift" "$explanation"
check "shows the declared code paths" "src/scraper/**" "$explanation"
check "explains an unknown doc clearly" "no doc called" "$("$DOCTOR" --dir "$REPO" explain nope 2>&1)"

echo "new"
scaffold="$("$DOCTOR" --dir "$REPO" new payments)"
check "scaffolds the three files" "docs/system/payments/README.md" "$scaffold"
check "tells you to set the code paths" "code" "$scaffold"
check "the scaffold carries front matter" "code:" "$(cat "$REPO/docs/system/payments/README.md")"
check "running it again is harmless" "already has its docs" "$("$DOCTOR" --dir "$REPO" new payments)"

echo "docs that are not READMEs"
cat > "$REPO/docs/architecture.md" <<'DOC'
# Architecture

No front matter, so nothing ties this to code.
DOC
cat > "$REPO/docs/pipeline.md" <<'DOC'
---
title: pipeline
code:
  - src/ledger/**
---

# Pipeline
DOC
git -C "$REPO" add -A
commit_at "$REPO" 1 "docs: add architecture and pipeline"
plain="$("$DOCTOR" --dir "$REPO")"
check "an unmapped doc that is not a README is still reported" "architecture" "$plain"
check "and counts as needing attention" "unmapped" "$plain"
check "a non-README that declares code is reported" "pipeline" "$plain"
"$DOCTOR" --dir "$REPO" --ci --docs "docs/architecture.md" >/dev/null 2>&1
check_code "--ci fails on an unmapped doc alone" 2 "$?"

echo "a guessed mapping does not count its own docs as code"
mkdir -p "$REPO/docs/system/widgets"
cat > "$REPO/docs/system/widgets/README.md" <<'DOC'
# widgets

No code declared, and no src/widgets directory exists.
DOC
cat > "$REPO/docs/system/widgets/TODO.md" <<'DOC'
# widgets — TODO
DOC
git -C "$REPO" add -A
commit_at "$REPO" 1 "docs: add widgets"
widgets="$("$DOCTOR" --dir "$REPO" --json | python3 -c "
import json, sys
rows = [s for s in json.load(sys.stdin)['systems'] if s['name'] == 'widgets']
print(rows[0]['status'] if rows else 'missing')
")"
check "a README whose only match is its own TODO is unmapped, not fresh" "unmapped" "$widgets"

echo "a doc missing from the working tree"
rm "$REPO/docs/architecture.md"
check "reads as a tool error, not a crash" "unmapped" "$("$DOCTOR" --dir "$REPO" 2>&1)"
git -C "$REPO" checkout -q -- docs/architecture.md

echo "companion docs"
cat > "$REPO/docs/system/scraper/TODO.md" <<'DOC'
# scraper — TODO
DOC
git -C "$REPO" add -A
commit_at "$REPO" 1 "docs(scraper): add a TODO"
check_missing "a TODO beside a README is not its own system" "TODO" "$("$DOCTOR" --dir "$REPO")"
check "--all shows companions" "TODO" "$("$DOCTOR" --dir "$REPO" --all)"

echo "errors"
check "a directory outside git is reported" "not inside a git repository" \
  "$("$DOCTOR" --dir "$WORK" 2>&1)"
"$DOCTOR" --dir "$WORK" >/dev/null 2>&1
check_code "and exits 3" 3 "$?"
check "an unknown option is refused" "unknown option" "$("$DOCTOR" --nope 2>&1)"
check "an unknown command is refused" "unknown command" "$("$DOCTOR" --dir "$REPO" wat 2>&1)"
check "a missing option value is refused" "needs a value" "$("$DOCTOR" --dir 2>&1)"

echo
printf "passed: %s   failed: %s\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
