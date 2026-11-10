# rl: put files and URLs on the person's Herdr reading list.
#
#   rl add <path|url> [--note TEXT] [--title TEXT] [--from NAME] [--kind review|fyi|result] [--if-new]
#   rl ls [--unread | --done | --all] [--json]
#   rl done <path|url|id>
#   rl rm <path|url|id>
#
# The Windows rl (PowerShell 7): the same commands, item files and ids as the POSIX rl in
# ../rl. Each item is one JSON file, items\<id>.json, under $env:READING_LIST_DIR (default
# %LOCALAPPDATA%\reading-list). See docs/design.md, section 3. From PowerShell `rl` runs this
# file; rl.cmd (cmd.exe and other programs) and rl (Git Bash) next to it run it with pwsh.

#Requires -Version 7.0
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# The arguments as the caller gave them. Run with `pwsh -File`, PowerShell splits an argument
# such as `-x:1` in $args, so they come from the process's own argv (after `-File <this>`);
# run from a PowerShell prompt or script, $args is what PowerShell bound.
function Get-RlArgs([object[]]$bound) {
	$all = [Environment]::GetCommandLineArgs()
	for ($i = 1; $i -lt $all.Count - 1; $i++) {
		if ($all[$i] -notin @('-File', '-f', '-file')) { continue }
		try {
			$p = [IO.Path]::GetFullPath($all[$i + 1])
		} catch {
			continue
		}
		if ($p -ieq $PSCommandPath) {
			return @{ args = [string[]]@($all | Select-Object -Skip ($i + 2)); process = $true }
		}
	}
	return @{ args = [string[]]@($bound | ForEach-Object { [string]$_ }); process = $false }
}

$script:Call = Get-RlArgs $args
$script:Out = $null
if ($script:Call.process) {
	# A process of its own: UTF-8 and LF on stdout, whatever the console's code page.
	$script:Out = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), [Text.UTF8Encoding]::new($false))
	$script:Out.NewLine = "`n"
	$script:Out.AutoFlush = $true
}

function Say([string]$text) {
	if ($script:Out) { $script:Out.Write($text + "`n") } else { Write-Output $text }
}

function SayRaw([string]$text) {
	if ($script:Out) { $script:Out.Write($text) } else { Write-Output $text.TrimEnd("`n") }
}

$Usage = @'
usage:
  rl add <path|url> [--note TEXT] [--title TEXT] [--from NAME] [--kind review|fyi|result] [--if-new]
  rl ls [--unread | --done | --all] [--json]
  rl done <path|url|id>
  rl rm <path|url|id>

Adding a path or URL that is already on the list replaces its item (unread again, at the
top); with --if-new it leaves that item as it is and only prints its id.

The list lives in $env:READING_LIST_DIR (default %LOCALAPPDATA%\reading-list).
'@

class RlExit : Exception {
	[int]$Code
	RlExit([int]$code) : base("rl exit") { $this.Code = $code }
}

function Die([string]$msg) {
	[Console]::Error.WriteLine("rl: $msg")
	throw [RlExit]::new(1)
}

function Get-ListDir {
	if ($env:READING_LIST_DIR) { return $env:READING_LIST_DIR }
	if (-not $env:LOCALAPPDATA) { Die 'LOCALAPPDATA is not set; set READING_LIST_DIR' }
	return (Join-Path $env:LOCALAPPDATA 'reading-list')
}

# A JSON string literal: quotes, backslashes and control characters escaped, the rest as it
# is (as the POSIX rl writes it).
function Json-Str([string]$s) {
	$b = [Text.StringBuilder]::new('"')
	foreach ($c in $s.ToCharArray()) {
		switch ([int]$c) {
			0x5c { [void]$b.Append('\\'); continue }
			0x22 { [void]$b.Append('\"'); continue }
			0x09 { [void]$b.Append('\t'); continue }
			0x0a { [void]$b.Append('\n'); continue }
			0x0d { [void]$b.Append('\r'); continue }
			default {
				if ([int]$c -lt 32) { [void]$b.Append(('\u{0:x4}' -f [int]$c)) } else { [void]$b.Append($c) }
			}
		}
	}
	[void]$b.Append('"')
	return $b.ToString()
}

# A markdown heading's text as a plain title, as the POSIX rl's plain_title: code spans keep
# their text without the backticks; links and images keep their text; **, __, ~~, * and _
# around words go (an _ inside a word, as in snake_case, stays); \-escapes keep the
# character; spaces collapse.
function Plain-Title([string]$s) {
	$s = $s.Replace('\`', [string][char]0x17)
	# Code spans: a run of backticks up to the same run. Set aside, so nothing inside changes.
	$code = [Collections.Generic.List[string]]::new()
	$t = [Text.StringBuilder]::new()
	while (($m = [regex]::Match($s, '`+')).Success) {
		$tick = $m.Value; $pre = $s.Substring(0, $m.Index); $rest = $s.Substring($m.Index + $m.Length)
		$j = $rest.IndexOf($tick, [StringComparison]::Ordinal)
		if ($j -lt 0) { [void]$t.Append($pre + $tick); $s = $rest; continue }
		$c = $rest.Substring(0, $j)
		if ($c -cmatch '^ .*[^ ].* $') { $c = $c.Substring(1, $c.Length - 2) }
		$code.Add($c)
		[void]$t.Append($pre + [char]1 + $code.Count + [char]2); $s = $rest.Substring($j + $tick.Length)
	}
	$s = $t.ToString() + $s
	$esc = [ordered]@{ '\\' = 0x10; '\*' = 0x11; '\_' = 0x12; '\~' = 0x13; '\[' = 0x14; '\]' = 0x15; '\<' = 0x16 }
	foreach ($k in $esc.Keys) { $s = $s.Replace($k, [string][char]$esc[$k]) }
	$s = $s.Replace('\#', '#')
	# [text](url), [text][ref] and ![alt](url) become their text.
	$out = [Text.StringBuilder]::new()
	while (($i = $s.IndexOf('[')) -ge 0) {
		$rest = $s.Substring($i + 1); $j = $rest.IndexOf(']')
		if ($j -lt 0) { break }
		$text = $rest.Substring(0, $j); $after = $rest.Substring($j + 1); $pre = $s.Substring(0, $i)
		$k = -1
		if ($after.StartsWith('(')) { $k = $after.IndexOf(')') } elseif ($after.StartsWith('[')) { $k = $after.IndexOf(']') }
		if ($k -lt 0) { [void]$out.Append($s.Substring(0, $i + 1)); $s = $rest; continue }
		if ($pre.EndsWith('!')) { $pre = $pre.Substring(0, $pre.Length - 1) }
		[void]$out.Append($pre + $text); $s = $after.Substring($k + 1)
	}
	$s = $out.ToString() + $s
	$s = [regex]::Replace($s, '<([A-Za-z][A-Za-z0-9.+-]*:[^ <>]*)>', '$1')
	foreach ($d in '**', '__', '~~', '*', '_') {
		$e = [regex]::Escape($d); $x = [regex]::Escape($d.Substring(0, 1))
		$out = [Text.StringBuilder]::new()
		while (($m = [regex]::Match($s, "$e[^$x]+$e")).Success) {
			$inner = $m.Value.Substring($d.Length, $m.Length - 2 * $d.Length)
			$before = if ($m.Index -gt 0) { $s.Substring($m.Index - 1, 1) } else { '' }
			$after = if ($m.Index + $m.Length -lt $s.Length) { $s.Substring($m.Index + $m.Length, 1) } else { '' }
			$ok = $inner -notmatch '^[ \t]' -and $inner -notmatch '[ \t]$'
			if ($d[0] -eq '_' -and ($before -cmatch '[A-Za-z0-9]' -or $after -cmatch '[A-Za-z0-9]')) { $ok = $false }
			if ($ok) { [void]$out.Append($s.Substring(0, $m.Index) + $inner); $s = $s.Substring($m.Index + $m.Length) }
			else { [void]$out.Append($s.Substring(0, $m.Index + 1)); $s = $s.Substring($m.Index + 1) }
		}
		$s = $out.ToString() + $s
	}
	for ($n = $code.Count; $n -ge 1; $n--) {
		$p = [string][char]1 + $n + [char]2; $i = $s.IndexOf($p, [StringComparison]::Ordinal)
		if ($i -ge 0) { $s = $s.Substring(0, $i) + $code[$n - 1] + $s.Substring($i + $p.Length) }
	}
	foreach ($k in $esc.Keys) { $s = $s.Replace([string][char]$esc[$k], $k.Substring(1)) }
	$s = $s.Replace([string][char]0x17, '`')
	return ($s -replace '[ \t]+', ' ').Trim(' ')
}

function Sha256-16([string]$s) {
	$h = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($s))
	return ([Convert]::ToHexString($h).ToLowerInvariant()).Substring(0, 16)
}

function Is-Url([string]$s) { return $s -cmatch '^https?://.' }

# The real path of an absolute local path: drive letter upper case, each name as it is on
# disk, and every folder link (symlink or junction) on the way resolved; the last name too
# when $followLeaf. The last name may be missing; every folder above it must exist.
function Get-RealPath([string]$path, [bool]$followLeaf) {
	for ($hops = 0; $hops -le 20; $hops++) {
		$full = [IO.Path]::GetFullPath($path)
		$root = [IO.Path]::GetPathRoot($full)
		if ($root -notmatch '^[A-Za-z]:\\$') { throw "not a path on a local drive: $path" }
		$parts = @($full.Substring($root.Length).Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries))
		$cur = $root.ToUpperInvariant()
		$restart = $null
		$opts = [IO.EnumerationOptions]::new()
		$opts.MatchType = [IO.MatchType]::Simple
		$opts.MatchCasing = [IO.MatchCasing]::CaseInsensitive
		$opts.AttributesToSkip = [IO.FileAttributes]::None
		$opts.IgnoreInaccessible = $true
		# Win32 matching also finds a name by its 8.3 short name (C:\Users\RUNNER~1).
		$short = [IO.EnumerationOptions]::new()
		$short.MatchType = [IO.MatchType]::Win32
		$short.AttributesToSkip = [IO.FileAttributes]::None
		$short.IgnoreInaccessible = $true
		for ($i = 0; $i -lt $parts.Count; $i++) {
			$name = $parts[$i]
			$last = $i -eq $parts.Count - 1
			$entry = $null
			if ([IO.Directory]::Exists($cur)) {
				$entry = [IO.DirectoryInfo]::new($cur).EnumerateFileSystemInfos($name, $opts) | Select-Object -First 1
				if (-not $entry -and $name.Contains('~')) {
					$entry = [IO.DirectoryInfo]::new($cur).EnumerateFileSystemInfos($name, $short) | Select-Object -First 1
				}
			}
			if (-not $entry) {
				if ($last) { return (Join-Path $cur $name) }
				throw "no such folder: $(Join-Path $cur $name)"
			}
			$next = Join-Path $cur $entry.Name
			if ($entry.LinkTarget -and (-not $last -or $followLeaf)) {
				$t = $entry.LinkTarget -replace '^\\\\\?\\', ''
				if (-not [IO.Path]::IsPathRooted($t)) { $t = Join-Path $cur $t }
				$rest = @($parts | Select-Object -Skip ($i + 1))
				$restart = if ($rest.Count) { Join-Path $t ($rest -join '\') } else { $t }
				break
			}
			$cur = $next
		}
		if ($null -eq $restart) { return $cur }
		$path = $restart
	}
	throw "too many links: $path"
}

# The absolute real path for an argument (relative to the current folder): a folder resolved
# entirely, a file's folder resolved and its own name kept.
function Get-AbsPath([string]$p) {
	$here = (Get-Location -PSProvider FileSystem).ProviderPath
	$joined = if ([IO.Path]::IsPathRooted($p) -and $p -match '^[A-Za-z]:') { $p } else { [IO.Path]::Combine($here, $p) }
	try {
		return Get-RealPath $joined ([IO.Directory]::Exists($joined))
	} catch {
		return $null
	}
}

function Now-Iso { return [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") }

# The id for an argument: an id already on the list, else the id of the URL or path.
function Resolve-Id([string]$a) {
	if ($a -cmatch '^[0-9a-f]{16}$' -and [IO.File]::Exists((Join-Path $script:Items "$a.json"))) { return $a }
	if (Is-Url $a) { return (Sha256-16 $a) }
	$p = Get-AbsPath $a
	if (-not $p) { Die "no such file or folder: $a" }
	return (Sha256-16 $p)
}

# The raw JSON text of a scalar member (strings keep their quotes and escapes), or "null".
function Raw-Token($el, [string[]]$names) {
	foreach ($n in $names) {
		if ($el.ValueKind -ne [Text.Json.JsonValueKind]::Object) { return 'null' }
		$found = $null
		foreach ($m in $el.EnumerateObject()) { if ($m.Name -ceq $n) { $found = $m.Value } }
		if ($null -eq $found) { return 'null' }
		$el = $found
	}
	switch ($el.ValueKind) {
		([Text.Json.JsonValueKind]::Object) { return 'null' }
		([Text.Json.JsonValueKind]::Array) { return 'null' }
		default { return $el.GetRawText() }
	}
}

$script:Fields = @('id', 'path', 'url', 'title', 'note', 'kind', 'added_at', 'adds', 'size', 'mtime', 'done_at')
$script:ByFields = @('terminal', 'app', 'name', 'space', 'tab', 'cwd', 'from')

# Writes items\<id>.json atomically, in the POSIX rl's layout (LF, UTF-8, two spaces).
function Write-Item($I, $B) {
	try {
		[void][IO.Directory]::CreateDirectory($script:Items)
	} catch {
		Die "cannot create $($script:Items)"
	}
	$text = @"
{
  "v": 1,
  "id": "$($I.id)",
  "path": $($I.path),
  "url": $($I.url),
  "title": $($I.title),
  "note": $($I.note),
  "kind": "$($I.kind)",
  "added_at": $($I.added_at),
  "adds": $($I.adds),
  "by": {
    "terminal": $($B.terminal),
    "app": $($B.app),
    "name": $($B.name),
    "space": $($B.space),
    "tab": $($B.tab),
    "cwd": $($B.cwd),
    "from": $($B.from)
  },
  "size": $($I.size),
  "mtime": $($I.mtime),
  "done_at": $($I.done_at)
}
"@ -replace "`r`n", "`n"
	$dest = Join-Path $script:Items "$($I.id).json"
	$tmp = Join-Path $script:Items ".$($I.id).$PID.tmp"
	try {
		[IO.File]::WriteAllText($tmp, $text + "`n", [Text.UTF8Encoding]::new($false))
	} catch {
		Die "cannot write $tmp"
	}
	try {
		[IO.File]::Move($tmp, $dest, $true)
	} catch {
		Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
		Die "cannot write $dest"
	}
}

# An item file as the I and B tables of raw tokens.
function Read-Item([string]$file) {
	$doc = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8))
	try {
		$I = @{}
		foreach ($f in $script:Fields) { $I[$f] = Raw-Token $doc.RootElement @($f) }
		$B = @{}
		foreach ($f in $script:ByFields) { $B[$f] = Raw-Token $doc.RootElement @('by', $f) }
	} finally {
		$doc.Dispose()
	}
	$I.id = $I.id.Trim('"')
	$I.kind = $I.kind.Trim('"')
	if ($I.kind -notin @('review', 'fyi', 'result')) { $I.kind = 'review' }
	if ($I.adds -notmatch '^[0-9]+$') { $I.adds = '1' }
	return @{ I = $I; B = $B }
}

# The process that ran rl: the one that started this pwsh (past rl.cmd's cmd.exe or the Git
# Bash shim), or pwsh when rl ran inside PowerShell.
function Get-Caller {
	if (-not $script:Call.process) { return 'pwsh' }
	try {
		$p = (Get-Process -Id $PID).Parent
		if ($env:RL_VIA -and $p) { $p = $p.Parent }
		if ($p) { return $p.ProcessName }
	} catch {
	}
	return 'unknown'
}

# Who is adding: the hc terminal this runs in (docs/design.md 3.3), else --from or
# "<user>@<calling program>".
function Get-Attribution([string]$from) {
	$B = @{}
	foreach ($f in $script:ByFields) { $B[$f] = 'null' }
	$hc = if ($env:HC_TERMINAL_ID) { Get-Command hc -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
	if ($hc) {
		try {
			$si = [Diagnostics.ProcessStartInfo]::new($hc.Source)
			foreach ($a in @('get', $env:HC_TERMINAL_ID, '--json')) { $si.ArgumentList.Add($a) }
			$si.RedirectStandardOutput = $true
			$si.RedirectStandardError = $true
			$si.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
			$si.UseShellExecute = $false
			$p = [Diagnostics.Process]::Start($si)
			$err = $p.StandardError.ReadToEndAsync()
			$out = $p.StandardOutput.ReadToEnd()
			$p.WaitForExit()
			[void]$err.Result
			if ($p.ExitCode -eq 0) {
				$doc = [Text.Json.JsonDocument]::Parse($out)
				try {
					$r = $doc.RootElement
					$B.terminal = Raw-Token $r @('address')
					$B.app = Raw-Token $r @('status', 'app')
					$B.name = Raw-Token $r @('name')
					$B.space = Raw-Token $r @('labels', 'herdr.space')
					$B.tab = Raw-Token $r @('labels', 'herdr.tab')
					$B.cwd = Raw-Token $r @('cwd')
				} finally {
					$doc.Dispose()
				}
			}
		} catch {
			foreach ($f in $script:ByFields) { $B[$f] = 'null' }
		}
	}
	if ($from) {
		$B.from = Json-Str $from
	} elseif ($B.terminal -eq 'null') {
		$user = if ($env:USERNAME) { $env:USERNAME } else { [Environment]::UserName }
		$B.from = Json-Str "$user@$(Get-Caller)"
	}
	return $B
}

function Cmd-Add([string[]]$a) {
	$note = ''; $title = ''; $from = ''; $kind = 'review'; $ifNew = $false; $target = ''
	$i = 0
	$need = { param($opt) if ($i + 1 -ge $a.Count) { Die "$opt needs a value" } }
	while ($i -lt $a.Count) {
		$x = $a[$i]
		switch -CaseSensitive -Regex ($x) {
			'^--note$' { & $need $x; $note = $a[$i + 1]; $i += 2; break }
			'^--note=' { $note = $x.Substring(7); $i++; break }
			'^--title$' { & $need $x; $title = $a[$i + 1]; $i += 2; break }
			'^--title=' { $title = $x.Substring(8); $i++; break }
			'^--from$' { & $need $x; $from = $a[$i + 1]; $i += 2; break }
			'^--from=' { $from = $x.Substring(7); $i++; break }
			'^--kind$' { & $need $x; $kind = $a[$i + 1]; $i += 2; break }
			'^--kind=' { $kind = $x.Substring(7); $i++; break }
			'^--if-new$' { $ifNew = $true; $i++; break }
			'^--$' {
				$i++
				if ($i -lt $a.Count) { $target = $a[$i]; $i++ }
				if ($i -lt $a.Count) { Die 'add takes one path or URL' }
				break
			}
			'^-' { Die "unknown option for add: $x" }
			default {
				if ($target) { Die 'add takes one path or URL' }
				$target = $x; $i++
			}
		}
		if ($x -ceq '--') { break }
	}
	if (-not $target) { Die 'add needs a path or URL' }
	if ($kind -notin @('review', 'fyi', 'result')) { Die '--kind must be review, fyi or result' }

	$I = @{ size = 'null'; mtime = 'null' }
	if (Is-Url $target) {
		$I.id = Sha256-16 $target
		$I.path = 'null'
		$I.url = Json-Str $target
		$defaultTitle = $target.Substring($target.IndexOf('://') + 3)
	} else {
		$real = Get-AbsPath $target
		if (-not $real -or -not (Test-Path -LiteralPath $real)) { Die "no such file or folder: $target" }
		$I.id = Sha256-16 $real
		$I.path = Json-Str $real
		$I.url = 'null'
		$item = Get-Item -LiteralPath $real -Force
		$defaultTitle = if ($real -match '^[A-Za-z]:\\$') { $real } else { $item.Name }
		if (-not $item.PSIsContainer) {
			if ($real -imatch '\.(md|markdown)$') {
				$heading = Get-Content -LiteralPath $real -TotalCount 400 -Encoding utf8 -ErrorAction SilentlyContinue |
					Where-Object { $_ -cmatch '^# ' } | Select-Object -First 1
				if ($heading) {
					$h = ($heading -replace "`r", '') -replace '^# *', '' -replace ' *#* *$', ''
					if ($h) { $h = Plain-Title $h }
					if ($h) { $defaultTitle = $h }
				}
			}
			$I.size = [string]$item.Length
		}
		$I.mtime = '"' + $item.LastWriteTimeUtc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") + '"'
	}

	$file = Join-Path $script:Items "$($I.id).json"
	if ($ifNew -and [IO.File]::Exists($file)) {
		Say $I.id
		return
	}
	$I.adds = '1'
	if ([IO.File]::Exists($file)) {
		try {
			$old = (Read-Item $file).I.adds
			$I.adds = [string]([long]$old + 1)
		} catch {
		}
	}
	$I.title = Json-Str $(if ($title) { $title } else { $defaultTitle })
	$I.note = if ($note) { Json-Str $note } else { 'null' }
	$I.kind = $kind
	$I.added_at = '"' + (Now-Iso) + '"'
	$I.done_at = 'null'
	$B = Get-Attribution $from
	Write-Item $I $B
	Say $I.id
}

function Cmd-Done([string[]]$a) {
	if ($a.Count -ne 1) { Die 'done takes one path, URL or id' }
	$id = Resolve-Id $a[0]
	$file = Join-Path $script:Items "$id.json"
	if (-not [IO.File]::Exists($file)) { Die "not on the list: $($a[0])" }
	try {
		$it = Read-Item $file
	} catch {
		Die "cannot read $file"
	}
	$it.I.id = $id
	$it.I.done_at = '"' + (Now-Iso) + '"'
	Write-Item $it.I $it.B
	Say $id
}

function Cmd-Rm([string[]]$a) {
	if ($a.Count -ne 1) { Die 'rm takes one path, URL or id' }
	$id = Resolve-Id $a[0]
	$file = Join-Path $script:Items "$id.json"
	if (-not [IO.File]::Exists($file)) { Die "not on the list: $($a[0])" }
	try {
		[IO.File]::Delete($file)
	} catch {
		Die "cannot remove $file"
	}
	Say $id
}

# A string member, or "" (null, missing or not a string).
function Str-Of($el, [string[]]$names) {
	foreach ($n in $names) {
		if ($el.ValueKind -ne [Text.Json.JsonValueKind]::Object) { return '' }
		$found = $null
		foreach ($m in $el.EnumerateObject()) { if ($m.Name -ceq $n) { $found = $m.Value } }
		if ($null -eq $found) { return '' }
		$el = $found
	}
	if ($el.ValueKind -ne [Text.Json.JsonValueKind]::String) { return '' }
	return $el.GetString()
}

function Ts([string]$t) { if ($t.Length -gt 19) { return $t.Substring(0, 19) } return $t }

# Read and done state, as the mod defines it (docs/design.md 4.3); see the POSIX rl.
function Cmd-Ls([string[]]$a) {
	$filter = 'open'; $json = $false
	foreach ($x in $a) {
		switch -CaseSensitive ($x) {
			'--unread' { $filter = 'unread' }
			'--done' { $filter = 'done' }
			'--all' { $filter = 'all' }
			'--json' { $json = $true }
			default { Die "unknown option for ls: $x" }
		}
	}
	$files = @()
	if ([IO.Directory]::Exists($script:Items)) {
		$files = @([IO.Directory]::GetFiles($script:Items, '*.json') | Where-Object { -not ([IO.Path]::GetFileName($_)).StartsWith('.') } | Sort-Object -Culture '' -CaseSensitive)
		[Array]::Sort($files, [StringComparer]::Ordinal)
	}
	if ($files.Count -eq 0) {
		if ($json) { Say '[]' }
		return
	}
	$state = $null
	if ([IO.File]::Exists($script:State)) {
		try { $state = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($script:State, [Text.Encoding]::UTF8)) } catch { $state = $null }
	}
	$shown = [Collections.Generic.List[object]]::new()
	foreach ($f in $files) {
		try {
			$text = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)
			$doc = [Text.Json.JsonDocument]::Parse($text)
		} catch {
			continue
		}
		try {
			$r = $doc.RootElement
			$id = Str-Of $r @('id')
			$added = Ts (Str-Of $r @('added_at'))
			$st = if ($state) { $state.RootElement } else { $null }
			$rd = if ($st) { Ts (Str-Of $st @('items', $id, 'read_at')) } else { '' }
			$d1 = Ts (Str-Of $r @('done_at'))
			$d2 = if ($st) { Ts (Str-Of $st @('items', $id, 'done_at')) } else { '' }
			$done = if ([string]::CompareOrdinal($d1, $d2) -gt 0) { $d1 } else { $d2 }
			$undone = if ($st) { Ts (Str-Of $st @('items', $id, 'undone_at')) } else { '' }
			$isRead = $rd -ne '' -and [string]::CompareOrdinal($rd, $added) -ge 0
			$isDone = $done -ne '' -and [string]::CompareOrdinal($done, $added) -ge 0 -and [string]::CompareOrdinal($done, $undone) -ge 0
			$show = $filter -eq 'all' -or ($filter -eq 'done' -and $isDone) -or ($filter -eq 'open' -and -not $isDone) -or ($filter -eq 'unread' -and -not $isDone -and -not $isRead)
			if (-not $show) { continue }
			if ($json) {
				$shown.Add($text)
			} else {
				$flat = { param($s) $s -replace "[`r`n`t]", ' ' }
				$where = Str-Of $r @('path')
				if (-not $where) { $where = Str-Of $r @('url') }
				$status = if ($isDone) { 'done' } elseif ($isRead) { 'read' } else { 'unread' }
				Say ('{0}  {1,-6}  {2,-6}  {3}  {4}' -f $id, $status, (Str-Of $r @('kind')), (& $flat (Str-Of $r @('title'))), (& $flat $where))
			}
		} finally {
			$doc.Dispose()
		}
	}
	if ($state) { $state.Dispose() }
	if ($json) {
		$b = [Text.StringBuilder]::new('[')
		for ($k = 0; $k -lt $shown.Count; $k++) {
			if ($k -gt 0) { [void]$b.Append(',') }
			[void]$b.Append("`n").Append($shown[$k])
		}
		[void]$b.Append("]`n")
		SayRaw $b.ToString()
	}
}

$code = 0
try {
	$a = $script:Call.args
	if ($a.Count -lt 1) {
		[Console]::Error.WriteLine($Usage)
		throw [RlExit]::new(2)
	}
	$script:Dir = Get-ListDir
	$script:Items = Join-Path $script:Dir 'items'
	$script:State = Join-Path $script:Dir 'state.json'
	$rest = [string[]]@($a | Select-Object -Skip 1)
	switch -CaseSensitive ($a[0]) {
		'add' { Cmd-Add $rest }
		{ $_ -in @('ls', 'list') } { Cmd-Ls $rest }
		'done' { Cmd-Done $rest }
		{ $_ -in @('rm', 'remove') } { Cmd-Rm $rest }
		{ $_ -in @('-h', '--help', 'help') } { Say $Usage }
		default {
			[Console]::Error.WriteLine($Usage)
			throw [RlExit]::new(2)
		}
	}
} catch [RlExit] {
	$code = $_.Exception.Code
} catch {
	[Console]::Error.WriteLine("rl: $($_.Exception.Message)")
	$code = 1
}
exit $code
