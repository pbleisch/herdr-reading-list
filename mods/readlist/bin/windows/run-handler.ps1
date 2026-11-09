# Runs an action handler for the reading list on Windows, and checks the person's own handler
# before it runs: the Windows counterpart of ../run-handler. The mod calls it with pwsh -File
# (core/handlers.js); every argument is a separate argv entry.
#
#   run-handler.ps1 check LOCATION
#     prints "ok<TAB>REAL PATH<TAB>SHA-256", "missing" or "refused<TAB>why".
#   run-handler.ps1 user LOCATION REAL SHA256 KIND ITEM ACTION [ARG...]
#     runs the person's handler only when the check passes and LOCATION still leads to REAL,
#     whose contents still hash to SHA256 (what the person turned on); else exits 11 with
#     "readlist: why" on stderr and runs nothing.
#   run-handler.ps1 builtin FILE KIND ITEM ACTION [ARG...]
#     runs a built-in handler (shipped in the mod's handlers/).
#
# Either way the handler gets `ACTION [ARG...] -- ITEM`: ITEM is an absolute path on a local
# drive with its folders resolved (KIND path) or an http or https URL (KIND url), and nothing
# else from the item. The person's handler is a PowerShell script (handler.ps1) run in a pwsh
# of its own, stopped with everything it started after ACTION_SECONDS (THUMB_SECONDS for a
# thumbnail).
#
# The check follows LOCATION and every link on the way. The file must be a .ps1 file owned by
# this user (or Administrators, the owner Windows gives files an elevated program makes, or
# SYSTEM) that no other user may change: no other account (Everyone, Users, Authenticated
# Users, any user or group but this user, SYSTEM, Administrators and TrustedInstaller) may
# write, append to, delete, re-permission or take it. Its folder must be owned by this user,
# SYSTEM, Administrators or TrustedInstaller, and no other account may add, delete or rename
# entries in it or change it; every folder above it, and above each link, the same, except
# that others may create new folders in it (Windows lets every user do that at a drive's root).

#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$ACTION_SECONDS = 12
$THUMB_SECONDS = 28

# Rights that let another account change a file or folder, or what a path leads to.
$WRITE_DATA = 0x2; $APPEND_DATA = 0x4; $DELETE_CHILD = 0x40; $DELETE = 0x10000
$WRITE_DAC = 0x40000; $WRITE_OWNER = 0x80000; $GENERIC_ALL = 0x10000000; $GENERIC_WRITE = 0x40000000
$TAKE = $DELETE -bor $WRITE_DAC -bor $WRITE_OWNER -bor $GENERIC_ALL -bor $GENERIC_WRITE
$FILE_BAD = $TAKE -bor $WRITE_DATA -bor $APPEND_DATA
$OWN_DIR_BAD = $TAKE -bor $WRITE_DATA -bor $APPEND_DATA -bor $DELETE_CHILD
$UP_DIR_BAD = $TAKE -bor $WRITE_DATA -bor $DELETE_CHILD

$Me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# SYSTEM, Administrators, TrustedInstaller, and OWNER RIGHTS (the owner, checked to be one of these).
$Trusted = @($Me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-4')

function No([string]$why) {
	Warn "readlist: $why"
	exit 11
}

function Name-Of([string]$sid) {
	try {
		return ([Security.Principal.SecurityIdentifier]::new($sid)).Translate([Security.Principal.NTAccount]).Value
	} catch {
		return $sid
	}
}

# Why another account can change $path (a file or folder), or $null. $bad: the rights that
# count; $owners: the SIDs that may own it.
function Test-Acl([string]$path, [int]$bad, [string[]]$owners) {
	try {
		$acl = Get-Acl -LiteralPath $path
	} catch {
		return "cannot read the permissions of $path"
	}
	$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
	if ($owner -notin $owners) { return "$path is owned by $(Name-Of $owner)" }
	foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
		if ($r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
		if ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
		if ($r.IdentityReference.Value -in $Trusted) { continue }
		if ([int]$r.FileSystemRights -band $bad) { return "$path can be changed by $(Name-Of $r.IdentityReference.Value)" }
	}
	return $null
}

# Why a folder chain from $dir up to its drive's root is not safe, or $null.
function Test-Folders([string]$dir, [bool]$own) {
	$owners = @($Me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
	$q = $dir
	$first = $own
	while ($q) {
		$why = Test-Acl $q $(if ($first) { $OWN_DIR_BAD } else { $UP_DIR_BAD }) $owners
		if ($why) { return $why }
		$first = $false
		$q = [IO.Path]::GetDirectoryName($q)
	}
	return $null
}

# Checks the handler at $loc: { real, sha } or { missing } or { why }.
function Test-Handler([string]$loc) {
	if (-not (Test-Path -LiteralPath $loc)) {
		$i = Get-Item -LiteralPath $loc -Force -ErrorAction SilentlyContinue
		if (-not $i) { return @{ missing = $true; why = "there is no handler at $loc" } }
	}
	$links = [Collections.Generic.List[string]]::new()
	try {
		$real = Get-RealPath $loc $true $links
	} catch {
		return @{ why = $_.Exception.Message }
	}
	if (-not [IO.File]::Exists($real)) {
		if ([IO.Directory]::Exists($real)) { return @{ why = "$real is not a regular file" } }
		return @{ why = "$loc leads to $real, which does not exist" }
	}
	if ($real -notmatch '\.ps1$') { return @{ why = "$real is not a PowerShell script (.ps1)" } }
	$why = Test-Acl $real $FILE_BAD @($Me, 'S-1-5-18', 'S-1-5-32-544')
	if ($why) { return @{ why = "$real is not yours alone ($why)" } }
	$why = Test-Folders ([IO.Path]::GetDirectoryName($real)) $true
	if ($why) { return @{ why = $why } }
	foreach ($d in $links) {
		$why = Test-Folders $d $false
		if ($why) { return @{ why = $why } }
	}
	try {
		$sha = (Get-FileHash -LiteralPath $real -Algorithm SHA256).Hash.ToLowerInvariant()
	} catch {
		return @{ why = "cannot hash $real" }
	}
	return @{ real = $real; sha = $sha }
}

# The item for KIND $kind: a path with its folders resolved, or an http(s) URL.
function Get-Item-Arg([string]$kind, [string]$item) {
	switch ($kind) {
		'url' {
			if ($item -cnotmatch '^https?://') {
				Warn 'readlist: only http and https links go to a handler'
				exit 2
			}
			return $item
		}
		'path' {
			if (-not (Test-LocalPath $item)) {
				Warn "readlist: not an absolute path: $item"
				exit 2
			}
			try {
				return Get-ItemPath $item
			} catch {
				Warn "readlist: $($_.Exception.Message)"
				exit 1
			}
		}
		default {
			Warn 'readlist: unknown item kind'
			exit 2
		}
	}
}

# The action and its arguments; none may start with "-" (pwsh -File would split -a:b).
function Get-Action([string[]]$rest) {
	foreach ($a in $rest) {
		if ($a.StartsWith('-')) {
			Warn "readlist: an argument may not start with -: $a"
			exit 2
		}
	}
	return , $rest
}

$argv = Get-RawArgs $PSCommandPath $args
$mode = if ($argv.Count) { $argv[0] } else { '' }
$rest = [string[]]@($argv | Select-Object -Skip 1)
switch -CaseSensitive ($mode) {
	'check' {
		if ($rest.Count -ne 1) { exit 2 }
		$c = Test-Handler $rest[0]
		if ($c.ContainsKey('real')) { Say "ok`t$($c.real)`t$($c.sha)" }
		elseif ($c.ContainsKey('missing')) { Say 'missing' }
		else { Say "refused`t$($c.why)" }
		exit 0
	}
	'user' {
		if ($rest.Count -lt 6) { exit 2 }
		$loc, $want, $sum = $rest[0], $rest[1], $rest[2]
		$c = Test-Handler $loc
		if (-not $c.ContainsKey('real')) { No $c.why }
		if ($c.real -ne $want) { No "$loc now leads to $($c.real), not the $want you turned on" }
		if ($c.sha -cne $sum) { No "$($c.real) changed since you turned it on" }
		$item = Get-Item-Arg $rest[3] $rest[4]
		$action = Get-Action ([string[]]@($rest | Select-Object -Skip 5))
		$limit = if ($action[0] -eq 'thumbnail') { $THUMB_SECONDS } else { $ACTION_SECONDS }
		$pwsh = [Environment]::ProcessPath
		$code = Invoke-Bounded $pwsh (@('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $c.real) + $action + @('--', $item)) $limit
		if ($code -eq -1) {
			Warn "your handler took over $limit s"
			exit 124
		}
		exit $code
	}
	'builtin' {
		if ($rest.Count -lt 4) { exit 2 }
		$file = $rest[0]
		$item = Get-Item-Arg $rest[1] $rest[2]
		$action = Get-Action ([string[]]@($rest | Select-Object -Skip 3))
		# `--` is passed as a value: written as a literal in a command, PowerShell would take it
		# as its own end-of-parameters marker.
		$all = [string[]]($action + @('--', $item))
		& $file @all
		exit $LASTEXITCODE
	}
	default { exit 2 }
}
