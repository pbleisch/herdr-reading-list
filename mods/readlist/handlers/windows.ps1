# The reading list's built-in actions on Windows: the default app, Explorer, and the QuickLook
# app or PowerToys Peek for Space. It ships with the mod and is replaced when the mod is
# reinstalled; to change what an action does, write your own handler instead (README, "Your
# own handler"). bin/windows/run-handler.ps1 runs it as
#   windows.ps1 ACTION [ARG...] -- ITEM
# and reads the exit status: 0 done, 10 not handled, anything else failed (stderr says why).
#   open -- PATH                       open with its default app (the shell's association)
#   reveal -- PATH                     show selected in Explorer (explorer /select,)
#   preview -- PATH                    the QuickLook app, else PowerToys Peek; prints which
#                                      (the token); not handled (with the reason on stderr)
#                                      when neither is installed
#   preview-close TOKEN same|other -- PATH
#                                      QuickLook: same runs it again on PATH, which closes
#                                      it; other: nothing (the next preview replaces it).
#                                      Peek closes itself when it loses focus.
#   thumbnail SIZE OUT -- PATH         not handled: the pane shows the type's icon
#   open-url -- URL                    not handled: the mod opens links in the browser
# With READLIST_DRY_RUN=1 it prints what it would run (one line, `would: ...`) and runs
# nothing.

#Requires -Version 7.0
Set-StrictMode -Version 3.0

$dry = $env:READLIST_DRY_RUN -eq '1'

function Fail([string]$why, [int]$code = 1) {
	[Console]::Error.WriteLine($why)
	exit $code
}

# Types Windows would run or install rather than show (core/items.js RUNS and core/platform.js
# WINDOWS_RUNS, and PATHEXT): the mod reveals these instead of opening them; this refuses them
# too.
$Runs = @('exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle',
	'appinstaller', 'application', 'appref-ms', 'lnk', 'url', 'website', 'pif', 'scr', 'cpl', 'msc', 'inf', 'reg', 'vbs', 'vbe', 'js', 'jse',
	'wsf', 'wsh', 'wsc', 'ws', 'hta', 'chm', 'jar', 'gadget', 'scf', 'settingcontent-ms', 'library-ms', 'search-ms', 'searchconnector-ms',
	'diagcab', 'msh', 'msh1', 'msh2', 'mshxml', 'iso', 'img', 'vhd', 'vhdx', 'xll', 'py', 'pyw', 'pl', 'rb', 'sh')

function Test-Runs([string]$path) {
	$e = [IO.Path]::GetExtension($path).TrimStart('.').ToLowerInvariant()
	if (-not $e) { return $false }
	if ($e -in $Runs) { return $true }
	$pathext = @(($env:PATHEXT ?? '') -split ';' | ForEach-Object { $_.Trim().TrimStart('.').ToLowerInvariant() })
	return $e -in $pathext
}

# Starts a program with each argument its own argv entry and does not wait for it.
function Start-Detached([string]$file, [string[]]$argv) {
	if ($dry) {
		[Console]::Out.WriteLine("would: $file $($argv -join ' ')")
		return
	}
	$si = [Diagnostics.ProcessStartInfo]::new($file)
	foreach ($a in $argv) { $si.ArgumentList.Add($a) }
	$si.UseShellExecute = $false
	[void][Diagnostics.Process]::Start($si)
}

# The QuickLook app (QL-Win), installed per user, for all users, or with Scoop; else $null.
function Find-QuickLook {
	$c = @()
	if ($env:LOCALAPPDATA) { $c += Join-Path $env:LOCALAPPDATA 'Programs\QuickLook\QuickLook.exe' }
	if ($env:ProgramFiles) { $c += Join-Path $env:ProgramFiles 'QuickLook\QuickLook.exe' }
	if ($env:USERPROFILE) { $c += Join-Path $env:USERPROFILE 'scoop\apps\quicklook\current\QuickLook.exe' }
	foreach ($p in $c) { if ([IO.File]::Exists($p)) { return $p } }
	$cmd = Get-Command QuickLook.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($cmd) { return $cmd.Source }
	return $null
}

# PowerToys Peek's window (PowerToys installed per user or for all users); else $null.
function Find-Peek {
	$c = @()
	if ($env:LOCALAPPDATA) { $c += Join-Path $env:LOCALAPPDATA 'PowerToys\WinUI3Apps\PowerToys.Peek.UI.exe' }
	if ($env:ProgramFiles) { $c += Join-Path $env:ProgramFiles 'PowerToys\WinUI3Apps\PowerToys.Peek.UI.exe' }
	foreach ($p in $c) { if ([IO.File]::Exists($p)) { return $p } }
	return $null
}

$a = [string[]]@($args | ForEach-Object { [string]$_ })
$action = if ($a.Count) { $a[0] } else { '' }
# The item: the last argument, right after `--`.
function Item([int]$at) {
	if ($a.Count -ne $at + 2 -or $a[$at] -cne '--') { exit 2 }
	$p = $a[$at + 1]
	if ($p -notmatch '^[A-Za-z]:\\' -or $p.Contains('"')) { Fail "not a local path: $p" 2 }
	return $p
}

switch -CaseSensitive ($action) {
	'open' {
		$p = Item 1
		if (Test-Runs $p) { Fail "$([IO.Path]::GetFileName($p)) could run, so it is not opened" }
		if ($dry) {
			[Console]::Out.WriteLine("would: open $p")
			exit 0
		}
		try {
			$si = [Diagnostics.ProcessStartInfo]::new($p)
			$si.UseShellExecute = $true
			[void][Diagnostics.Process]::Start($si)
		} catch {
			Fail "Windows could not open it: $($_.Exception.Message)"
		}
		exit 0
	}
	'reveal' {
		$p = Item 1
		# explorer.exe parses its own command line: the path is quoted (it cannot contain a quote).
		$explorer = Join-Path $env:SystemRoot 'explorer.exe'
		$line = "/select,`"$p`""
		if ($dry) {
			[Console]::Out.WriteLine("would: $explorer $line")
			exit 0
		}
		$si = [Diagnostics.ProcessStartInfo]::new($explorer, $line)
		$si.UseShellExecute = $false
		try {
			[void][Diagnostics.Process]::Start($si)
		} catch {
			Fail "Explorer did not start: $($_.Exception.Message)"
		}
		exit 0
	}
	'preview' {
		$p = Item 1
		$ql = Find-QuickLook
		if ($ql) {
			Start-Detached $ql @($p)
			[Console]::Out.WriteLine('quicklook')
			exit 0
		}
		$peek = Find-Peek
		if ($peek) {
			Start-Detached $peek @($p)
			[Console]::Out.WriteLine('peek')
			exit 0
		}
		Fail "Space's preview window needs the QuickLook app or PowerToys Peek" 10
	}
	'preview-close' {
		if ($a.Count -lt 3) { exit 2 }
		$p = Item 3
		if ($a[2] -cne 'same') { exit 0 }
		if ($a[1] -ceq 'quicklook') {
			$ql = Find-QuickLook
			if (-not $ql) { exit 1 }
			Start-Detached $ql @($p)
			exit 0
		}
		exit 1
	}
	default { exit 10 }
}
