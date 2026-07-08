# WLAN-Mapper Signal-Agent
# Liest die aktuelle WLAN-Signalstaerke ueber `netsh wlan show interfaces` aus
# und stellt sie unter http://localhost:3999/signal als JSON bereit.
# Die Web-App erkennt den Agent automatisch (gruener Punkt oben rechts) und
# bietet im Messpunkt-Dialog "Wert vom Agent uebernehmen" an.
#
# Start:  powershell -NoProfile -ExecutionPolicy Bypass -File signal-agent.ps1
param([int]$Port = 3999)

function Get-WlanSignal {
  $out = netsh wlan show interfaces 2>$null
  if (-not $out) { return $null }

  $ssid = $null; $percent = $null
  foreach ($line in $out) {
    # SSID-Zeile (nicht BSSID); funktioniert fuer deutsche und englische Windows-Ausgabe
    if ($null -eq $ssid -and $line -match '^\s*SSID\s*:\s*(.+)$') { $ssid = $Matches[1].Trim() }
    if ($null -eq $percent -and $line -match '^\s*Signal\s*:\s*(\d+)\s*%') { $percent = [int]$Matches[1] }
  }
  if ($null -eq $percent) { return $null }

  # Uebliche Naeherung: 100 % ~ -50 dBm, 0 % ~ -100 dBm
  $dbm = [math]::Round(($percent / 2) - 100)
  return @{ percent = $percent; dbm = $dbm; ssid = $ssid }
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "WLAN-Mapper Signal-Agent laeuft auf http://localhost:$Port/signal  (Strg+C zum Beenden)"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  $res.Headers.Add('Access-Control-Allow-Origin', '*')
  $res.ContentType = 'application/json; charset=utf-8'

  if ($ctx.Request.Url.LocalPath -eq '/signal') {
    $sig = Get-WlanSignal
    if ($sig) {
      $json = $sig | ConvertTo-Json -Compress
      $res.StatusCode = 200
    } else {
      $json = '{"error":"Kein WLAN-Adapter verbunden"}'
      $res.StatusCode = 503
    }
  } else {
    $json = '{"error":"Unbekannter Pfad — /signal verwenden"}'
    $res.StatusCode = 404
  }

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.OutputStream.Close()
}
