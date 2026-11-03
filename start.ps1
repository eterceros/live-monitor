# ASCII only: Windows PowerShell reads a BOM-less .ps1 as Windows-1252, where a
# UTF-8 dash decodes to a curly quote and ends a string early.
#
# Exit codes: 0 = the board process is up; 1 = it did not start (or was refused:
# upgrade lock, already running); 2 = it is up, but npm ci or the web build
# failed, so it runs on whatever web/dist there was.
param(
  # Skips the upgrade lock: upgrade.ps1 starts the board while it holds it.
  [switch]$Force,
  # Internal: only launches the board and writes the pid file. The normal path
  # runs this in a hidden window that inherits no handles (see below).
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pidFile = Join-Path $root '.hfs-monitor.pid'
$logFile = Join-Path $root 'hfs-monitor.log'
$errFile = Join-Path $root 'hfs-monitor.err.log'

if ($Launch) {
  # Blind mode: no console, no redirects, nobody reads this output. Failures
  # go to the err log, which the front reads.
  $proc = $null
  try {
    # The board hands its environment to every Claude session it opens, so it
    # must not carry npm's or a calling Claude session's variables. Same list as
    # scriptEnv in server/src/upgrade.js; keep them in step. Windows env names
    # are case-insensitive, hence -match.
    foreach ($e in @(Get-ChildItem Env:)) {
      if ($e.Name -match '^(npm_|INIT_CWD$|CLAUDECODE$|CLAUDE_CODE_|ANTHROPIC_)') {
        Remove-Item -LiteralPath ("Env:" + $e.Name) -ErrorAction SilentlyContinue
      }
    }
    $proc = Start-Process node -ArgumentList '--max-old-space-size=8192', 'src/index.js' `
      -WorkingDirectory (Join-Path $root 'server') `
      -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $logFile `
      -RedirectStandardError $errFile
    $proc.Id | Out-File $pidFile -Encoding ascii
    exit 0
  } catch {
    $launchError = $_ | Out-String
    # Node may be up without a pid file (Out-File threw): it is the process this
    # script just started, so kill it by its own pid rather than leave it unrecorded.
    if ($proc) { try { $proc.Kill() } catch { } }
    try {
      [IO.File]::AppendAllText($errFile, "start.ps1 -Launch: $launchError`r`n", (New-Object Text.UTF8Encoding($false)))
    } catch { }
    exit 1
  }
}

# C1: is the pid in this file the board? It is only if the content is a
# positive integer, the process exists, it is node, and it started no later
# than the file's last write plus 5 s (a pid Windows handed out again started
# after the file was written). Returns @{ Ok; Pid; Text }.
function Test-BoardPidFile($file) {
  $text = ''
  try { $text = ([string](Get-Content -LiteralPath $file -Raw)).Trim() } catch { }
  $id = 0
  $ok = $false
  if ($text -match '^\d+$' -and [int]::TryParse($text, [ref]$id) -and $id -gt 0) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') {
      try {
        $written = (Get-Item -LiteralPath $file).LastWriteTime
        if ($p.StartTime -le $written.AddSeconds(5)) { $ok = $true }
      } catch { }
    }
  }
  return @{ Ok = $ok; Pid = $id; Text = $text }
}

# upgrade.ps1 holds this lock while it stops, updates and restarts the board.
$lockFile = Join-Path $root '.hfs-monitor.upgrading'
if (-not $Force -and (Test-Path -LiteralPath $lockFile)) {
  $lockPid = 0
  $lockAlive = $false
  try {
    $lock = [IO.File]::ReadAllText($lockFile) | ConvertFrom-Json
    $lockPid = [int]$lock.pid
    $p = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
    if ($p) {
      $lockAlive = $true
      # A pid Windows handed out again after the script died started later.
      try {
        if ($lock.startedAt -and $p.StartTime.ToUniversalTime() -gt ([datetime]$lock.startedAt).ToUniversalTime().AddSeconds(5)) { $lockAlive = $false }
      } catch { }
    }
  } catch { }
  if ($lockAlive) {
    Write-Host "El tablero se esta actualizando (pid $lockPid); espera o usa -Force"
    exit 1
  }
  Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
  Write-Host "Borrado un .hfs-monitor.upgrading huerfano (pid $lockPid ya no existe)."
}

if (Test-Path -LiteralPath $pidFile) {
  $chk = Test-BoardPidFile $pidFile
  if ($chk.Ok) {
    Write-Host "hfs-monitor ya esta corriendo (PID $($chk.Pid)). Usa stop.ps1 primero."
    exit 1
  }
  Write-Host "Archivo .pid obsoleto (PID $($chk.Text) no es el tablero); se borra."
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

# A failing native command does not stop the script: check $LASTEXITCODE. Not
# 'Stop' here, so npm's stderr can never turn into a terminating error.
$warnings = @()
$ErrorActionPreference = 'Continue'

# Runs npm and returns $null on success or a warning line. A missing npm is a
# failure of its own, not a stale $LASTEXITCODE.
function Invoke-Npm($what, $consequence, [string[]]$npmArgs) {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    return "AVISO: no se encontro npm en el PATH; $what no se hizo ($consequence)."
  }
  $global:LASTEXITCODE = 0
  & npm @npmArgs | Out-Host
  if ($LASTEXITCODE -ne 0) { return "AVISO: $what fallo (codigo $LASTEXITCODE); $consequence." }
  return $null
}

if (-not (Test-Path (Join-Path $root 'server\node_modules'))) {
  Write-Host 'Instalando dependencias del servidor...'
  $w = Invoke-Npm 'npm ci del servidor' 'el tablero arranca igualmente' @('ci', '--prefix', (Join-Path $root 'server'))
  if ($w) { $warnings += $w }
}
if (-not (Test-Path (Join-Path $root 'web\node_modules'))) {
  Write-Host 'Instalando dependencias del frontend...'
  $w = Invoke-Npm 'npm ci del frontend' 'el tablero arranca igualmente' @('ci', '--prefix', (Join-Path $root 'web'))
  if ($w) { $warnings += $w }
}

Write-Host 'Compilando el frontend...'
$w = Invoke-Npm 'la compilacion del frontend' 'el tablero arranca con el web/dist que hubiera' @('run', 'build', '--prefix', (Join-Path $root 'web'))
if ($w) { $warnings += $w }
$ErrorActionPreference = 'Stop'
foreach ($w in $warnings) { Write-Host $w }

# Launch through a hidden powershell with NO redirects: that goes through
# ShellExecute, so the child inherits none of this process's handles. Launching
# the board from here with -Redirect* makes it inherit the caller's stdout pipe
# and `start.ps1 | something` would hang for as long as the board lives.
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
$ps = Join-Path $PSHOME 'powershell.exe'
$launcher = Start-Process $ps -WindowStyle Hidden -PassThru -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Launch')
$null = $launcher.Handle
$finished = $launcher.WaitForExit(30000)
$why = ''
if (-not $finished) {
  try { $launcher.Kill() } catch { }
  $chk = $null
  if (Test-Path -LiteralPath $pidFile) { $chk = Test-BoardPidFile $pidFile }
  if ($chk -and $chk.Ok) {
    # The board is up and recorded; only the launcher overstayed. Say so.
    Write-Host "El lanzador tardo mas de 30 s y se corto, pero el tablero (PID $($chk.Pid)) esta vivo y registrado."
  } else {
    $why = 'el lanzador no termino en 30 s y no dejo un .pid valido'
  }
} elseif (-not (Test-Path -LiteralPath $pidFile)) {
  $why = "el lanzador termino (codigo $($launcher.ExitCode)) sin escribir el archivo .pid"
} else {
  $chk = Test-BoardPidFile $pidFile
  if (-not $chk.Ok) { $why = "el PID $($chk.Text) no es un proceso node vivo" }
}
if ($why) {
  Write-Host "hfs-monitor no arranco: $why."
  if (Test-Path -LiteralPath $errFile) {
    Write-Host "--- cola de hfs-monitor.err.log ---"
    Get-Content -LiteralPath $errFile -Tail 20 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
  }
  exit 1
}

Write-Host "hfs-monitor iniciado (PID $($chk.Pid)) -> http://localhost:7420"
if ($warnings.Count -gt 0) {
  foreach ($w in $warnings) { Write-Host $w }
  exit 2
}
