# The reading list's helpers on Windows: what the mod runs through `sh -c` scripts on macOS
# and Linux (core/*.js *_SCRIPT), as operations of one PowerShell 7 script. The mod runs
#   pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File readlist.ps1 OP [ARG...]
# with every argument its own argv entry (core/windows.js); no argument is ever read as code.
# Output is UTF-8 with LF line ends, in the same shapes the scripts print, so the same parsers
# read it. Each operation names the script it stands for.

#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

# A line every copy of rl carries (core/install.js MARK).
$MARK = "rl: put files and URLs on the person's Herdr reading list."
# The files of the Windows rl, installed together.
$RL_FILES = @('rl.ps1', 'rl.cmd', 'rl')

function Fail([string]$why, [int]$code = 1) {
	Warn $why
	exit $code
}

# `k mtime` (STATS_SCRIPT) or `k mtime size` (STAT1_SCRIPT) for a path, or `-`. Folders are
# d, files f: Windows has no execute bit (core/items.js openAction reveals files that run by
# their type).
function Stat-Line([string]$p, [bool]$size) {
	if (-not (Test-LocalPath $p)) { return '-' }
	try {
		if ([IO.Directory]::Exists($p)) {
			$i = [IO.DirectoryInfo]::new($p)
			return $(if ($size) { "d $(Get-Mtime $i) 0" } else { "d $(Get-Mtime $i)" })
		}
		if ([IO.File]::Exists($p)) {
			$i = [IO.FileInfo]::new($p)
			return $(if ($size) { "f $(Get-Mtime $i) $($i.Length)" } else { "f $(Get-Mtime $i)" })
		}
	} catch {
	}
	return '-'
}

# The folder's entries that are not hidden: names not starting with ".", without the Hidden or
# System attribute (desktop.ini).
function Get-Visible([string]$dir) {
	if (-not [IO.Directory]::Exists($dir)) { return @() }
	$skip = [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System
	return @([IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos() | Where-Object { -not $_.Name.StartsWith('.') -and -not ($_.Attributes -band $skip) })
}

function Remove-Quietly([string]$p) {
	try {
		if ([IO.Directory]::Exists($p)) { [IO.Directory]::Delete($p, $true) }
		elseif ([IO.File]::Exists($p)) { [IO.File]::Delete($p) }
	} catch {
	}
}

# Runs rl.ps1 ($rl) in this process with these arguments: its ids go to stdout, its errors to
# stderr. Returns its exit status.
function Invoke-Rl([string]$rl, [string[]]$argv) {
	$global:LASTEXITCODE = 0
	$out = & $rl @argv
	foreach ($l in @($out)) { if ($null -ne $l) { Say ([string]$l) } }
	return $LASTEXITCODE
}

# ~ for the person's profile folder in what the toasts show.
function Tilde([string]$p) {
	$h = $env:USERPROFILE
	if ($h -and $p -and $p.StartsWith($h + '\', [StringComparison]::OrdinalIgnoreCase)) { return '~' + $p.Substring($h.Length) }
	return $p
}

function Test-Ours([string]$p) {
	try {
		return [IO.File]::Exists($p) -and ([IO.File]::ReadAllText($p)).Contains($MARK)
	} catch {
		return $false
	}
}

# The folder rl is installed in: ~\.local\bin, as on macOS and Linux.
function Get-RlBin { return [IO.Path]::Join($env:USERPROFILE, '.local', 'bin') }

# The person's own PATH (HKCU\Environment), unexpanded, and its registry type. With
# READLIST_TEST_USER_PATH_FILE (the tests) it is that file instead, so a test never changes
# the real PATH.
function Get-UserPath {
	$f = $env:READLIST_TEST_USER_PATH_FILE
	if ($f) {
		$t = if ([IO.File]::Exists($f)) { [IO.File]::ReadAllText($f) } else { '' }
		return @{ value = $t.Trim(); kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
	}
	$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
	try {
		if (-not $k -or $null -eq $k.GetValue('Path')) { return @{ value = ''; kind = [Microsoft.Win32.RegistryValueKind]::ExpandString } }
		return @{ value = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); kind = $k.GetValueKind('Path') }
	} finally {
		if ($k) { $k.Dispose() }
	}
}

function Set-UserPath([string]$value, $kind) {
	$f = $env:READLIST_TEST_USER_PATH_FILE
	if ($f) {
		[IO.File]::WriteAllText($f, $value)
		return
	}
	$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
	try {
		$k.SetValue('Path', $value, $(if ($kind -eq [Microsoft.Win32.RegistryValueKind]::String) { $kind } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }))
	} finally {
		$k.Dispose()
	}
	# Tell running programs (Explorer, and what it starts next) that the environment changed.
	try {
		Add-Type -Namespace ReadingList -Name Env -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
		$r = [UIntPtr]::Zero
		[void][ReadingList.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
	} catch {
	}
}

# PATH entries, expanded, without trailing separators.
function Split-Path-List([string]$v) {
	return @($v -split ';' | Where-Object { $_.Trim() } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_.Trim()).TrimEnd('\') })
}

# PATH as a program started now would get it: the machine's and the person's, read again (the
# app's own PATH is from when it started).
function Get-FreshPath {
	$m = ''
	try { $m = [Environment]::GetEnvironmentVariable('Path', 'Machine') } catch {}
	return ((Split-Path-List $m) + (Split-Path-List (Get-UserPath).value)) -join ';'
}

# The rl a PowerShell prompt would run with PATH $path (a script or a program), or $null.
function Find-Rl([string]$path) {
	$was = $env:Path
	try {
		$env:Path = $path
		$c = Get-Command rl -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($c) { return $c.Source }
		return $null
	} finally {
		$env:Path = $was
	}
}

function Test-OnPath([string]$dir, [string]$path) {
	return @(Split-Path-List $path | Where-Object { $_ -ieq $dir.TrimEnd('\') }).Count -gt 0
}

# RL_STATUS_SCRIPT: `state<TAB>path` (ok, other, offpath, missing).
function Get-RlStatus {
	$bin = Get-RlBin
	$fresh = Get-FreshPath
	$first = Find-Rl $fresh
	if ($first -and (Test-Ours $first)) { return "ok`t$(Tilde $first)" }
	if ($first) { return "other`t$(Tilde $first)" }
	$mine = [IO.Path]::Join($bin, 'rl.ps1')
	if (Test-Ours $mine) { return "offpath`t$(Tilde $mine)" }
	return "missing`t"
}

# INSTALL_RL_SCRIPT: copies rl.ps1, rl.cmd and rl from $src to ~\.local\bin, never over another
# program or a link, and puts that folder on the person's PATH when it is not. One line
# `result<TAB>~\.local\bin\rl.ps1<TAB>on PATH (1 or 0)<TAB>the rl PATH finds first<TAB>1 when it
# added the folder to PATH`.
function Install-Rl([string]$src) {
	$bin = Get-RlBin
	$dest = [IO.Path]::Join($bin, 'rl.ps1')
	foreach ($f in $RL_FILES) {
		if (-not [IO.File]::Exists([IO.Path]::Join($src, $f))) { return "error`tthe mod's rl is missing: $([IO.Path]::Join($src, $f))" }
	}
	$result = 'installed'
	$changes = @()
	foreach ($f in $RL_FILES) {
		$s = [IO.Path]::Join($src, $f)
		$d = [IO.Path]::Join($bin, $f)
		$i = Get-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue
		if (-not $i) {
			$changes += $f
			continue
		}
		if ($i.LinkTarget) {
			if ($result -ne 'other') { $result = 'link' }
			continue
		}
		if ([IO.File]::Exists($d) -and (Get-FileHash -LiteralPath $s).Hash -eq (Get-FileHash -LiteralPath $d).Hash) { continue }
		if (Test-Ours $d) {
			$changes += $f
			if ($result -eq 'installed') { $result = 'updated' }
		} else {
			$result = 'other'
		}
	}
	if ($result -eq 'installed' -and $changes.Count -lt $RL_FILES.Count) { $result = if ($changes.Count) { 'updated' } else { 'same' } }
	if ($result -in @('installed', 'updated')) {
		try {
			[void][IO.Directory]::CreateDirectory($bin)
			foreach ($f in $changes) {
				$tmp = [IO.Path]::Join($bin, ".$f.$PID.tmp")
				[IO.File]::Copy([IO.Path]::Join($src, $f), $tmp, $true)
				[IO.File]::Move($tmp, [IO.Path]::Join($bin, $f), $true)
			}
		} catch {
			foreach ($f in $changes) { Remove-Quietly ([IO.Path]::Join($bin, ".$f.$PID.tmp")) }
			return "error`tcould not write $(Tilde $bin)"
		}
	}
	$added = 0
	if ($result -in @('installed', 'updated', 'same')) {
		$u = Get-UserPath
		$fresh = Get-FreshPath
		if (-not (Test-OnPath $bin $fresh)) {
			$entry = '%USERPROFILE%\.local\bin'
			$value = if ($u.value) { $u.value.TrimEnd(';') + ';' + $entry } else { $entry }
			try {
				Set-UserPath $value $u.kind
				$added = 1
			} catch {
			}
		}
	}
	$fresh = Get-FreshPath
	$on = if (Test-OnPath $bin $fresh) { 1 } else { 0 }
	$first = Find-Rl $fresh
	return "$result`t$(Tilde $dest)`t$on`t$(if ($first) { Tilde $first } else { '' })`t$added"
}

# CACHE_SCRIPT: puts an image for $src at $out (inside the cache folder $dir) and removes the
# item's older images ($id). $how is "copy", or the thumbnail size; then the seconds the
# handler may take and the handler to ask (core/handlers.js chain: its command and args), run
# as `... path SRC thumbnail SIZE OUT` with OUT in a fresh folder of its own. Exits 10 when
# the handler did not handle it.
function Make-Image([string[]]$a) {
	if ($a.Count -lt 5) { exit 2 }
	$src, $dir, $out, $id, $how = $a[0..4]
	try {
		[void][IO.Directory]::CreateDirectory($dir)
		$t = [IO.Path]::Join($dir, ".make.$([Guid]::NewGuid().ToString('N').Substring(0, 8))")
		[void][IO.Directory]::CreateDirectory($t)
	} catch {
		Fail "cannot make $dir"
	}
	$s = 0
	$errFile = [IO.Path]::Join($t, 'err')
	try {
		if ([IO.File]::Exists($out)) {
		} elseif ($how -ceq 'copy') {
			[IO.File]::Copy($src, [IO.Path]::Join($t, 'copy'), $true)
			[IO.File]::Move([IO.Path]::Join($t, 'copy'), $out, $true)
		} else {
			if ($a.Count -lt 7) { exit 2 }
			$seconds = [int]$a[5]
			$cmd = $a[6]
			$h = [IO.Path]::Join($t, 'h')
			[void][IO.Directory]::CreateDirectory($h)
			$thumb = [IO.Path]::Join($h, 'thumb.png')
			$argv = [string[]](@($a | Select-Object -Skip 7) + @('path', $src, 'thumbnail', $how, $thumb))
			$err = [IO.File]::Create($errFile)
			try {
				$s = Invoke-Bounded $cmd $argv $seconds ([IO.Stream]::Null) $err
			} finally {
				$err.Dispose()
			}
			if ($s -eq 0) {
				if ([IO.File]::Exists($thumb)) { [IO.File]::Move($thumb, $out, $true) }
			} elseif ($s -eq 10) {
				Remove-Quietly $t
				exit 10
			} elseif ($s -eq -1 -and -not (([IO.FileInfo]::new($errFile)).Length)) {
				[IO.File]::WriteAllText($errFile, "the handler took over $seconds s`n")
			}
		}
	} catch {
		Warn $_.Exception.Message
		Remove-Quietly $t
		exit 1
	}
	if (-not [IO.File]::Exists($out)) {
		if ([IO.File]::Exists($errFile) -and ([IO.FileInfo]::new($errFile)).Length) {
			Warn ([IO.File]::ReadAllText($errFile).TrimEnd())
		} else {
			Warn 'the handler made no thumbnail'
		}
		Remove-Quietly $t
		exit $(if ($s -eq 0 -or $s -eq -1) { 1 } else { $s })
	}
	Remove-Quietly $t
	foreach ($f in [IO.Directory]::GetFiles($dir, "$id-*")) { if ($f -ne $out) { Remove-Quietly $f } }
	exit 0
}

# SCAN_SCRIPT (core/sent.js): $cfg (or "" for $env:CLAUDE_CONFIG_DIR, else ~\.claude), the most
# characters a line may have, then triples of terminal address, foreground pid and the
# transcript's last signature.
function Scan-Sent([string[]]$a) {
	if ($a.Count -lt 2) { exit 2 }
	$cfg = if ($a[0]) { $a[0] } elseif ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { [IO.Path]::Join($env:USERPROFILE, '.claude') }
	$max = [int]$a[1]
	$kids = $null
	for ($i = 2; $i + 2 -lt $a.Count; $i += 3) {
		$addr, $p, $known = $a[$i], $a[$i + 1], $a[$i + 2]
		if ($p -notmatch '^[0-9]+$') { continue }
		if ($null -eq $kids) {
			$kids = @{}
			foreach ($proc in @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue)) {
				$pp = [string]$proc.ParentProcessId
				if (-not $kids.ContainsKey($pp)) { $kids[$pp] = [Collections.Generic.List[string]]::new() }
				$kids[$pp].Add([string]$proc.ProcessId)
			}
		}
		$c1 = if ($kids.ContainsKey($p)) { @($kids[$p]) } else { @() }
		$c2 = @($c1 | ForEach-Object { if ($kids.ContainsKey($_)) { $kids[$_] } })
		$s = $null
		foreach ($q in @($p) + $c1 + $c2) {
			$f = [IO.Path]::Join($cfg, 'sessions', "$q.json")
			if ([IO.File]::Exists($f)) {
				$s = $f
				break
			}
		}
		if (-not $s) { continue }
		$m = [regex]::Match([IO.File]::ReadAllText($s), '"sessionId"\s*:\s*"([0-9A-Za-z_-]*)"')
		if (-not $m.Success -or -not $m.Groups[1].Value) { continue }
		$sid = $m.Groups[1].Value
		$t = $null
		$projects = [IO.Path]::Join($cfg, 'projects')
		if ([IO.Directory]::Exists($projects)) {
			foreach ($d in [IO.Directory]::GetDirectories($projects)) {
				$f = [IO.Path]::Join($d, "$sid.jsonl")
				if ([IO.File]::Exists($f)) {
					$t = $f
					break
				}
			}
		}
		if (-not $t) { continue }
		$fi = [IO.FileInfo]::new($t)
		$sig = "$($fi.Length):$(Get-Mtime $fi)"
		if ($sig -eq $known) {
			Put "`u{1e}$addr`t$sid`t$t`t$sig`t1`n"
			continue
		}
		Put "`u{1e}$addr`t$sid`t$t`t$sig`t0`n"
		try {
			$r = [IO.StreamReader]::new($t, [Text.Encoding]::UTF8)
			try {
				while ($null -ne ($line = $r.ReadLine())) {
					if ($line.Length -lt $max -and $line.Contains('file_uuid')) { Put ($line + "`n") }
				}
			} finally {
				$r.Dispose()
			}
		} catch {
		}
	}
}

# The fetch scripts' shared tail (core/remote.js FINISH): checks the part file has $size
# bytes, moves it to $out and writes $meta.
function Finish-Copy([string]$t, [string]$out, [long]$size, [string]$mtime, [string]$meta) {
	$n = ([IO.FileInfo]::new($t)).Length
	if ($n -ne $size) {
		Remove-Quietly $t
		Fail "got $n of $size bytes"
	}
	[IO.File]::Move($t, $out, $true)
	$at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
	$mt = "$meta.$PID"
	[IO.File]::WriteAllText($mt, "{`"mtime`":$mtime,`"size`":$size,`"at`":$($at)000}`n")
	[IO.File]::Move($mt, $meta, $true)
}

$argv = Get-RawArgs $PSCommandPath $args
$op = if ($argv.Count) { $argv[0] } else { '' }
$a = [string[]]@($argv | Select-Object -Skip 1)
switch -CaseSensitive ($op) {
	# DIR_SCRIPT: makes the list folder (and items\, inbox\) and prints its real path.
	'dir' {
		$d = if ($env:READING_LIST_DIR) { $env:READING_LIST_DIR } elseif ($env:LOCALAPPDATA) { [IO.Path]::Join($env:LOCALAPPDATA, 'reading-list') } else { Fail 'LOCALAPPDATA is not set; set READING_LIST_DIR' }
		try {
			$d = [IO.Path]::GetFullPath($d)
			foreach ($s in @('items', 'inbox')) { [void][IO.Directory]::CreateDirectory([IO.Path]::Join($d, $s)) }
			Say (Get-RealPath $d $true)
		} catch {
			Fail "cannot create the reading-list folder $d"
		}
	}
	# LIST_SCRIPT: each item file's text after a \x1e.
	'list' {
		if ($a.Count -ne 1) { exit 2 }
		if (-not [IO.Directory]::Exists($a[0])) { exit 0 }
		$files = [IO.Directory]::GetFiles($a[0], '*.json')
		[Array]::Sort($files, [StringComparer]::Ordinal)
		foreach ($f in $files) {
			if ([IO.Path]::GetFileName($f).StartsWith('.')) { continue }
			try {
				$b = [IO.File]::ReadAllBytes($f)
			} catch {
				continue
			}
			$script:Stdout.WriteByte(0x1e)
			$script:Stdout.Write($b, 0, $b.Length)
		}
	}
	# STAT_SCRIPT, STATS_SCRIPT and STAT1_SCRIPT.
	'stat' { foreach ($p in $a) { Say (Stat-Line $p $false).Substring(0, 1) } }
	'stats' { foreach ($p in $a) { Say (Stat-Line $p $false) } }
	'stat1' {
		if ($a.Count -ne 1) { exit 2 }
		Say (Stat-Line $a[0] $true)
	}
	# HEAD_SCRIPT: the first $a[1] bytes of the file $a[0].
	'head' {
		if ($a.Count -ne 2 -or -not (Test-LocalPath $a[0])) { exit 2 }
		try {
			$s = [IO.File]::OpenRead($a[0])
		} catch {
			Fail "cannot read $($a[0])"
		}
		try {
			$buf = [byte[]]::new([int]$a[1])
			$n = 0
			while ($n -lt $buf.Length) {
				$k = $s.Read($buf, $n, $buf.Length - $n)
				if ($k -le 0) { break }
				$n += $k
			}
			$script:Stdout.Write($buf, 0, $n)
		} finally {
			$s.Dispose()
		}
	}
	# LIST_DIR_SCRIPT: the folder's entries (hidden ones too), folders with a trailing /, at
	# most $a[1] + 1.
	'listdir' {
		if ($a.Count -ne 2 -or -not (Test-LocalPath $a[0])) { exit 2 }
		try {
			$all = @([IO.DirectoryInfo]::new($a[0]).GetFileSystemInfos() | Sort-Object Name)
		} catch {
			Fail "cannot list $($a[0])"
		}
		foreach ($e in @($all | Select-Object -First ([int]$a[1] + 1))) {
			Say $(if ($e -is [IO.DirectoryInfo]) { "$($e.Name)/" } else { $e.Name })
		}
	}
	'cache' { Make-Image $a }
	# PRUNE_SCRIPT: removes cached images of items no longer listed ($a[1..]: the ids kept).
	'prune' {
		if ($a.Count -lt 1 -or -not [IO.Directory]::Exists($a[0])) { exit 0 }
		$keep = @($a | Select-Object -Skip 1)
		foreach ($f in [IO.Directory]::GetFiles($a[0])) {
			$n = [IO.Path]::GetFileName($f)
			if (-not @($keep | Where-Object { $n.StartsWith("$_-", [StringComparison]::Ordinal) }).Count) { Remove-Quietly $f }
		}
	}
	# PRUNE_COPIES_SCRIPT: removes the copies of items no longer listed.
	'prune-copies' {
		if ($a.Count -lt 1 -or -not [IO.Directory]::Exists($a[0])) { exit 0 }
		$keep = @($a | Select-Object -Skip 1)
		foreach ($d in [IO.Directory]::GetDirectories($a[0])) {
			if ([IO.Path]::GetFileName($d) -notin $keep) { Remove-Quietly $d }
		}
	}
	# INBOX_SCRIPT: `mtime<TAB>name` and a NUL for each entry that is not hidden.
	'inbox' {
		if ($a.Count -ne 1) { exit 2 }
		foreach ($e in Get-Visible $a[0]) {
			if (-not $e.Exists) { continue }
			Put "$(Get-Mtime $e)`t$($e.Name)`0"
		}
	}
	# ADD_SCRIPT: rl add --from $a[1] on each further argument, with the rl.ps1 at $a[0].
	'add' {
		if ($a.Count -lt 2) { exit 2 }
		$rl, $from = $a[0], $a[1]
		if (-not [IO.File]::Exists($rl)) { Fail "the mod's rl is missing: $rl" 127 }
		$env:HC_TERMINAL_ID = $null
		$st = 0
		foreach ($p in @($a | Select-Object -Skip 2)) {
			if ((Invoke-Rl $rl @('add', '--from', $from, '--', $p)) -ne 0) { $st = 1 }
		}
		exit $st
	}
	# SENT_ADD_SCRIPT: with the rl.ps1 at $a[0], for each four arguments (terminal address,
	# --from fallback, note, path), rl add --if-new --kind result of a path that is there.
	'sent-add' {
		if ($a.Count -lt 1) { exit 2 }
		$rl = $a[0]
		if (-not [IO.File]::Exists($rl)) { Fail "the mod's rl is missing: $rl" 127 }
		$st = 0
		for ($i = 1; $i + 3 -lt $a.Count; $i += 4) {
			if (-not (Test-Path -LiteralPath $a[$i + 3])) { continue }
			$env:HC_TERMINAL_ID = $a[$i]
			if ((Invoke-Rl $rl @('add', '--if-new', '--kind', 'result', '--from', $a[$i + 1], '--note', $a[$i + 2], '--', $a[$i + 3])) -ne 0) { $st = 1 }
		}
		exit $st
	}
	'scan' { Scan-Sent $a }
	'rl-status' { Say (Get-RlStatus) }
	'install-rl' {
		if ($a.Count -ne 1) { exit 2 }
		Say (Install-Rl $a[0])
	}
	# DECODE_SCRIPT: the base64 text in $a[0] decoded into $a[1], checked to have $a[2] bytes;
	# the meta ($a[3] mtime) in $a[4]. Removes $a[0].
	'decode' {
		if ($a.Count -ne 5) { exit 2 }
		$in, $out, $size, $mtime, $meta = $a
		$t = "$out.part.$PID"
		try {
			[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($out))
			$text = [IO.File]::ReadAllText($in) -replace '\s', ''
			[IO.File]::WriteAllBytes($t, [Convert]::FromBase64String($text))
		} catch {
			Remove-Quietly $t
			Remove-Quietly $in
			Fail 'could not decode the copy'
		}
		Remove-Quietly $in
		Finish-Copy $t $out ([long]$size) $mtime $meta
	}
	# CHUNKS_SCRIPT: $a[0] machine, $a[1] its path, $a[2] the copy, $a[3] size, $a[4] mtime,
	# $a[5] meta, $a[6] ssh target or "", $a[7] MiB per chunk. hc exec, else scp.
	'chunks' {
		if ($a.Count -ne 8) { exit 2 }
		$m, $src, $out, $size, $mtime, $meta, $target, $mib = $a
		$t = "$out.part.$PID"
		[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($out))
		$ok = $true
		$hc = (Get-Command hc -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
		$fs = [IO.File]::Create($t)
		try {
			if (-not $hc) { $ok = $false }
			for ($i = 0; $ok -and [long]$i * 1048576 -lt [long]$size; $i += [int]$mib) {
				$argv = @('exec', '--on', $m, '--timeout', '600', '--', 'sh', '-c', "dd if=`"`$1`" bs=1048576 skip=`"`$2`" count=$mib 2>/dev/null", 'rl', $src, [string]$i)
				if ((Invoke-Bounded $hc.Source $argv 620 $fs ([IO.Stream]::Null)) -ne 0) { $ok = $false }
			}
		} finally {
			$fs.Dispose()
		}
		if ($ok -and ([IO.FileInfo]::new($t)).Length -eq [long]$size) {
		} elseif ($target -and (Get-Command scp -CommandType Application -ErrorAction SilentlyContinue) -and
			(Invoke-Bounded (Get-Command scp -CommandType Application | Select-Object -First 1).Source @('-q', '-o', 'BatchMode=yes', '--', "$($target):$src", $t) 600 ([IO.Stream]::Null) ([IO.Stream]::Null)) -eq 0) {
		} else {
			Remove-Quietly $t
			Fail "could not fetch it from $m"
		}
		Finish-Copy $t $out ([long]$size) $mtime $meta
	}
	'mkdir' {
		if ($a.Count -ne 1) { exit 2 }
		try {
			[void][IO.Directory]::CreateDirectory($a[0])
		} catch {
			Fail "cannot make $($a[0])"
		}
	}
	# Shift-D: removes items\<16 hex>.json under a list folder, nothing else.
	'rm-item' {
		if ($a.Count -ne 1 -or $a[0] -notmatch '\\items\\[0-9a-f]{16}\.json$') { Fail "not a list item: $($a[0])" 2 }
		try {
			[IO.File]::Delete($a[0])
		} catch {
			Fail "cannot remove $($a[0])"
		}
	}
	default { Fail "unknown operation: $op" 2 }
}
exit 0
