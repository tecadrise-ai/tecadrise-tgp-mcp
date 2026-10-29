<#
.SYNOPSIS
  Stop the TGP canvas server started by start-server.ps1 (or any tgp serve on the port).
  Other programs on the port are never touched.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stop-server.ps1
#>
param([int]$Port = 0)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'tgp-port.ps1')
if ($Port -eq 0) { $Port = Get-TgpPort }
$pidFile = Join-Path $root 'serve.pid'
$ids = @()
if (Test-Path $pidFile) { $ids += [int](Get-Content $pidFile -Raw).Trim() }
try {
  $ids += Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess
} catch { }
$stopped = 0
foreach ($id in ($ids | Sort-Object -Unique)) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  # only stop node processes that run tgp serve
  if ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -match 'tgp' -and $proc.CommandLine -match 'serve') {
    Stop-Process -Id $id -Force
    Write-Output "Stopped TGP server (pid $id)"
    $stopped++
  }
}
if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
if ($stopped -eq 0) { Write-Output "No TGP server was running on port $Port" }
