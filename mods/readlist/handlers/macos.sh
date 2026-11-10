#!/bin/sh
# The reading list's built-in actions on macOS: open, Finder, Quick Look. It ships with the
# mod and is replaced when the mod is reinstalled; to change what an action does, write your
# own handler instead (README, "Your own handler"). The mod runs it as
#   sh macos.sh ACTION [ARG...] -- ITEM
# and reads the exit status: 0 done, 10 not handled, anything else failed (stderr says why).
#   open -- PATH                       open in its default app
#   reveal -- PATH                     show selected in Finder
#   preview -- PATH                    Quick Look panel; prints its pid (the token)
#   preview-close TOKEN same|other -- PATH
#                                      close the panel this pid is (only while it is qlmanage)
#   thumbnail SIZE OUT -- PATH         a PNG SIZE pixels wide at OUT, from Quick Look
#   open-url -- URL                    not handled: the mod opens links in the browser

set -u
action=${1-}

# JavaScript for osascript: activates the app with pid argv[0] once it has a window on screen,
# checking every 50 ms for up to 3 s.
front='ObjC.import("AppKit"); ObjC.import("CoreGraphics");
function run(argv) {
	const pid = Number(argv[0]);
	for (let i = 0; i < 60; i++) {
		const ws = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
		for (let j = 0; j < ws.count; j++) {
			const w = ws.objectAtIndex(j);
			if (ObjC.unwrap(w.objectForKey("kCGWindowOwnerPID")) !== pid || ObjC.unwrap(w.objectForKey("kCGWindowLayer")) !== 0) continue;
			const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
			if (!app.isNil()) app.activateWithOptions(0);
			return;
		}
		delay(0.05);
	}
}'

case $action in
open)
	[ "${2-}" = -- ] && [ $# -eq 3 ] || exit 2
	exec open "$3"
	;;
reveal)
	[ "${2-}" = -- ] && [ $# -eq 3 ] || exit 2
	exec open -R "$3"
	;;
preview)
	# In the background, so the panel outlives the mod's exec call; its pid is the token.
	[ "${2-}" = -- ] && [ $# -eq 3 ] || exit 2
	qlmanage -p "$3" >/dev/null 2>&1 </dev/null &
	q=$!
	echo $q
	# qlmanage does not come to the front by itself, so its panel opens behind Herdr: once
	# its window is on screen (within 3 s), it is made the active app, as an app opened from
	# Finder would be. NSRunningApplication sends no Apple Events, so there is no
	# Automation or Accessibility prompt. In the background, so the token is not held up.
	osascript -l JavaScript -e "$front" "$q" >/dev/null 2>&1 </dev/null &
	;;
preview-close)
	# Kills that pid only while it is still Quick Look.
	[ "${4-}" = -- ] && [ $# -eq 5 ] || exit 2
	case $2 in '' | *[!0-9]*) exit 1 ;; esac
	case "$(ps -o comm= -p "$2" 2>/dev/null)" in *qlmanage) kill "$2" ;; *) exit 1 ;; esac
	;;
thumbnail)
	# qlmanage never returns for a file Quick Look has no thumbnail for: stopped after 20 s
	# (its pid only; the watchdog's output is closed so the mod's exec does not wait, and
	# the shell's "Terminated" notice is kept out of the message).
	[ "${4-}" = -- ] && [ $# -eq 5 ] || exit 2
	size=$2 out=$3 src=$5
	d=$(mktemp -d "${out%/*}/ql.XXXXXX") || exit 1
	qlmanage -t -s "$size" -o "$d" "$src" >/dev/null 2>&1 &
	q=$!
	(
		sleep 20
		kill "$q" 2>/dev/null
	) >/dev/null 2>&1 </dev/null &
	w=$!
	wait "$q" 2>/dev/null
	kill "$w" 2>/dev/null
	wait "$w" 2>/dev/null
	f=$(ls "$d" | head -n 1)
	[ -n "$f" ] && mv "$d/$f" "$out"
	rm -rf "$d"
	[ -f "$out" ] || {
		echo "Quick Look has no thumbnail for this file" >&2
		exit 1
	}
	;;
*) exit 10 ;;
esac
