param(
  # Ports the board hands out: stack servers (18080-18200) and e2e blocks
  # (18300-18900). Never the 8080/8090 of the main checkout, which is why this
  # cleans up by PORT and never by process name: hfs.exe is the same image.
  #
  # ASCII only, deliberately. Windows PowerShell reads a BOM-less .ps1 as
  # Windows-1252, where the third byte of a UTF-8 em dash decodes to a curly
  # closing quote and silently terminates a string - which broke this script.
  [int]$PortFrom = 18080,
  [int]$PortTo = 18900,
  # Skips the upgrade lock: upgrade.ps1 runs the port sweep while it holds it.
  [switch]$Force,
  # The port the board listens on; 0 reads config.json (7420 if it says nothing).
  [int]$BoardPort = 0,
  # By default a board that ANSWERS "I could not save" (disk full, a scanner holding
  # the file) is left running: closing it would lose what it holds in memory.
  [switch]$IgnoreSaveFailure
)

$root = $PSScriptRoot
$pidFile = Join-Path $root '.hfs-monitor.pid'

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
  # Is this pid the board? Same test as start.ps1 (contract C1): a positive
  # integer, a live process named node, started no later than the pid file was
  # written (+5 s). A pid Windows handed out again started AFTER the file.
  $raw = ''
  try { $raw = ([IO.File]::ReadAllText($pidFile)).Trim() } catch { }
  $procId = 0
  $isBoard = $false
  if ($raw -match '^\d+$' -and [int]::TryParse($raw, [ref]$procId) -and $procId -gt 0) {
    $bp = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($bp -and $bp.ProcessName -eq 'node') {
      try {
        $written = (Get-Item -LiteralPath $pidFile).LastWriteTime
        if ($bp.StartTime -le $written.AddSeconds(5)) { $isBoard = $true }
      } catch { }
    }
  }
  if ($isBoard) {
    # Ask the board to save first: taskkill /F skips every exit handler, and the
    # store keeps the last few seconds of changes in memory. The call answers once
    # the files are written. If the board does not answer at all it is closed anyway
    # (it could not save in any case); if it answers that the save FAILED it is left
    # running, loudly, unless -IgnoreSaveFailure.
    # The port, as the board reads it: HFSMON_CONFIG (or config.json), then the
    # config.local.json beside it.
    $boardPort = 7420
    $cfgFile = $env:HFSMON_CONFIG
    if (-not $cfgFile) { $cfgFile = Join-Path $root 'config.json' }
    $localFile = [regex]::Replace($cfgFile, '\.json$', '.local.json')
    foreach ($f in @($cfgFile, $localFile)) {
      try {
        $cfg = [IO.File]::ReadAllText($f) | ConvertFrom-Json
        if ($cfg.port) { $boardPort = [int]$cfg.port }
      } catch { }
    }
    if ($BoardPort -gt 0) { $boardPort = $BoardPort }
    $saved = $false
    $refused = $false
    for ($try = 1; $try -le 2 -and -not $saved; $try++) {
      try {
        $r = Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 20 -Uri "http://127.0.0.1:$boardPort/api/flush"
        Write-Host "El tablero guardo sus datos (HTTP $($r.StatusCode))."
        $saved = $true
      } catch {
        $code = 0
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($code -eq 500) {
          # 500 is the board saying it tried and could not; any other answer (404 from a
          # build without the route, 401/403) means no save was asked for: close as before.
          $refused = $true
          $detail = ''
          try { $detail = $_.ErrorDetails.Message } catch { }
          Write-Host "!! EL TABLERO NO PUDO GUARDAR SUS DATOS (intento $try de 2): $detail"
          if ($try -lt 2) { Start-Sleep -Seconds 2 }
        } else {
          Write-Host "No se pudo pedir al tablero que guarde ($($_.Exception.Message)); se cierra igualmente."
          break
        }
      }
    }
    if ($refused -and -not $saved -and -not $IgnoreSaveFailure) {
      Write-Host "!! El tablero (PID $procId) sigue corriendo para no perder lo que tiene en memoria. Libera el disco o el archivo bloqueado y repite, o usa -IgnoreSaveFailure para cerrarlo igualmente."
      exit 3
    }
    # /T also kills the claude / npm / playwright children of active phases
    taskkill /PID $procId /T /F | Out-Null
    Write-Host "hfs-monitor detenido (PID $procId)."
  } else {
    Write-Host "Archivo .pid obsoleto (PID $raw no es el tablero); se borra."
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Host 'hfs-monitor no esta corriendo (no hay archivo .pid).'
}

# Playwright's own webServers (boot.mjs -> hfs.exe) can outlive the tree kill and
# keep holding their port. Only listeners inside the board's ranges are touched.
Start-Sleep -Seconds 2
$orphans = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge $PortFrom -and $_.LocalPort -le $PortTo } |
  Select-Object -ExpandProperty OwningProcess -Unique

if ($orphans) {
  foreach ($orphanPid in $orphans) {
    $p = Get-Process -Id $orphanPid -ErrorAction SilentlyContinue
    if ($p) {
      Write-Host ("  huerfano en los puertos del board: {0} (PID {1}) - cerrando" -f $p.ProcessName, $orphanPid)
      Stop-Process -Id $orphanPid -Force -ErrorAction SilentlyContinue
    }
  }
} else {
  Write-Host 'Sin procesos huerfanos en los puertos del board.'
}

exit 0
