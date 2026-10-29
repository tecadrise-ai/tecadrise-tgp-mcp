# TGP Windows toast. Called by src/notify.js in a hidden, detached Windows PowerShell 5.1
# (WinRT projection is not available in pwsh 7). Input comes as JSON in TGP_TOAST_JSON:
# {title, body, url, button, kind, tag, aumid, appName, icon, log}
# Uses the built-in ToastNotificationManager. The AppUserModelID is registered under
# HKCU\Software\Classes\AppUserModelId so the toast shows the TGP name and icon
# without a Start Menu shortcut. Clicking the toast or its button opens the url.
$ErrorActionPreference = 'Stop'
$p = $null
function Write-ToastLog([string]$msg) {
  try { if ($p -and $p.log) { Add-Content -LiteralPath $p.log -Value ("{0} [toast.ps1 {1}] {2}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'), $PID, $msg) -Encoding UTF8 } } catch { }
}
try {
  $p = $env:TGP_TOAST_JSON | ConvertFrom-Json
  $aumid = [string]$p.aumid
  $key = "HKCU:\Software\Classes\AppUserModelId\$aumid"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name DisplayName -Value ([string]$p.appName)
  if ($p.icon) { Set-ItemProperty -Path $key -Name IconUri -Value ([string]$p.icon) }
  Set-ItemProperty -Path $key -Name ShowInSettings -Value 1 -Type DWord

  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $e = { param($s) [System.Security.SecurityElement]::Escape([string]$s) }
  $url = [string]$p.url
  $launch = ''
  if ($url) { $launch = " activationType=`"protocol`" launch=`"$(& $e $url)`"" }
  # Same structure as TecAdRiseBot's Electron Notification (title + body, no icon): the legacy
  # ToastText02 template, no image, no attribution, no buttons, default duration. The small app icon
  # and name in the header come from the AppUserModelID registration. Only addition: an invisible
  # protocol launch so a click opens the canvas.
  $xml = "<toast$launch><visual><binding template=`"ToastText02`"><text id=`"1`">$(& $e $p.title)</text><text id=`"2`">$(& $e $p.body)</text></binding></visual></toast>"

  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  if ($p.tag) { $toast.Tag = [string]$p.tag; $toast.Group = 'tgp' }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
  Write-ToastLog ("shown {0}: {1}" -f $p.kind, $p.title)
  exit 0
} catch {
  Write-ToastLog ("toast failed: " + $_.Exception.Message)
  exit 1
}
