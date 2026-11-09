#!/bin/sh
# The reading list's built-in actions on Linux: xdg-open, the file manager over D-Bus, GNOME
# Sushi. It ships with the mod and is replaced when the mod is reinstalled; to change what an
# action does, write your own handler instead (README, "Your own handler"). The mod runs it as
#   sh linux.sh ACTION [ARG...] -- ITEM
# and reads the exit status: 0 done, 10 not handled, anything else failed (stderr says why).
#   open -- PATH                       xdg-open
#   reveal -- PATH                     the freedesktop FileManager1 ShowItems call, else
#                                      xdg-open on its folder
#   preview -- PATH                    GNOME Sushi; not handled (with the reason on stderr)
#                                      when there is no gdbus or no Sushi
#   preview-close TOKEN same|other -- PATH
#                                      same: Sushi's close-if-shown; other: nothing (Sushi
#                                      shows the next file in the same window)
#   thumbnail SIZE OUT -- PATH         not handled: the pane shows the type's icon
#   open-url -- URL                    not handled: the mod opens links in the browser
# Every program is optional: when one is missing it exits 127 and says what to install.

set -u
action=${1-}

# A file:// URI for an absolute path, every byte that is not unreserved percent-encoded (the
# slashes kept), so it also goes inside a D-Bus string literal ('...') as it is.
uri() {
	printf %s "$1" | LC_ALL=C od -An -v -tx1 2>/dev/null | LC_ALL=C awk '
		BEGIN { printf "file://"; for (i = 0; i < 16; i++) h[substr("0123456789abcdef", i + 1, 1)] = i }
		{
			for (i = 1; i <= NF; i++) {
				b = h[substr($i, 1, 1)] * 16 + h[substr($i, 2, 1)]
				if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 45 || b == 46 || b == 95 || b == 126 || b == 47) printf "%c", b
				else printf "%%%s", toupper($i)
			}
		}'
}

# Runs xdg-open "$1" in the background and waits up to 3 s for it: a desktop's opener may
# stay running as long as the app it started, which would outlive the mod's exec limit.
# Exits with xdg-open's status (and its message) when it finished within that time, else 0.
# stderr goes through a file so exec does not wait on a pipe the opener keeps open.
# $2 is the message for a missing xdg-open.
xdg() {
	command -v xdg-open >/dev/null 2>&1 || {
		echo "$2" >&2
		exit 127
	}
	e=$(mktemp) || exit 1
	xdg-open "$1" >/dev/null 2>"$e" </dev/null &
	p=$!
	n=0
	while kill -0 "$p" 2>/dev/null && [ $n -lt 30 ]; do
		sleep 0.1
		n=$((n + 1))
	done
	if kill -0 "$p" 2>/dev/null; then
		rm -f "$e"
		exit 0
	fi
	wait "$p"
	s=$?
	if [ -s "$e" ]; then cat "$e" >&2; elif [ $s = 3 ]; then echo "xdg-open found no program to open it with" >&2; fi
	rm -f "$e"
	# 10 means "not handled" to the mod; xdg-open's own statuses are 1 to 4.
	[ $s = 10 ] && s=1
	exit $s
}

# GNOME Sushi (Nautilus's previewer, started by D-Bus on demand) shows the file at $1; $2
# is "true" to close it instead when it is already showing. The current interface, then the
# older one.
sushi() {
	command -v gdbus >/dev/null 2>&1 || {
		echo "Space's preview window needs gdbus and GNOME Sushi" >&2
		exit 10
	}
	u=$(uri "$1")
	call() { gdbus call --session --timeout 5 --dest org.gnome.NautilusPreviewer --object-path /org/gnome/NautilusPreviewer --method "$@" >/dev/null 2>&1; }
	call org.gnome.NautilusPreviewer2.ShowFile "'$u'" "''" "$2" && exit 0
	call org.gnome.NautilusPreviewer.ShowFile "'$u'" 0 "$2" && exit 0
	echo "Space's preview window needs GNOME Sushi (the sushi package)" >&2
	exit 10
}

case $action in
open)
	[ "${2-}" = -- ] && [ $# -eq 3 ] || exit 2
	xdg "$3" "xdg-open is not installed (it comes with xdg-utils)"
	;;
reveal)
	[ "${2-}" = -- ] && [ $# -eq 3 ] || exit 2
	if command -v gdbus >/dev/null 2>&1 && gdbus call --session --timeout 5 --dest org.freedesktop.FileManager1 \
		--object-path /org/freedesktop/FileManager1 --method org.freedesktop.FileManager1.ShowItems "['$(uri "$3")']" "''" >/dev/null 2>&1; then
		exit 0
	fi
	xdg "$(dirname -- "$3")" "no file manager answered, and xdg-open is not installed (it comes with xdg-utils)"
	;;
preview)
	[ "${2-}" = -- ] && [ $# -eq 3 ] || exit 2
	sushi "$3" false
	;;
preview-close)
	[ "${4-}" = -- ] && [ $# -eq 5 ] || exit 2
	[ "$3" = same ] || exit 0
	sushi "$5" true
	;;
*) exit 10 ;;
esac
