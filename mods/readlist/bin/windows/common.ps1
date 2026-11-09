# Shared by the mod's Windows scripts (readlist.ps1, run-handler.ps1), dot-sourced. The
# installed rl.ps1 keeps its own copy of Get-RealPath, as it runs without the mod.

#Requires -Version 7.0
Set-StrictMode -Version 3.0

# The arguments as the mod gave them: pwsh -File splits an argument such as `-x:1` in $args,
# so they come from the process's own argv, after `-File <script>`.
function Get-RawArgs([string]$script, [object[]]$bound) {
	$all = [Environment]::GetCommandLineArgs()
	for ($i = 1; $i -lt $all.Count - 1; $i++) {
		if ($all[$i] -notin @('-File', '-f', '-file')) { continue }
		try {
			$p = [IO.Path]::GetFullPath($all[$i + 1])
		} catch {
			continue
		}
		if ($p -ieq $script) { return , [string[]]@($all | Select-Object -Skip ($i + 2)) }
	}
	return , [string[]]@($bound | ForEach-Object { [string]$_ })
}

# stdout and stderr as UTF-8 with LF, whatever the console's code page.
$script:Stdout = [IO.Stream]([Console]::OpenStandardOutput())
$script:Out = [IO.StreamWriter]::new($script:Stdout, [Text.UTF8Encoding]::new($false))
$script:Out.NewLine = "`n"
$script:Out.AutoFlush = $true
$script:Err = [IO.StreamWriter]::new([Console]::OpenStandardError(), [Text.UTF8Encoding]::new($false))
$script:Err.NewLine = "`n"
$script:Err.AutoFlush = $true

function Say([string]$text) { $script:Out.Write($text + "`n") }
function Put([string]$text) { $script:Out.Write($text) }
function Warn([string]$text) { $script:Err.Write($text + "`n") }

# An absolute path on a local drive (C:\...), the only kind the Windows scripts touch: not
# relative, not a network (\\server) or device (\\?\) path, not a POSIX path from another
# machine's item.
function Test-LocalPath([string]$p) {
	return $p -match '^[A-Za-z]:[\\/]' -and $p -notmatch '[\x00-\x1f"<>|?*]' -and $p.IndexOf(':', 2) -lt 0
}

# The real path of an absolute local path: the drive letter upper case, each name as it is on
# disk, and every link (symlink or junction) on the way resolved, the last name's too when
# $followLeaf. The last name may be missing; every folder above it must exist. With $folders
# (a list), adds each folder that held a link that was followed.
function Get-RealPath([string]$path, [bool]$followLeaf, $folders = $null) {
	for ($hops = 0; $hops -le 20; $hops++) {
		$full = [IO.Path]::GetFullPath($path)
		$root = [IO.Path]::GetPathRoot($full)
		if ($root -notmatch '^[A-Za-z]:\\$') { throw "$path is not on a local drive" }
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
				if ($last) { return [IO.Path]::Join($cur, $name) }
				throw "the folder $([IO.Path]::Join($cur, $name)) is gone"
			}
			if ($entry.LinkTarget -and (-not $last -or $followLeaf)) {
				if ($null -ne $folders) { $folders.Add($cur) }
				$t = $entry.LinkTarget -replace '^\\\\\?\\', '' -replace '^\\\?\?\\', ''
				if (-not [IO.Path]::IsPathRooted($t)) { $t = [IO.Path]::Join($cur, $t) }
				$rest = @($parts | Select-Object -Skip ($i + 1))
				$restart = if ($rest.Count) { [IO.Path]::Join($t, ($rest -join '\')) } else { $t }
				break
			}
			$cur = [IO.Path]::Join($cur, $entry.Name)
		}
		if ($null -eq $restart) { return $cur }
		$path = $restart
	}
	throw "$path is a loop of links"
}

# The item a handler gets for an absolute local path: its folders resolved, its own name kept
# (a drive's root as it is).
function Get-ItemPath([string]$p) {
	$t = $p.TrimEnd('\', '/')
	if ($t -match '^[A-Za-z]:$') { return $t.ToUpperInvariant() + '\' }
	$i = $t.LastIndexOfAny([char[]]@('\', '/'))
	$leaf = $t.Substring($i + 1)
	$dir = Get-RealPath $t.Substring(0, $i + 1) $true
	if (-not [IO.Directory]::Exists($dir)) { throw "its folder is gone: $dir" }
	return [IO.Path]::Join($dir, $leaf)
}

# Unix seconds of a file system entry's last write.
function Get-Mtime($info) { return [long][Math]::Floor(($info.LastWriteTimeUtc - [DateTime]::UnixEpoch).TotalSeconds) }

# Runs a program with these arguments (each one argv entry, quoted by .NET), copying its
# stdout and stderr through, for at most $seconds; then stops it and everything it started.
# Returns its exit code, or -1 when it was stopped.
function Invoke-Bounded([string]$file, [string[]]$argv, [int]$seconds, [IO.Stream]$stdout = $null, [IO.Stream]$stderr = $null) {
	$si = [Diagnostics.ProcessStartInfo]::new($file)
	foreach ($a in $argv) { $si.ArgumentList.Add($a) }
	$si.UseShellExecute = $false
	$si.RedirectStandardInput = $true
	$si.RedirectStandardOutput = $true
	$si.RedirectStandardError = $true
	$p = [Diagnostics.Process]::Start($si)
	$p.StandardInput.Close()
	$o = if ($stdout) { $stdout } else { $script:Stdout }
	$e = if ($stderr) { $stderr } else { [Console]::OpenStandardError() }
	$t1 = $p.StandardOutput.BaseStream.CopyToAsync($o)
	$t2 = $p.StandardError.BaseStream.CopyToAsync($e)
	if (-not $p.WaitForExit($seconds * 1000)) {
		try { $p.Kill($true) } catch {}
		[void]$p.WaitForExit(5000)
		return -1
	}
	[void][Threading.Tasks.Task]::WaitAll(@($t1, $t2), 5000)
	return $p.ExitCode
}
