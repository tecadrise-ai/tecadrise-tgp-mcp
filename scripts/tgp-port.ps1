# Shared helpers for start-server.ps1 and stop-server.ps1 (dot-sourced).
function Get-TgpHome {
  if ($env:TGP_HOME) { return $env:TGP_HOME }
  return (Join-Path $env:USERPROFILE '.tgp')
}
function Get-TgpPort {
  if ($env:TGP_PORT) { return [int]$env:TGP_PORT }
  $cfg = Join-Path (Get-TgpHome) 'config.json'
  if (Test-Path $cfg) {
    try { $c = Get-Content $cfg -Raw | ConvertFrom-Json; if ($c.port) { return [int]$c.port } } catch { }
  }
  return 8787
}
function Test-TgpServer([int]$Port) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    return ($r.StatusCode -eq 200 -and $r.Content -match '"tgp_home"')
  } catch { return $false }
}
function Test-PortInUse([int]$Port) {
  try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) } catch { return $false }
}
