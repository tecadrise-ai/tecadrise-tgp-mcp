<#
.SYNOPSIS
  Start the TGP canvas server hidden in the background (if it is not already running)
  and open the run list in the browser.
.DESCRIPTION
  Port: -Port, else $env:TGP_PORT, else "port" in %USERPROFILE%\.tgp\config.json (or $env:TGP_HOME), else 8787.
  The server keeps running after this window closes. Output goes to serve.log and serve.err.log.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1
  powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1 -Port 8788 -NoBrowser
#>
param(
  [int]$Port = 0,
  [string]$BindHost = '127.0.0.1',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'tgp-port.ps1')
if ($Port -eq 0) { $Port = Get-TgpPort }
$url = "http://localhost:$Port/"
$pidFile = Join-Path $root 'serve.pid'
$log = Join-Path $root 'serve.log'
$errLog = Join-Path $root 'serve.err.log'

if (Test-TgpServer $Port) {
  Write-Output "TGP server already running at $url"
} else {
  if (Test-PortInUse $Port) {
    Write-Error "Port $Port is used by another program (not TGP). Pick another port, for example: -Port 8788, or set it in $(Join-Path (Get-TgpHome) 'config.json') as {`"port`": 8788}"
  }
  $node = (Get-Command node -ErrorAction Stop).Source
  $bin = Join-Path $root 'bin\tgp.js'
  # Win32_Process.Create starts the server outside this shell (no inherited handles, no job object),
  # so it survives the terminal closing and callers that capture output do not hang.
  $cmdLine = "cmd.exe /d /c `"`"$node`" `"$bin`" serve --port $Port --host $BindHost > `"$log`" 2> `"$errLog`"`""
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmdLine; CurrentDirectory = $root; ProcessStartupInformation = $startup }
  if ($res.ReturnValue -ne 0) { Write-Error "Could not start the TGP server (Win32_Process.Create returned $($res.ReturnValue))" }
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; if (Test-TgpServer $Port) { $ok = $true; break } }
  if (-not $ok) { Write-Error "TGP server did not come up on port $Port. See $log and $errLog" }
  $nodePid = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
  Set-Content -Path $pidFile -Value $nodePid -Encoding ascii
  Write-Output "TGP server started (pid $nodePid) at $url, log: $log"
}
if (-not $NoBrowser) { Start-Process $url }
