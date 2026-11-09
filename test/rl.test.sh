#!/bin/sh
# Tests for mods/readlist/bin/rl (and the bin/rl link to it) against a scratch READING_LIST_DIR. Needs node to check the JSON.
# Run: sh test/rl.test.sh            (RL_SHELL=dash runs rl under dash)

set -u

# Windows uses the PowerShell rl (bin/windows/rl.ps1), tested in test/windows.test.mjs.
case $(uname -s 2>/dev/null) in MINGW* | MSYS* | CYGWIN*)
	echo "rl.test.sh: skipped on Windows, which runs rl.ps1 (test/windows.test.mjs)"
	exit 0
	;;
esac

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
RL=$repo/mods/readlist/bin/rl
scratch=$(mktemp -d) || exit 1
scratch=$(CDPATH='' cd -- "$scratch" && pwd -P)
trap 'rm -rf -- "${scratch:?}"' EXIT
export READING_LIST_DIR="$scratch/list"
if [ -n "${RL_SHELL:-}" ]; then
	printf '#!/bin/sh\nexec %s %s "$@"\n' "$RL_SHELL" "$RL" >"$scratch/rl"
	chmod +x "$scratch/rl"
	RL=$scratch/rl
fi
unset HC_TERMINAL_ID
fails=0
passes=0

ok() { passes=$((passes + 1)); }
fail() {
	fails=$((fails + 1))
	printf 'FAIL: %s\n' "$*" >&2
}
eq() { if [ "$1" = "$2" ]; then ok; else fail "$3: expected [$2], got [$1]"; fi; }
# A field of an item file, read with node: q <file> <js expression on the object o>
q() { node -e 'const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = eval(process.argv[2]); process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));' "$1" "$2"; }
sha() { printf '%s' "$1" | shasum -a 256 | cut -c1-16; }

mkdir -p "$scratch/docs/sub dir"
printf '# Rollout plan\n\nbody\n' >"$scratch/docs/sub dir/plan.md"
ln -s "$scratch/docs" "$scratch/link"

# add: id from the real path, title from the first heading, note escaped.
note='say "hi" \ back
second	line é'
id=$("$RL" add "$scratch/link/sub dir/../sub dir/plan.md" --note "$note")
eq "$?" 0 "add exits 0"
eq "$id" "$(sha "$scratch/docs/sub dir/plan.md")" "id is sha256 of the real path"
f=$READING_LIST_DIR/items/$id.json
eq "$(q "$f" o.path)" "$scratch/docs/sub dir/plan.md" "path is real and absolute"
eq "$(q "$f" o.title)" "Rollout plan" "title from the markdown heading"
eq "$(q "$f" o.note)" "$note" "note survives quotes, backslash, newline, tab, UTF-8"
eq "$(q "$f" '[o.v, o.kind, o.adds, o.size, o.url, o.done_at]')" '[1,"review",1,21,null,null]' "defaults and size"
eq "$(q "$f" '/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(o.added_at) && /Z$/.test(o.mtime)')" true "times are ISO UTC"
eq "$(q "$f" o.by.from)" "$(id -un)@$(ps -o comm= -p $$ | sed 's/^-//; s|.*/||')" "from outside hc: user@parent"
eq "$(find "$READING_LIST_DIR/items" -name '.*' | wc -l | tr -d ' ')" 0 "no temp files left"

# re-add: replaces the note, counts adds.
id2=$("$RL" add "$scratch/docs/sub dir/plan.md" --kind fyi --title "Plan v2" --from "ci job")
eq "$id2" "$id" "same path, same id"
eq "$(q "$f" '[o.adds, o.note, o.kind, o.title, o.by.from]')" '[2,null,"fyi","Plan v2","ci job"]' "re-add replaces fields and counts"

# --if-new: an item already on the list stays as it is; a new one is added as usual.
before=$(cat "$f")
eq "$("$RL" add "$scratch/docs/sub dir/plan.md" --if-new --note other --kind result)" "$id" "--if-new prints the id of the item there"
eq "$(cat "$f")" "$before" "--if-new leaves that item unchanged"
printf 'x\n' >"$scratch/docs/new.txt"
nid=$("$RL" add "$scratch/docs/new.txt" --if-new --kind result --note "fresh")
eq "$(q "$READING_LIST_DIR/items/$nid.json" '[o.adds, o.kind, o.note]')" '[1,"result","fresh"]' "--if-new adds a new item"
"$RL" rm "$nid" >/dev/null

# errors
"$RL" add "$scratch/nope.md" 2>/dev/null
eq "$?" 1 "missing file exits 1"
"$RL" add "$scratch/docs" --kind weird 2>/dev/null
eq "$?" 1 "bad kind exits 1"
"$RL" add 2>/dev/null
eq "$?" 1 "add without a target exits 1"
"$RL" frob 2>/dev/null
eq "$?" 2 "unknown command exits 2"

# URL and folder
uid=$("$RL" add https://herdr.dev/mods --kind result)
eq "$uid" "$(sha https://herdr.dev/mods)" "URL id"
eq "$(q "$READING_LIST_DIR/items/$uid.json" '[o.path, o.url, o.title, o.size]')" '[null,"https://herdr.dev/mods","herdr.dev/mods",null]' "URL item"
did=$("$RL" add "$scratch/docs/")
eq "$(q "$READING_LIST_DIR/items/$did.json" '[o.path, o.title, o.size]')" "[\"$scratch/docs\",\"docs\",null]" "folder item"

# attribution from hc: top-level fields, not the foreground's or ones inside strings.
mkdir -p "$scratch/bin"
cat >"$scratch/bin/hc" <<'EOF'
#!/bin/sh
[ "$1 $2 $3" = "get t9 --json" ] || exit 1
cat <<'JSON'
{"address":"t9","argv":["zsh","--name \"name\":\"evil\""],"cwd":"/work/x","foreground":{"argv":["claude"],"cwd":"/elsewhere","name":"claude.exe"},"labels":{"herdr.space":"sp1","herdr.tab":"tb1","other":"x"},"name":"fix-login","status":{"app":"claude-code","msg":"m","state":"working"},"empty":{},"list":[]}
JSON
EOF
chmod +x "$scratch/bin/hc"
hid=$(PATH="$scratch/bin:$PATH" HC_TERMINAL_ID=t9 "$RL" add "$scratch/docs/sub dir/plan.md")
eq "$(q "$READING_LIST_DIR/items/$hid.json" o.by)" '{"terminal":"t9","app":"claude-code","name":"fix-login","space":"sp1","tab":"tb1","cwd":"/work/x","from":null}' "attribution from hc get"
bid=$(PATH="$scratch/bin:$PATH" HC_TERMINAL_ID=t404 "$RL" add "$scratch/docs/sub dir/plan.md")
eq "$(q "$READING_LIST_DIR/items/$bid.json" '[o.by.terminal, typeof o.by.from]')" '[null,"string"]' "hc get failing falls back to from"

# ls with the person's state
"$RL" ls >"$scratch/ls.txt"
eq "$(wc -l <"$scratch/ls.txt" | tr -d ' ')" 3 "ls lists open items"
printf '{"v":1,"items":{"%s":{"read_at":"2099-01-01T00:00:00.000Z"},"%s":{"done_at":"2099-01-01T00:00:00.000Z"}}}\n' "$uid" "$did" >"$READING_LIST_DIR/state.json"
eq "$("$RL" ls --unread | cut -c1-16)" "$id" "ls --unread skips read and done"
eq "$("$RL" ls --done | cut -c1-16)" "$did" "ls --done"
eq "$("$RL" ls --all | wc -l | tr -d ' ')" 3 "ls --all"
eq "$(grep "^$uid" "$scratch/ls.txt" | awk '{print $2}')" unread "state shown: before"
eq "$("$RL" ls | grep "^$uid" | awk '{print $2}')" read "state shown: read"
"$RL" ls --json --all | node -e 'const a = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(a.length === 3 && a.every((i) => i.v === 1) ? 0 : 1)'
eq "$?" 0 "ls --json is a JSON array of items"

# done: by path, then a re-add brings it back
eq "$("$RL" "done" "$scratch/docs/sub dir/plan.md")" "$id" "done prints the id"
eq "$(q "$f" '[typeof o.done_at, o.adds, o.title]')" '["string",4,"Rollout plan"]' "done keeps the rest of the item"
eq "$("$RL" ls --done | cut -c1-16 | sort | tr '\n' ' ')" "$(printf '%s\n%s\n' "$id" "$did" | sort | tr '\n' ' ')" "done shows in ls --done"
"$RL" add "$scratch/docs/sub dir/plan.md" >/dev/null
eq "$(q "$f" o.done_at)" null "re-add clears done"
"$RL" "done" ffffffffffffffff 2>/dev/null
eq "$?" 1 "done on an unknown id exits 1"

# rm: by id, and by path after the file is gone
eq "$("$RL" rm "$uid")" "$uid" "rm by id"
rm -f -- "$scratch/docs/sub dir/plan.md"
eq "$("$RL" rm "$scratch/docs/sub dir/plan.md")" "$id" "rm by path of a deleted file"
"$RL" rm "$scratch/docs/sub dir/plan.md" 2>/dev/null
eq "$?" 1 "rm twice exits 1"
"$RL" rm "$did" >/dev/null
eq "$("$RL" ls --json --all)" "[]" "empty list as JSON"
eq "$("$RL" ls --all)" "" "empty list as text"

# bin/rl is a link to the mod's copy, so there is one source.
eq "$(readlink "$repo/bin/rl")" ../mods/readlist/bin/rl "bin/rl links to the mod's rl"
eq "$("$repo/bin/rl" ls --all)" "" "bin/rl runs"

printf '%s passed, %s failed\n' "$passes" "$fails"
[ "$fails" -eq 0 ]
