# Laptop half of the board's SDK/CLI upgrade: the board spawns this script,
# exits, and the script stops what is left, installs the new SDK, verifies its
# native binary, updates remote/bootstrap.sh (and the PATH claude, only when
# the job asks for it), commits, pushes and starts the board again. Every
# step is reported in server\data\upgrade.json (the job) and
# server\data\upgrade\<JobId>.log.
#
# ASCII only, deliberately. Windows PowerShell reads a BOM-less .ps1 as
# Windows-1252, where a UTF-8 dash decodes to a curly quote and ends a string.
param(
  [Parameter(Mandatory = $true)][int]$BoardPid,
  [Parameter(Mandatory = $true)][string]$JobId,
  [string]$Root = '',
  # 0 means: config.json "port", else 7420.
  [int]$Port = 0,

  # Test seams. Production always runs with the defaults.
  [int]$BoardWaitMs = 60000,
  [int]$PortFreeSec = 30,
  [int]$GuardWaitSec = 15,
  [int]$PushTimeoutMs = 60000,
  # claude install, only when a job asks for the PATH claude.
  [int]$ClaudeInstallTimeoutMs = 600000,
  [int]$StartWaitSec = 60,
  # Passed through to stop.ps1: the range of the port sweep.
  [int]$SweepPortFrom = 18080,
  [int]$SweepPortTo = 18900
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# PS 5.1 serializes some arrays as {"value":[...],"Count":n} because of this
# type data; without it ConvertTo-Json writes plain JSON arrays.
Remove-TypeData -TypeName System.Array -ErrorAction SilentlyContinue

if ($JobId -notmatch '^[A-Za-z0-9_-]{1,64}$') {
  Write-Host "upgrade.ps1: invalid -JobId '$JobId'"
  exit 2
}

if (-not $Root) { $Root = $PSScriptRoot }
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')

$utf8 = New-Object System.Text.UTF8Encoding $false
$serverDir = Join-Path $Root 'server'
# The board's data dir: HFSMON_DATA_DIR when set, as in server/src.
$dataDir = Join-Path $serverDir 'data'
if ($env:HFSMON_DATA_DIR) { $dataDir = [IO.Path]::GetFullPath($env:HFSMON_DATA_DIR) }
$jobFile = Join-Path $dataDir 'upgrade.json'
$logDir = Join-Path $dataDir 'upgrade'
$logFile = Join-Path $logDir "$JobId.log"
$lockFile = Join-Path $Root '.hfs-monitor.upgrading'
$pidFile = Join-Path $Root '.hfs-monitor.pid'
$sdkBin = Join-Path $serverDir 'node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
$bootstrapFile = Join-Path $Root 'remote\bootstrap.sh'
$powershellExe = Join-Path $PSHOME 'powershell.exe'

if ($Port -le 0) {
  $Port = 7420
  try {
    $cfg = [IO.File]::ReadAllText((Join-Path $Root 'config.json'), $utf8) | ConvertFrom-Json
    if ($cfg.port) { $Port = [int]$cfg.port }
  } catch { }
  # The board merges config.local.json over config.json; so does its port.
  try {
    $cfgLocal = [IO.File]::ReadAllText((Join-Path $Root 'config.local.json'), $utf8) | ConvertFrom-Json
    if ($cfgLocal.port) { $Port = [int]$cfgLocal.port }
  } catch { }
}

[void][IO.Directory]::CreateDirectory($logDir)

# ---- job state owned by this script -----------------------------------------

$script:stepEntries = [ordered]@{}
$script:laptop = [ordered]@{ commit = $null; pushed = $null; pushError = $null; rolledBack = $false }
$script:currentStep = $null
$script:failedStep = $null
$script:jobError = $null
$script:finalState = 'laptop'
$script:endedAt = $null
$script:job = $null
$script:npm = $null
$script:git = $null
$script:claude = $null
$script:headBefore = $null
$script:installTouched = $false
$script:bootstrapEdited = $false
$script:rollbackDone = $false
$script:startBegun = $false
$script:lockWritten = $false
# upgrade.json belongs to the board until its process is gone and the file
# names this job in state 'laptop'; before that nothing is read or written.
$script:jobWritable = $false
$script:nativeOutput = New-Object System.Collections.ArrayList
$script:nativeTimedOut = $false
$script:nativeSeq = 0

# Time limits for native commands: a hang must never leave the board down.
$NativeTimeoutMs = 600000          # git, stop.ps1
$NpmTimeoutMs = 1200000            # each npm install; a timeout is a failure
$VersionTimeoutMs = 20000          # claude.exe --version; a timeout is "no version"
# claude install is a parameter: see $ClaudeInstallTimeoutMs above. A timeout
# there is a warning, never a failure.

function Get-NowIso { [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") }

function Write-Log([string]$text) {
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -eq '') { continue }
    $stamped = "$(Get-NowIso) $line"
    try { [IO.File]::AppendAllText($logFile, "$stamped`n", $utf8) } catch { }
    Write-Host $stamped
  }
}

# Reads a file another process may still hold open for writing.
function Read-SharedText([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  try {
    $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      $sr = New-Object IO.StreamReader($fs, $utf8)
      return $sr.ReadToEnd()
    } finally { $fs.Dispose() }
  } catch { return '' }
}

function Get-LogTail {
  $lines = @((Read-SharedText $logFile) -split "`r?`n" | Where-Object { $_ -ne '' })
  if ($lines.Count -gt 40) { $lines = $lines[($lines.Count - 40)..($lines.Count - 1)] }
  return , ([object[]]$lines)
}

function Read-Job {
  if (-not (Test-Path -LiteralPath $jobFile)) { return $null }
  $raw = [IO.File]::ReadAllText($jobFile, $utf8)
  if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
  if (-not $raw.Trim()) { return $null }
  return ($raw | ConvertFrom-Json)
}

# An optional boolean the board may put in the job. Jobs written before the
# field existed have no such property: those read as $false, never as an error.
function Test-JobFlag([string]$name) {
  if (-not $script:job -or -not $script:job.PSObject.Properties[$name]) { return $false }
  $v = $script:job.$name
  if ($null -eq $v) { return $false }
  if ($v -is [string]) { return ($v.Trim().ToLowerInvariant() -eq 'true') }
  try { return [bool]$v } catch { return $false }
}

function Set-Prop($obj, [string]$name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

# Re-reads the job and overwrites only the fields this script owns. Steps are
# merged by name: entries written by the board stay, ours replace same-named ones.
function Save-Job {
  $job = $null
  try { $job = Read-Job } catch { Write-Log "upgrade.json unreadable, rewriting it: $($_.Exception.Message)" }
  if (-not $job) { $job = $script:job }

  $merged = New-Object System.Collections.ArrayList
  if ($job.PSObject.Properties['steps'] -and $job.steps) {
    foreach ($s in @($job.steps)) {
      if (-not $s -or $script:stepEntries.Contains([string]$s.name)) { continue }
      # This script running is what proves the handover worked.
      if ($s.name -eq 'laptop_launch' -and $s.state -eq 'running') { $s.state = 'ok' }
      [void]$merged.Add($s)
    }
  }
  foreach ($e in $script:stepEntries.Values) { [void]$merged.Add([pscustomobject]$e) }

  Set-Prop $job 'state' $script:finalState
  Set-Prop $job 'step' $script:currentStep
  Set-Prop $job 'steps' ([object[]]$merged.ToArray())
  Set-Prop $job 'failedStep' $script:failedStep
  Set-Prop $job 'error' $script:jobError
  Set-Prop $job 'laptop' ([pscustomobject]$script:laptop)
  Set-Prop $job 'scriptPid' $PID
  if ($script:endedAt) { Set-Prop $job 'endedAt' $script:endedAt }
  Set-Prop $job 'logTail' (Get-LogTail)

  $json = ConvertTo-Json -InputObject $job -Depth 10
  # Temp file plus move, so the restarted board never parses half a file.
  $tmp = "$jobFile.tmp"
  [IO.File]::WriteAllText($tmp, $json, $utf8)
  # A reader (the restarted board) can hold the file for a moment.
  for ($i = 1; $i -le 5; $i++) {
    try {
      Move-Item -LiteralPath $tmp -Destination $jobFile -Force
      break
    } catch {
      if ($i -eq 5) { throw }
      Start-Sleep -Milliseconds 200
    }
  }
}

function Set-Step([string]$name, [string]$state, [string]$detail = '') {
  $script:stepEntries[$name] = [ordered]@{ name = $name; state = $state; detail = $detail; at = (Get-NowIso) }
  $script:currentStep = $name
  $suffix = ''
  if ($detail) { $suffix = ": $detail" }
  Write-Log "[$name] $state$suffix"
  # A failed write must never skip a rollback or the start that follows.
  if ($script:jobWritable) {
    try { Save-Job } catch { Write-Log "upgrade.json write failed: $($_.Exception.Message)" }
  }
}

# The first failure names the job's failedStep; later ones only add to error.
function Fail-Step([string]$name, [string]$message) {
  if (-not $script:failedStep) {
    $script:failedStep = $name
    $script:jobError = $message
  } elseif (-not ([string]$script:jobError).Contains($message)) {
    $script:jobError = "$($script:jobError); $name`: $message"
  }
  Set-Step $name 'failed' $message
}

# ---- native commands --------------------------------------------------------

# Runs a native command in $Root with a time limit ($NativeTimeoutMs unless
# given), logging its output unless -Quiet. Returns the exit code and leaves the
# stdout then stderr lines in $script:nativeOutput. Start-Process with files
# rather than &, so a hung command can be killed: on a timeout the tree this
# call started is stopped, $script:nativeTimedOut is set and the code is -1.
function Invoke-Native([string]$exe, [string[]]$argv, [int]$timeoutMs = 0, [switch]$Quiet) {
  if ($timeoutMs -le 0) { $timeoutMs = $NativeTimeoutMs }
  $script:nativeOutput.Clear()
  $script:nativeTimedOut = $false
  $script:nativeSeq++
  $out = Join-Path $logDir "$JobId.native$($script:nativeSeq).out"
  $err = Join-Path $logDir "$JobId.native$($script:nativeSeq).err"
  if (-not $Quiet) { Write-Log "> $([IO.Path]::GetFileName($exe)) $($argv -join ' ')" }
  $quoted = @($argv | ForEach-Object { if ($_ -eq '' -or $_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } })
  $p = Start-Process -FilePath $exe -ArgumentList $quoted -WorkingDirectory $Root `
    -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle   # keeps ExitCode readable after the exit
  $finished = $p.WaitForExit($timeoutMs)
  if (-not $finished) {
    Stop-OwnTree $p
    [void]$p.WaitForExit(5000)
  }
  foreach ($f in @($out, $err)) {
    foreach ($line in ((Read-SharedText $f) -split "`r?`n")) {
      if ($line -eq '') { continue }
      [void]$script:nativeOutput.Add($line)
      if (-not $Quiet) { Write-Log "  $line" }
    }
  }
  Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
  if (-not $finished) {
    $script:nativeTimedOut = $true
    Write-Log "  $([IO.Path]::GetFileName($exe)) $($argv -join ' '): timed out after $([int]($timeoutMs / 1000)) s, stopped"
    return -1
  }
  $code = $p.ExitCode
  if ($null -eq $code) { $code = 0 }
  if ($code -ne 0 -and -not $Quiet) { Write-Log "  exit $code" }
  return [int]$code
}

# "2.1.272 (Claude Code)" -> "2.1.272"; $null when it does not run, answer, or
# answers within $VersionTimeoutMs.
function Get-ExeVersion([string]$exe) {
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return $null }
  try { $code = Invoke-Native $exe @('--version') $VersionTimeoutMs -Quiet } catch { return $null }
  if ($script:nativeTimedOut) { Write-Log "$exe --version did not answer in $([int]($VersionTimeoutMs / 1000)) s" }
  if ($code -ne 0) { return $null }
  $first = @($script:nativeOutput | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
  if (-not $first.Count) { return $null }
  $token = ($first[0].Trim() -split '\s+')[0]
  if ($token -match '^\d+\.\d+\.\d+$') { return $token }
  return $null
}

function Resolve-Tool([string]$name) {
  $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Path }
  return $null
}

function Resolve-Claude {
  $c = Resolve-Tool 'claude'
  if ($c) { return $c }
  $fallback = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path -LiteralPath $fallback) { return $fallback }
  return $null
}

function Test-PortListening([int]$p) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}

function Wait-PortFree([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-PortListening $Port)) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return (-not (Test-PortListening $Port))
}

# Kills a process this script started plus its descendants. The tree is read
# while the root is still alive and only processes created after it count, so
# a reused parent pid never drags in a stranger.
function Stop-OwnTree([System.Diagnostics.Process]$proc) {
  $ids = New-Object System.Collections.Generic.List[int]
  $ids.Add($proc.Id)
  try {
    $since = $proc.StartTime.AddSeconds(-1)
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $i = 0
    while ($i -lt $ids.Count) {
      $parent = $ids[$i]
      $i++
      foreach ($c in $all) {
        if ([int]$c.ParentProcessId -eq $parent -and $c.CreationDate -ge $since -and -not $ids.Contains([int]$c.ProcessId)) {
          $ids.Add([int]$c.ProcessId)
        }
      }
    }
  } catch { }
  foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}

function Quote-Arg([string]$s) { return '"' + $s + '"' }

# ---- SDK binary -------------------------------------------------------------

# $null when the SDK's claude.exe exists and reports $wantCli (any version when
# $wantCli is empty); otherwise the problem, in words.
function Test-SdkBinary([string]$wantCli) {
  if (-not (Test-Path -LiteralPath $sdkBin)) { return 'claude.exe is missing from claude-agent-sdk-win32-x64' }
  $v = Get-ExeVersion $sdkBin
  if (-not $v) { return 'claude.exe --version gave no version' }
  if ($wantCli -and $v -ne $wantCli) { return "claude.exe is $v, expected $wantCli" }
  return $null
}

# ---- steps ------------------------------------------------------------------

# Asks the board to write everything it holds before it is forced to stop (Stop-Process
# -Force skips every exit handler). Same rule as stop.ps1: 'saved', 'refused' (the board
# answered 500: it tried and could not, so it must NOT be killed) or 'unreachable'.
function Request-BoardFlush {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 20 -Uri "http://127.0.0.1:$Port/api/flush"
    Write-Log "the board saved its data (HTTP $($r.StatusCode))"
    return 'saved'
  } catch {
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    if ($code -eq 500) {
      $detail = ''
      try { $detail = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch { }
      if (-not $detail) { try { $detail = $_.ErrorDetails.Message } catch { } }
      Write-Log "THE BOARD COULD NOT SAVE ITS DATA: $detail"
      return 'refused'
    }
    Write-Log "could not ask the board to save ($($_.Exception.Message))"
    return 'unreachable'
  }
}

# Part one of laptop_stop, before the handover: only waits for the board.
function Wait-BoardExit {
  Set-Step 'laptop_stop' 'running' "board pid $BoardPid"
  $b = Get-Process -Id $BoardPid -ErrorAction SilentlyContinue
  if ($b) {
    # The board is always alive when this script starts, so a node that started
    # later (or anything else) is a stranger holding a reused pid. Command lines
    # cannot tell: the board runs as a relative "node src/index.js".
    $isBoard = $false
    try { $isBoard = ($b.ProcessName -eq 'node' -and $b.StartTime -lt (Get-Process -Id $PID).StartTime) } catch { }
    if (-not $isBoard) {
      Write-Log "pid $BoardPid is $($b.ProcessName), started after this script or not node: not the board; leaving it alone"
      $b = $null
    }
  }
  if ($b) {
    if (-not $b.WaitForExit($BoardWaitMs)) {
      Write-Log "the board is still alive after $BoardWaitMs ms; asking it to save before it is forced"
      if ((Request-BoardFlush) -eq 'refused') {
        # Closing it would lose what it holds in memory. The step after this one fails
        # because the port stays busy, which is the right outcome: nothing is lost.
        Write-Log "NOT stopping the board (pid $BoardPid): it could not save. Free the disk or the locked file and retry the update."
      } else {
        Write-Log 'Stop-Process -Force'
        Stop-Process -Id $BoardPid -Force -ErrorAction SilentlyContinue
        [void]$b.WaitForExit(10000)
      }
    }
  }
}

# The handover: upgrade.json is ours only when it names this job in 'laptop'.
function Open-Job {
  $j = $null
  try { $j = Read-Job } catch { Write-Log "upgrade.json unreadable: $($_.Exception.Message)" }
  if (-not $j) {
    Write-Log 'upgrade.json is missing or empty'
    return $false
  }
  if ([string]$j.id -ne $JobId -or [string]$j.state -ne 'laptop') {
    Write-Log "upgrade.json holds job '$($j.id)' in state '$($j.state)', not '$JobId' in 'laptop'"
    return $false
  }
  $script:job = $j
  $script:jobWritable = $true
  return $true
}

# Part two of laptop_stop, after the handover: pid file and port sweep.
function Step-Stop {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  # -Force: this script's own lock would block stop.ps1 otherwise. With no pid
  # file left, stop.ps1 only sweeps the board's port ranges.
  $code = Invoke-Native $powershellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'stop.ps1'),
    '-Force', '-PortFrom', "$SweepPortFrom", '-PortTo', "$SweepPortTo")
  if ($code -ne 0) { Write-Log "stop.ps1 exited $code" }

  if (-not (Wait-PortFree $PortFreeSec)) {
    Fail-Step 'laptop_stop' "port $Port is still in use after $PortFreeSec s"
    return
  }
  Set-Step 'laptop_stop' 'ok' "board pid $BoardPid stopped, port $Port free"
}

# node/claude processes that would hold files npm is about to replace: any
# whose command line points inside <Root>\server, and any claude.exe whose
# image lives under server\node_modules.
function Get-ModuleProcesses {
  $serverRx = [regex]::Escape($serverDir.ToLowerInvariant()) + '(\\|"|\s|$)'
  $modules = (Join-Path $serverDir 'node_modules').ToLowerInvariant() + '\'
  $hits = @()
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='claude.exe'" -ErrorAction SilentlyContinue)
  foreach ($p in $procs) {
    if ([int]$p.ProcessId -eq $PID) { continue }
    $cmd = ([string]$p.CommandLine).Replace('/', '\').ToLowerInvariant()
    $exe = ([string]$p.ExecutablePath).Replace('/', '\').ToLowerInvariant()
    $fromModules = ($p.Name -eq 'claude.exe' -and $exe.StartsWith($modules))
    if ($fromModules -or [regex]::IsMatch($cmd, $serverRx)) {
      $hits += "$($p.Name) pid $($p.ProcessId)"
    }
  }
  return , $hits
}

function Step-Guard {
  Set-Step 'laptop_guard' 'running'
  $sdk = [string]$script:job.target.sdk
  $cli = [string]$script:job.target.cli
  if ($sdk -notmatch '^\d{1,4}\.\d{1,4}\.\d{1,6}$' -or $cli -notmatch '^\d{1,4}\.\d{1,4}\.\d{1,6}$') {
    Fail-Step 'laptop_guard' "invalid target in upgrade.json (sdk '$sdk', cli '$cli')"
    return
  }

  $script:npm = Resolve-Tool 'npm.cmd'
  $script:git = Resolve-Tool 'git.exe'
  $script:claude = Resolve-Claude
  Write-Log "npm: $($script:npm); git: $($script:git); claude: $($script:claude)"
  $missing = @()
  if (-not $script:npm) { $missing += 'npm.cmd' }
  if (-not $script:git) { $missing += 'git.exe' }
  if ($missing.Count) {
    Fail-Step 'laptop_guard' "not found on PATH: $($missing -join ', ')"
    return
  }

  # The job may have waited long after the board's precheck: check again before
  # touching anything. A commit on another branch, or a rollback checkout over
  # an uncommitted edit, would be far worse than not upgrading.
  $code = Invoke-Native $script:git @('symbolic-ref', '--short', 'HEAD')
  $branch = ''
  if ($code -eq 0 -and $script:nativeOutput.Count) { $branch = ([string]$script:nativeOutput[0]).Trim() }
  if ($branch -ne 'main') {
    Fail-Step 'laptop_guard' "the checkout is on '$branch', not main"
    return
  }
  $code = Invoke-Native $script:git @('diff', '--quiet', 'HEAD', '--', 'server/package.json', 'server/package-lock.json', 'remote/bootstrap.sh')
  if ($code -ne 0) {
    Fail-Step 'laptop_guard' "uncommitted changes in server/package.json, server/package-lock.json or remote/bootstrap.sh (git diff exited $code)"
    return
  }

  # Sessions the board just closed can take a moment to exit.
  $deadline = (Get-Date).AddSeconds($GuardWaitSec)
  $hits = Get-ModuleProcesses
  while ($hits.Count -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $hits = Get-ModuleProcesses
  }
  if ($hits.Count) {
    Fail-Step 'laptop_guard' "still running from $serverDir after $GuardWaitSec s: $($hits -join '; ')"
    return
  }

  $code = Invoke-Native $script:git @('rev-parse', 'HEAD')
  if ($code -eq 0 -and $script:nativeOutput.Count) { $script:headBefore = ([string]$script:nativeOutput[$script:nativeOutput.Count - 1]).Trim() }
  Set-Step 'laptop_guard' 'ok' "nothing runs from $serverDir"
}

function Step-Install {
  $sdk = [string]$script:job.target.sdk
  Set-Step 'laptop_install' 'running' "@anthropic-ai/claude-agent-sdk@$sdk"
  $script:installTouched = $true
  $code = Invoke-Native $script:npm @('install', "@anthropic-ai/claude-agent-sdk@$sdk", '--prefix', 'server') $NpmTimeoutMs
  if ($script:nativeTimedOut) {
    Fail-Step 'laptop_install' "npm install timed out after $([int]($NpmTimeoutMs / 1000)) s"
    return
  }
  if ($code -ne 0) {
    Fail-Step 'laptop_install' "npm install exited $code"
    return
  }
  Set-Step 'laptop_install' 'ok' "@anthropic-ai/claude-agent-sdk@$sdk"
}

function Step-Verify {
  $sdk = [string]$script:job.target.sdk
  $cli = [string]$script:job.target.cli
  Set-Step 'laptop_verify' 'running' "claude.exe $cli"
  $problem = Test-SdkBinary $cli
  $attempt = 1
  if ($problem) {
    Write-Log "attempt 1: $problem; npm install again"
    [void](Invoke-Native $script:npm @('install', '--prefix', 'server') $NpmTimeoutMs)
    $attempt = 2
    $problem = Test-SdkBinary $cli
  }
  if ($problem) {
    Write-Log "attempt 2: $problem; installing the platform package directly"
    [void](Invoke-Native $script:npm @('install', '--no-save', "@anthropic-ai/claude-agent-sdk-win32-x64@$sdk", '--prefix', 'server') $NpmTimeoutMs)
    $attempt = 3
    $problem = Test-SdkBinary $cli
  }
  if ($problem) {
    Fail-Step 'laptop_verify' "attempt 3: $problem"
    return
  }
  Set-Step 'laptop_verify' 'ok' "claude.exe $cli (attempt $attempt)"
}

# A `claude install` that dies halfway leaves the file it was still writing in
# the CLI's version folder behind, and the next run of the CLI trusts that
# file. Looks at that one path - the version this job asked for, in the folder
# the native installer keeps its binaries in (the sibling of the
# .local\bin\claude.exe Resolve-Claude falls back to) - removes it when it is
# an empty real file, and returns the sentence to add to the step's detail.
# Empty, so the detail stays as it was, when there is nothing to say. A file
# with bytes in it is named, never removed: only a person can tell a finished
# binary from a truncated one. A link is left alone as well: .NET reports a
# symlink's own length as 0, and removing it would remove a name the installer
# did not write. Another version and the claude.exe on PATH are never touched.
function Get-CliLeftoverNote([string]$version) {
  if ($version -notmatch '^\d{1,4}\.\d{1,4}\.\d{1,6}$') { return '' }
  if (-not $env:USERPROFILE) { return '' }
  $path = Join-Path $env:USERPROFILE ".local\share\claude\versions\$version"
  $item = $null
  try { $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop } catch { return '' }
  if ($item.PSIsContainer) { return '' }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Write-Log "$path is a link, not a file the installer wrote: left alone"
    return ''
  }
  if ($item.Length -ne 0) { return "; left the $($item.Length)-byte $path behind, check it by hand" }
  try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop } catch {
    Write-Log "could not remove the 0-byte $path : $($_.Exception.Message)"
    return ''
  }
  Write-Log "removed the 0-byte $path the dead install left behind"
  return "; removed the 0-byte $path it left behind"
}

function Step-Cli {
  $cli = [string]$script:job.target.cli
  # The board never runs the claude on PATH: its sessions use the CLI inside
  # the SDK, and the runner's CLAUDE_VERSION_WANTED is Step-Bootstrap's job.
  # Installing over the PATH claude only disturbs the CLI a person has open -
  # it shares the credentials file with live sessions - so it happens only when
  # the job explicitly asks for it. A job without the field asks for nothing.
  if (-not (Test-JobFlag 'updatePathCli')) {
    Set-Step 'laptop_cli' 'skipped' "the job did not ask for the PATH claude to move to $cli; the board runs the SDK's own CLI"
    return
  }
  Set-Step 'laptop_cli' 'running' "PATH claude to $cli if older"
  $have = $null
  if ($script:claude) { $have = Get-ExeVersion $script:claude }
  if ($have -and ([version]$have -ge [version]$cli)) {
    Set-Step 'laptop_cli' 'skipped' "PATH claude is already $have"
    return
  }
  # A missing or broken PATH claude is installed by the SDK's own binary,
  # which is the same CLI and was just verified.
  $installer = $sdkBin
  if ($have) { $installer = $script:claude }
  $code = Invoke-Native $installer @('install', $cli) $ClaudeInstallTimeoutMs
  if ($script:nativeTimedOut) {
    $detail = "claude install $cli timed out after $([int]($ClaudeInstallTimeoutMs / 1000)) s; the PATH claude stays at $have"
    Set-Step 'laptop_cli' 'warn' ($detail + (Get-CliLeftoverNote $cli))
    return
  }
  if ($code -ne 0) {
    $detail = "claude install $cli exited $code; the PATH claude stays at $have"
    Set-Step 'laptop_cli' 'warn' ($detail + (Get-CliLeftoverNote $cli))
    return
  }
  $after = Get-ExeVersion (Resolve-Claude)
  if (-not $after -or ([version]$after -lt [version]$cli)) {
    Set-Step 'laptop_cli' 'warn' "claude install $cli finished, but the PATH claude reports '$after'"
    return
  }
  Set-Step 'laptop_cli' 'ok' "PATH claude $have -> $after"
}

function Step-Bootstrap {
  $cli = [string]$script:job.target.cli
  Set-Step 'laptop_bootstrap' 'running' "CLAUDE_VERSION_WANTED default to $cli"
  if (-not (Test-Path -LiteralPath $bootstrapFile)) {
    Fail-Step 'laptop_bootstrap' 'remote/bootstrap.sh not found'
    return
  }
  # UTF-8 without BOM, line endings untouched: only the default changes.
  $text = [IO.File]::ReadAllText($bootstrapFile, $utf8)
  $rx = 'CLAUDE_VERSION_WANTED:-2\.1\.\d+'
  if (-not [regex]::IsMatch($text, $rx)) {
    Fail-Step 'laptop_bootstrap' 'CLAUDE_VERSION_WANTED:-2.1.N not found in remote/bootstrap.sh'
    return
  }
  $new = [regex]::Replace($text, $rx, "CLAUDE_VERSION_WANTED:-$cli")
  if ($new -ceq $text) {
    Set-Step 'laptop_bootstrap' 'skipped' "already $cli"
    return
  }
  [IO.File]::WriteAllText($bootstrapFile, $new, $utf8)
  $script:bootstrapEdited = $true
  Set-Step 'laptop_bootstrap' 'ok' "CLAUDE_VERSION_WANTED default is $cli"
}

function Step-Commit {
  $sdk = [string]$script:job.target.sdk
  $cli = [string]$script:job.target.cli
  $files = @('server/package.json', 'server/package-lock.json', 'remote/bootstrap.sh')
  Set-Step 'laptop_commit' 'running'
  # Same version (force mode): nothing to commit, and git commit would exit 1.
  $code = Invoke-Native $script:git (@('diff', '--quiet', 'HEAD', '--') + $files)
  if ($code -eq 0) {
    Set-Step 'laptop_commit' 'skipped' 'nothing changed'
    return
  }
  if ($code -ne 1) {
    Fail-Step 'laptop_commit' "git diff exited $code"
    return
  }
  $message = "Move to Claude Agent SDK $sdk and CLI $cli"
  $code = Invoke-Native $script:git (@('commit', '--only', '-m', $message, '--') + $files)
  if ($code -ne 0) {
    Fail-Step 'laptop_commit' "git commit exited $code"
    return
  }
  $code = Invoke-Native $script:git @('rev-parse', 'HEAD')
  if ($code -eq 0 -and $script:nativeOutput.Count) {
    $script:laptop.commit = ([string]$script:nativeOutput[$script:nativeOutput.Count - 1]).Trim()
  }
  Set-Step 'laptop_commit' 'ok' "$($script:laptop.commit) $message"
}

# Never throws: the commit already exists, and nothing about a push may roll
# it back. Every problem here is a warning.
function Step-Push {
  Set-Step 'laptop_push' 'running' 'origin main'
  try {
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'
    $code = Invoke-Native $script:git @('push', 'origin', 'main') $PushTimeoutMs
    if ($script:nativeTimedOut) {
      $script:laptop.pushed = $false
      $script:laptop.pushError = "git push timed out after $([int]($PushTimeoutMs / 1000)) s"
      Set-Step 'laptop_push' 'warn' $script:laptop.pushError
      return
    }
    if ($code -ne 0) {
      $script:laptop.pushed = $false
      $script:laptop.pushError = "git push exited $code"
      Set-Step 'laptop_push' 'warn' $script:laptop.pushError
      return
    }
    $script:laptop.pushed = $true
    Set-Step 'laptop_push' 'ok' 'origin main'
  } catch {
    $script:laptop.pushed = $false
    $script:laptop.pushError = "git push failed: $($_.Exception.Message)"
    Set-Step 'laptop_push' 'warn' $script:laptop.pushError
  }
}

function Invoke-Rollback {
  $script:rollbackDone = $true
  Set-Step 'laptop_rollback' 'running'
  $problems = @()
  $files = @('server/package.json', 'server/package-lock.json')
  if ($script:bootstrapEdited) { $files += 'remote/bootstrap.sh' }
  # From the commit the upgrade started on: identical to the index before the
  # commit step, and still right if the commit already happened.
  $from = @()
  if ($script:headBefore) { $from = @($script:headBefore) }
  $code = Invoke-Native $script:git (@('-c', 'core.autocrlf=false', 'checkout') + $from + @('--') + $files)
  if ($code -ne 0) { $problems += "git checkout exited $code" }

  [void](Invoke-Native $script:npm @('install', '--prefix', 'server') $NpmTimeoutMs)
  $problem = Test-SdkBinary ''
  if ($problem) {
    Write-Log "after rollback: $problem; npm install again"
    [void](Invoke-Native $script:npm @('install', '--prefix', 'server') $NpmTimeoutMs)
    $problem = Test-SdkBinary ''
  }
  if ($problem) { $problems += $problem }
  $script:laptop.rolledBack = $true

  # After a commit the restored files differ from HEAD: say so, and whether the
  # commit already left the machine.
  $dirty = ''
  if ($script:laptop.commit) {
    $dirty = "; working tree left dirty against commit $($script:laptop.commit), pushed=$(([string]$script:laptop.pushed).ToLowerInvariant())"
  }
  if ($problems.Count) {
    $msg = $problems -join '; '
    $script:jobError = "$($script:jobError); rollback: $msg"
    Set-Step 'laptop_rollback' 'failed' "$msg$dirty"
  } else {
    # Reported, never compared: 'previous' is the board's to fill in.
    $detail = "package files restored, claude.exe $(Get-ExeVersion $sdkBin)"
    if ($script:job.previous.cli) { $detail += " (previous $($script:job.previous.cli))" }
    Set-Step 'laptop_rollback' 'ok' "$detail$dirty"
  }
}

function Test-BoardAnswers {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/upgrade" -Headers @{ Host = '127.0.0.1' } -TimeoutSec 5
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch {
    return $false
  }
}

# start.ps1 -Force, then poll the board. True when it answered.
function Start-Board([int]$round) {
  $out = Join-Path $logDir "$JobId.start$round.out.log"
  $err = Join-Path $logDir "$JobId.start$round.err.log"
  # Files, not a pipe: the board inherits these handles and outlives start.ps1,
  # so a pipe would never reach end-of-file. They stay until the board exits.
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Quote-Arg (Join-Path $Root 'start.ps1')), '-Force')
  $p = Start-Process -FilePath $powershellExe -ArgumentList $argv -WorkingDirectory $Root `
    -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle
  # start.ps1 builds the web first; that is minutes at worst, never forever.
  if (-not $p.WaitForExit(600000)) { Write-Log 'start.ps1 did not finish in 10 minutes' }
  Write-Log (Read-SharedText $out)
  Write-Log (Read-SharedText $err)
  if ($p.HasExited -and $p.ExitCode -ne 0) { Write-Log "start.ps1 exited $($p.ExitCode)" }

  $deadline = (Get-Date).AddSeconds($StartWaitSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-BoardAnswers) { return $true }
    Start-Sleep -Milliseconds 700
  }
  return (Test-BoardAnswers)
}

function Stop-StartedBoard {
  if (Test-Path -LiteralPath $pidFile) {
    $id = 0
    $raw = ([string](Get-Content -LiteralPath $pidFile -Raw)).Trim()
    if ([int]::TryParse($raw, [ref]$id)) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($p) {
        Write-Log "stopping the unresponsive board (pid $id)"
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        [void]$p.WaitForExit(10000)
      }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
  [void](Wait-PortFree $PortFreeSec)
}

function Step-Start {
  $script:startBegun = $true
  Set-Step 'laptop_start' 'running' "start.ps1 -Force, port $Port"
  if (Start-Board 1) {
    Set-Step 'laptop_start' 'ok' "the board answers on port $Port"
    return
  }
  Write-Log "the board did not answer on port $Port within $StartWaitSec s"
  Stop-StartedBoard
  if ($script:installTouched -and -not $script:rollbackDone) { Invoke-Rollback }
  $second = Start-Board 2
  $msg = "the board did not answer on port $Port within $StartWaitSec s"
  if ($second) { $msg += '; it answered after a second start' }
  else { $msg += ', not even after a second start' }
  Fail-Step 'laptop_start' $msg
}

function Invoke-Upgrade {
  Step-Stop
  if ($script:failedStep) { return }
  Step-Guard
  if ($script:failedStep) { return }
  Step-Install
  if ($script:failedStep) { return }
  Step-Verify
  if ($script:failedStep) { return }
  Step-Cli
  Step-Bootstrap
  if ($script:failedStep) { return }
  Step-Commit
  if ($script:failedStep) { return }
  Step-Push
}

# ---- main -------------------------------------------------------------------

$exitCode = 1
try {
  if (Test-Path -LiteralPath $lockFile) {
    try {
      $other = [IO.File]::ReadAllText($lockFile, $utf8) | ConvertFrom-Json
      $otherPid = [int]$other.pid
      $otherProc = $null
      if ($otherPid -and $otherPid -ne $PID) { $otherProc = Get-Process -Id $otherPid -ErrorAction SilentlyContinue }
      if ($otherProc) {
        # Same stale test as start.ps1: a pid reused after an earlier run was
        # killed started after that run wrote the lock.
        $stale = $false
        try {
          if ($other.startedAt -and $otherProc.StartTime.ToUniversalTime() -gt ([datetime]$other.startedAt).ToUniversalTime().AddSeconds(5)) { $stale = $true }
        } catch { }
        if ($stale) {
          Write-Log "stale lock: pid $otherPid now belongs to a later process; taking the lock over"
        } else {
          Write-Log "another upgrade.ps1 holds the lock (pid $otherPid); leaving everything to it"
          # exit, not return: a top-level return would end the script with 0.
          # finally still runs, and has nothing of ours to write or remove.
          exit 3
        }
      }
    } catch { }
  }
  $lock = [ordered]@{ pid = $PID; startedAt = (Get-NowIso) }
  [IO.File]::WriteAllText($lockFile, (ConvertTo-Json -InputObject ([pscustomobject]$lock) -Compress), $utf8)
  $script:lockWritten = $true
  Write-Log "upgrade.ps1 pid $PID, job $JobId, root $Root, port $Port"

  Wait-BoardExit
  if (-not (Open-Job)) {
    # Not ours to report on: change nothing, only bring the board back.
    Write-Log 'changing nothing; starting the board as it is'
    [void](Wait-PortFree $PortFreeSec)
    $script:startBegun = $true
    if (Start-Board 1) { Write-Log "the board answers on port $Port" }
    else { Write-Log "the board did not answer on port $Port within $StartWaitSec s" }
    # exit, not return (a top-level return exits 0); finally removes the lock.
    exit 1
  }
  Save-Job

  Invoke-Upgrade
  if ($script:failedStep -and $script:installTouched -and -not $script:rollbackDone) { Invoke-Rollback }
  Step-Start
} catch {
  $msg = "$($_.Exception.Message)"
  Write-Log "unexpected error: $msg"
  Write-Log "$($_.ScriptStackTrace)"
  $at = $script:currentStep
  if (-not $at) { $at = 'laptop_stop' }
  try { Fail-Step $at "unexpected error: $msg" } catch {
    if (-not $script:failedStep) { $script:failedStep = $at; $script:jobError = $msg }
  }
  # Whatever broke, leave the board running on the previous version.
  try {
    if ($script:installTouched -and -not $script:rollbackDone -and $script:git -and $script:npm) { Invoke-Rollback }
  } catch { Write-Log "rollback failed: $($_.Exception.Message)" }
  # Not "unless a start began": a start that blew up gets one more try.
  try {
    if (-not (Test-BoardAnswers)) {
      if ($script:jobWritable) { Step-Start } else { [void](Start-Board 1) }
    }
  } catch { Write-Log "start failed: $($_.Exception.Message)" }
} finally {
  # Order matters: final job first, then the lock, then exit.
  if ($script:jobWritable) {
    if ($script:failedStep) { $script:finalState = 'failed' } else { $script:finalState = 'done' }
    $script:endedAt = Get-NowIso
    $script:currentStep = $null
    Write-Log "upgrade $($script:finalState)"
    try { Save-Job } catch { Write-Log "could not write upgrade.json: $($_.Exception.Message)" }
    if ($script:finalState -eq 'done') { $exitCode = 0 }
  }
  if ($script:lockWritten) { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue }
}
exit $exitCode
