# Stop, wait for the port to actually come free, start, and return only when the
# board answers. Exit codes: 0 = answering, 1 = failed, 2 = answering but start.ps1
# reported a failed install / web build (it started on whatever web/dist there was).
#
# A restart typed inside a board chat descends from the board's own node, and
# stop.ps1's taskkill /T /F would kill it half-way. So the front (this script,
# without -Worker) does no work: through ShellExecute (Start-Process without
# -Redirect*, which hands over no handles) it starts an intermediate PowerShell
# whose only job is to start the WORKER (this script with -Worker) the same way
# and exit. The worker's parent is therefore dead before anything is stopped, and
# taskkill /T (which walks parent pids) cannot reach it. The worker writes what it
# prints to hfs-monitor.restart.log and its exit code to .hfs-monitor.restart.result;
# the front follows the log and exits with that code. If the front is killed, nothing
# depends on it.
#
# ASCII only: Windows PowerShell reads a BOM-less .ps1 as Windows-1252, where a
# UTF-8 dash decodes to a curly quote and ends a string early.
param(
  # 0 = the `port` key of config.json, else 7420 (same as upgrade.ps1).
  [int]$Port = 0,
  [int]$TimeoutSeconds = 30,
  # Handed to stop.ps1 (its defaults).
  [int]$PortFrom = 18080,
  [int]$PortTo = 18900,
  [int]$StartTimeoutSeconds = 60,
  # How long the front follows the worker: stop + start + install/build time.
  [int]$FollowSeconds = 900,
  # Internal: this process is the detached worker.
  [switch]$Worker,
  [int]$ParentPid = 0
)

$root = $PSScriptRoot
$logFile = Join-Path $root 'hfs-monitor.restart.log'
$resultFile = Join-Path $root '.hfs-monitor.restart.result'
$pidFile = Join-Path $root '.hfs-monitor.pid'
$errLog = Join-Path $root 'hfs-monitor.err.log'
$psExe = Join-Path $PSHOME 'powershell.exe'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$ProgressPreference = 'SilentlyContinue'

if ($Port -le 0) {
  $Port = 7420
  try {
    $cfg = [IO.File]::ReadAllText((Join-Path $root 'config.json'), $utf8) | ConvertFrom-Json
    if ($cfg.port) { $Port = [int]$cfg.port }
  } catch { }
}

# One restart at a time per checkout: a second one would interleave on the same
# log and result file. The worker holds this named mutex for its whole run (the OS
# releases it when the process ends); the front only probes it.
$sha = [Security.Cryptography.SHA1]::Create()
$hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))) -replace '-', '').Substring(0, 16)
$mutexName = "hfs-monitor-restart-$hash"

if (-not $Worker) {
  # ---- Front: launch the worker through an intermediate, then follow its log.
  $probe = New-Object Threading.Mutex($false, $mutexName)
  $free = $false
  try { $free = $probe.WaitOne(0) } catch [Threading.AbandonedMutexException] { $free = $true }
  if (-not $free) {
    Write-Host 'Ya hay un reinicio en curso; este se descarta.' -ForegroundColor Yellow
    exit 1
  }
  $probe.ReleaseMutex()
  $probe.Dispose()

  Write-Host 'El reinicio corre en segundo plano; Ctrl+C no lo detiene. Registro: hfs-monitor.restart.log'
  [IO.File]::WriteAllText($logFile, '', $utf8)
  Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue

  $q = { param($s) "'" + ([string]$s).Replace("'", "''") + "'" }
  $workerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'),
    '-Worker', '-Port', $Port, '-TimeoutSeconds', $TimeoutSeconds, '-PortFrom', $PortFrom, '-PortTo', $PortTo,
    '-StartTimeoutSeconds', $StartTimeoutSeconds, '-FollowSeconds', $FollowSeconds)
  $argList = ($workerArgs | ForEach-Object { & $q $_ }) -join ','
  # $PID inside the intermediate is evaluated there: the worker waits for it to be gone.
  $inner = "Start-Process " + (& $q $psExe) + " -WindowStyle Hidden -ArgumentList $argList,'-ParentPid',`$PID"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
  $mid = Start-Process $psExe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
  $null = $mid.Handle
  if (-not $mid.WaitForExit(30000)) {
    Write-Host 'No se pudo lanzar el reinicio (el intermedio no termino).' -ForegroundColor Yellow
    exit 1
  }
  if ($mid.ExitCode -ne 0) {
    Write-Host "No se pudo lanzar el reinicio (el intermedio salio con codigo $($mid.ExitCode))." -ForegroundColor Yellow
    exit 1
  }
  $launched = Get-Date

  $pos = 0L
  $deadline = (Get-Date).AddSeconds($FollowSeconds)
  $drain = {
    try {
      $fs = New-Object IO.FileStream($logFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      try {
        if ($fs.Length -lt $script:pos) { $script:pos = 0L }
        $null = $fs.Seek($script:pos, [IO.SeekOrigin]::Begin)
        $buf = New-Object byte[] ($fs.Length - $script:pos)
        $n = $fs.Read($buf, 0, $buf.Length)
        $script:pos += $n
        if ($n -gt 0) { Write-Host -NoNewline ($utf8.GetString($buf, 0, $n)) }
      } finally { $fs.Dispose() }
    } catch { }
  }
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $resultFile) { break }
    & $drain
    # The worker's first line comes within seconds; silence means it never started.
    if ($pos -eq 0 -and ((Get-Date) - $launched).TotalSeconds -gt 30) {
      Write-Host 'El reinicio no arranco: el proceso de fondo no escribio nada en 30 s (ver hfs-monitor.restart.log).' -ForegroundColor Yellow
      exit 1
    }
    Start-Sleep -Milliseconds 300
  }
  & $drain
  if (-not (Test-Path -LiteralPath $resultFile)) {
    Write-Host "El reinicio no termino en $FollowSeconds s; sigue en segundo plano (ver hfs-monitor.restart.log)." -ForegroundColor Yellow
    exit 1
  }
  $code = 1
  try {
    $parsed = 0
    if ([int]::TryParse(([IO.File]::ReadAllText($resultFile)).Trim(), [ref]$parsed)) { $code = $parsed }
  } catch { }
  exit $code
}

# ---- Worker.
function Say([string]$text) {
  Write-Host $text
  try { [IO.File]::AppendAllText($logFile, $text + "`r`n", $utf8) } catch { }
}

function Finish([int]$code) {
  # Atomic: the front must never read a half-written (empty) result.
  try {
    $tmp = $resultFile + '.tmp'
    [IO.File]::WriteAllText($tmp, [string]$code, $utf8)
    Move-Item -LiteralPath $tmp -Destination $resultFile -Force
  } catch { }
  exit $code
}

function Get-LivePid {
  try {
    $raw = ([IO.File]::ReadAllText($pidFile)).Trim()
    $n = 0
    if ($raw -match '^\d+$' -and [int]::TryParse($raw, [ref]$n) -and $n -gt 0 -and (Get-Process -Id $n -ErrorAction SilentlyContinue)) { return $n }
  } catch { }
  return 0
}

# Runs a script in a child PowerShell; its output goes to files (never a pipe:
# an old start.ps1 leaves a board that inherits the handle and would keep a pipe
# open), then is echoed. Returns the exit code, 1 on a timeout.
function Invoke-Script([string]$name, [string[]]$extra, [int]$limitSeconds) {
  $o = Join-Path $root ".hfs-monitor.restart.$name.out"
  $e = Join-Path $root ".hfs-monitor.restart.$name.err"
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root $name) + '"')) + $extra
  $p = Start-Process $psExe -WindowStyle Hidden -PassThru -ArgumentList $argv -RedirectStandardOutput $o -RedirectStandardError $e
  $null = $p.Handle
  $done = $p.WaitForExit($limitSeconds * 1000)
  foreach ($f in @($o, $e)) {
    if (Test-Path -LiteralPath $f) {
      foreach ($line in (Get-Content -LiteralPath $f -Encoding UTF8 -ErrorAction SilentlyContinue)) { if ($line) { Say $line } }
      Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $done) { Say "$name no termino en $limitSeconds s."; return 1 }
  return $p.ExitCode
}

function Show-ErrTail {
  if (Test-Path -LiteralPath $errLog) {
    Say 'Ultimas lineas de hfs-monitor.err.log:'
    foreach ($line in (Get-Content -LiteralPath $errLog -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue)) { Say $line }
  } else {
    Say 'No hay hfs-monitor.err.log.'
  }
}

try {
  $mutex = New-Object Threading.Mutex($false, $mutexName)
  $held = $false
  try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
  # Lost the race: touch neither the log nor the result, they belong to the other one.
  if (-not $held) { exit 1 }
  [IO.File]::WriteAllText($logFile, '', $utf8)
  Say 'Reiniciando el tablero...'

  # The intermediate must be gone before anything is stopped.
  if ($ParentPid -gt 0) {
    $w = [Diagnostics.Stopwatch]::StartNew()
    while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and $w.Elapsed.TotalSeconds -lt 15) { Start-Sleep -Milliseconds 100 }
  }

  $stopCode = Invoke-Script 'stop.ps1' @('-PortFrom', $PortFrom, '-PortTo', $PortTo, '-BoardPort', $Port) ($TimeoutSeconds + 60)
  if ($stopCode -ne 0) { Finish $stopCode }

  # Starting before Windows releases the listener fails with EADDRINUSE, and the
  # failure looks like "the board is broken" rather than "it started too soon".
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $busy = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if (-not $busy) { break }
    Start-Sleep -Milliseconds 400
  }
  if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    Say "El puerto $Port sigue ocupado tras $TimeoutSeconds s. Revisa que proceso lo tiene."
    Finish 1
  }

  $startCode = Invoke-Script 'start.ps1' @() ($FollowSeconds)
  if ($startCode -ne 0 -and $startCode -ne 2) { Say "start.ps1 fallo (codigo $startCode)."; Show-ErrTail; Finish 1 }

  # Back only when the board answers; give up at once if its process is gone.
  $ok = $false
  $why = ''
  $boardPid = 0
  $deadline = (Get-Date).AddSeconds($StartTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $boardPid = Get-LivePid
    if ($boardPid -eq 0) { $why = 'el proceso del tablero ya no existe'; break }
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$Port/api/upgrade"
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  if (-not $ok) {
    if (-not $why) { $why = "no respondio en $StartTimeoutSeconds s" }
    Say "El tablero no responde en http://localhost:$Port ($why)."
    Show-ErrTail
    Finish 1
  }
  Say "El tablero responde en http://localhost:$Port (PID $boardPid)."
  if ($startCode -eq 2) { Finish 2 }
  Finish 0
} catch {
  Say ("Fallo inesperado en el reinicio: " + $_.Exception.Message)
  Finish 1
}
