#!/bin/sh
# End-to-end run of the sidenote CLI: plays the skill's steps without an LLM.
# Usage: cli/tests/e2e.sh [path/to/sidenote]   (defaults to target/debug/sidenote)
set -eu

cd "$(dirname "$0")/../.."
export PATH="$HOME/.cargo/bin:$PATH"
SIDENOTE="${1:-target/debug/sidenote}"
[ -x "$SIDENOTE" ] || cargo build -p sidenote-cli
SIDENOTE="$(cd "$(dirname "$SIDENOTE")" && pwd)/$(basename "$SIDENOTE")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export SIDENOTE_HOME="$WORK/home"
# No app runs here, so `apply` takes the file path it keeps for this script.
export SIDENOTE_APPLY_FILE=1
DOC="$WORK/restore.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
expect_exit() { # expected actual label
  [ "$1" = "$2" ] || fail "$3: expected exit $1, got $2"
}

cat > "$DOC" <<'EOF'
# Restore plan

The restore then deletes its own hold row in `finally`.

- one item
- two item
EOF

# --- register --------------------------------------------------------------
export CLAUDE_CODE_SESSION_ID=sid-a
"$SIDENOTE" register "$DOC" | grep -q "^registered" || fail "register"
"$SIDENOTE" register "$DOC" | grep -q "^already registered" || fail "register idempotent"
ID="$("$SIDENOTE" list --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"
[ -f "$SIDENOTE_HOME/docs/$ID/v001.md" ] || fail "snapshot v001"

# --- unregistered doc is exit 2 -------------------------------------------
echo "x" > "$WORK/other.md"
set +e; "$SIDENOTE" turn begin "$WORK/other.md" --wait 0 >/dev/null 2>&1; rc=$?; set -e
expect_exit 2 "$rc" "unregistered"

# --- the app posts a comment (simulated by writing threads.json via python) -
# The app writes threads.json through core; here we emulate the same shape.
python3 - "$SIDENOTE_HOME/docs/$ID/threads.json" <<'EOF'
import json, sys
p = sys.argv[1]
t = json.load(open(p))
t["threads"].append({
  "id": "c1", "status": "open",
  "selector": {"exact": "deletes its own hold row", "prefix": "The restore then ", "suffix": " in finally.", "start": 30},
  "created_at": "2026-08-20T14:02:11Z",
  "messages": [{"author": "user", "at": "2026-08-20T14:02:11Z", "body": "Why in finally?"}],
})
json.dump(t, open(p, "w"), indent=2)
EOF

# The user also edits the document in the app.
sed -i '' 's/two item/second item/' "$DOC"

# --- turn begin ------------------------------------------------------------
OUT="$("$SIDENOTE" turn begin "$DOC" --wait 0)"
echo "$OUT" | grep -q "thread c1" || fail "turn begin lists c1"
echo "$OUT" | grep -q "^+- second item" || fail "turn begin shows the user's diff"
python3 -c "import json,sys; s=json.load(open('$SIDENOTE_HOME/docs/$ID/state.json')); sys.exit(1 if s['busy'] else 0)" || fail "turn begin must not lock"
"$SIDENOTE" lock "$DOC" --wait 0 | grep -q "^locked" || fail "lock"
python3 -c "import json,sys; s=json.load(open('$SIDENOTE_HOME/docs/$ID/state.json')); sys.exit(0 if s['busy'] and s['busy_by']=='sid-a' else 1)" || fail "busy set"

# Another session is refused while the lock is fresh.
set +e; CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" turn begin "$DOC" --wait 0 >/dev/null 2>&1; rc=$?; set -e
expect_exit 3 "$rc" "locked"

# --- Claude edits and replies ---------------------------------------------
sed -i '' 's/deletes its own hold row in `finally`/removes its own hold row inside `finally`/' "$DOC"
"$SIDENOTE" reply "$DOC" c1 "Reworded; finally also covers the dead-letter path." --done | grep -q "replied to c1 (open, done)" || fail "reply"
"$SIDENOTE" anchor "$DOC" c1 "removes its own hold row" | grep -q "^anchored c1" || fail "anchor"

# --- turn end --------------------------------------------------------------
OUT="$("$SIDENOTE" turn end "$DOC")"
echo "$OUT" | grep -q "snapshot v002" || fail "turn end snapshot"
[ -f "$SIDENOTE_HOME/docs/$ID/v002.md" ] || fail "v002 written"
python3 -c "import json,sys; s=json.load(open('$SIDENOTE_HOME/docs/$ID/state.json')); sys.exit(1 if s['busy'] else 0)" || fail "busy cleared"
"$SIDENOTE" threads "$DOC" --all | python3 -c 'import json,sys; t=json.load(sys.stdin); assert t[0]["status"]=="open" and t[0]["done"] and t[0]["selector"]["exact"]=="removes its own hold row" and len(t[0]["messages"])==2 and t[0]["messages"][-1]["author"]=="claude", t'
# A thread whose last message is Claude's does not come back on the next turn.
"$SIDENOTE" turn begin "$DOC" --wait 0 | grep -q "no threads await a reply" || fail "answered thread not re-served"
"$SIDENOTE" turn end "$DOC" >/dev/null

# --- comment during a turn: exit 4 ----------------------------------------
"$SIDENOTE" turn begin "$DOC" --wait 0 >/dev/null
sleep 1
python3 - "$SIDENOTE_HOME/docs/$ID/threads.json" <<'EOF'
import json, sys, datetime
p = sys.argv[1]
t = json.load(open(p))
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
t["threads"].append({
  "id": "c2", "status": "open",
  "selector": {"exact": "one item", "prefix": "", "suffix": "\nsecond item", "start": 0},
  "created_at": now,
  "messages": [{"author": "user", "at": now, "body": "during the turn"}],
})
json.dump(t, open(p, "w"), indent=2)
EOF
set +e; "$SIDENOTE" turn end "$DOC" >/dev/null; rc=$?; set -e
expect_exit 4 "$rc" "new messages during turn"

# --- unlock: exit 5 --------------------------------------------------------
"$SIDENOTE" turn begin "$DOC" --wait 0 | grep -q "thread c2" || fail "c2 awaits reply"
"$SIDENOTE" lock "$DOC" --wait 0 >/dev/null
python3 - "$SIDENOTE_HOME/docs/$ID/state.json" <<'EOF'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s.update({"busy": False, "busy_since": None, "busy_by": None, "unlocked_at": "2026-08-20T15:00:00Z", "unlocked_session": s["busy_by"]})
json.dump(s, open(p, "w"))
EOF
set +e; "$SIDENOTE" reply "$DOC" c2 "late" >/dev/null 2>&1; rc=$?; set -e
expect_exit 5 "$rc" "reply after unlock"
set +e; "$SIDENOTE" turn end "$DOC" >/dev/null 2>&1; rc=$?; set -e
expect_exit 5 "$rc" "turn end after unlock"

# --- ownership takeover when the owner is not connected -------------------
CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" turn begin "$DOC" --wait 0 | grep -q "taken over from session sid-a" || fail "takeover"
CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" reply "$DOC" c2 "handled by b" >/dev/null
CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" turn end "$DOC" >/dev/null
"$SIDENOTE" list | grep -q "owner=sid-b" || fail "owner updated"
# Hand it back, so the rest of the script runs as sid-a. sid-b is not
# connected, so turn begin inherits the document — the documented way in.
"$SIDENOTE" turn begin "$DOC" --wait 0 >/dev/null
"$SIDENOTE" turn end "$DOC" >/dev/null
"$SIDENOTE" list | grep -q "owner=sid-a" || fail "handed back"

# --- Claude-initiated note -------------------------------------------------
"$SIDENOTE" note "$DOC" "second item" "Renamed while tidying the list." | grep -q "^noted c3" || fail "note"
"$SIDENOTE" turn begin "$DOC" --wait 0 | grep -q "no threads await a reply" || fail "note must not await Claude"
"$SIDENOTE" turn end "$DOC" >/dev/null

# --- apply: edit, re-anchor and reply in one call --------------------------
"$SIDENOTE" turn begin "$DOC" --wait 0 >/dev/null
# The user comments on the passage Claude tidied earlier.
python3 - "$SIDENOTE_HOME/docs/$ID/threads.json" <<'PYEOF'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["threads"][0]["messages"].append(
    {"author": "user", "at": "2036-01-01T09:00:00Z", "body": "tighten it"}
)
json.dump(data, open(path, "w"))
PYEOF
[ "$("$SIDENOTE" waiting "$DOC")" = "c1" ] || fail "waiting names the thread awaiting a reply"

OUT="$("$SIDENOTE" apply "$DOC" --thread c1 --wait 0 \
  --old 'removes its own hold row inside `finally`' \
  --new 'drops the hold it took in `finally`' \
  --reply "Tightened." --done)"
echo "$OUT" | grep -q "^applied to" || fail "apply"
echo "$OUT" | grep -q "re-anchored to" || fail "apply re-anchors the thread"
grep -q "drops the hold it took" "$DOC" || fail "apply wrote the file"
[ -z "$("$SIDENOTE" waiting "$DOC")" ] || fail "apply must answer the thread"
# The lock it takes for the write is released again, so the user is not frozen.
python3 -c "import json,sys; s=json.load(open('$SIDENOTE_HOME/docs/$ID/state.json')); sys.exit(1 if s['busy'] else 0)" || fail "apply left the document locked"
# And it records where the edit landed, for the app's presence marker.
python3 -c "import json,sys; f=(json.load(open('$SIDENOTE_HOME/docs/$ID/state.json')).get('focus') or {}); sys.exit(0 if 'drops the hold' in f.get('exact','') else 1)" || fail "apply recorded no focus"

# An edit against text the user has since changed fails instead of clobbering.
BEFORE="$(cat "$DOC")"
set +e; "$SIDENOTE" apply "$DOC" --old "text that is not there" --new "x" --wait 0 >/dev/null 2>&1; rc=$?; set -e
expect_exit 6 "$rc" "apply against stale text"
[ "$(cat "$DOC")" = "$BEFORE" ] || fail "a refused apply must not touch the file"

"$SIDENOTE" turn end "$DOC" >/dev/null
python3 -c "import json,sys; sys.exit(1 if json.load(open('$SIDENOTE_HOME/docs/$ID/state.json')).get('focus') else 0)" || fail "turn end must clear the focus"

# --- only the owner writes -------------------------------------------------
# sid-a owns the document. sid-b must not be able to answer or edit behind it,
# even though it owned the document a moment ago and no lock is held.
BEFORE="$(cat "$DOC")"
set +e
CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" reply "$DOC" c1 "sneaky" >/dev/null 2>&1; expect_exit 3 "$?" "non-owner reply"
CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" lock "$DOC" --wait 0 >/dev/null 2>&1; expect_exit 3 "$?" "non-owner lock"
CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" note "$DOC" "second item" "mine" >/dev/null 2>&1; expect_exit 3 "$?" "non-owner note"
CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" anchor "$DOC" c1 "second item" >/dev/null 2>&1; expect_exit 3 "$?" "non-owner anchor"
CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" turn end "$DOC" >/dev/null 2>&1; expect_exit 3 "$?" "non-owner turn end"
CLAUDE_CODE_SESSION_ID=sid-b "$SIDENOTE" apply "$DOC" --old "second item" --new "x" --wait 0 >/dev/null 2>&1
expect_exit 3 "$?" "non-owner apply"
set -e
[ "$(cat "$DOC")" = "$BEFORE" ] || fail "a non-owner must not touch the file"

# --- suggesting mode -------------------------------------------------------
# The mode is the user's switch; the app is where an edit becomes a suggestion,
# because only the app can match against the text on screen. What this script
# can reach is the switch itself, and the refusal on the path with no app.
"$SIDENOTE" suggest "$DOC" | grep -q "^suggesting: off" || fail "suggesting starts off"
"$SIDENOTE" suggest "$DOC" --on | grep -q "^suggesting: on" || fail "suggest --on"
"$SIDENOTE" turn begin "$DOC" --wait 0 | grep -q "suggesting mode is ON" || fail "turn begin must announce the mode"

# This script drives the file path, which cannot offer the user the decision
# the mode promises, so it has to refuse rather than write anyway.
BEFORE="$(cat "$DOC")"
set +e
OUT="$("$SIDENOTE" apply "$DOC" --wait 0 --old "one item" --new "the first item" 2>&1)"
rc=$?
set -e
expect_exit 1 "$rc" "the file path must refuse while the mode is on"
echo "$OUT" | grep -q "suggesting mode" || fail "the refusal must say why: $OUT"
[ "$(cat "$DOC")" = "$BEFORE" ] || fail "a refused apply must not touch the file"

"$SIDENOTE" suggest "$DOC" --off | grep -q "^suggesting: off" || fail "suggest --off"
"$SIDENOTE" apply "$DOC" --wait 0 --old "one item" --new "the first item" >/dev/null || fail "apply works again with the mode off"
grep -q "the first item" "$DOC" || fail "apply wrote the file once the mode was off"
"$SIDENOTE" turn end "$DOC" >/dev/null

# --- the file never carries review data -----------------------------------
grep -q "comment\|sidenote" "$DOC" && fail "document polluted"

echo "e2e: all steps passed ($SIDENOTE_HOME)"
