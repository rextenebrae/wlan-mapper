# Statischer Dateiserver fuer WLAN-Mapper
param([int]$Port = 3620)

$root = Split-Path $PSScriptRoot -Parent
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "WLAN-Mapper laeuft auf http://localhost:$Port  (Strg+C zum Beenden)"

$mimeTypes = @{
  '.html'        = 'text/html; charset=utf-8'
  '.css'         = 'text/css'
  '.js'          = 'application/javascript'
  '.json'        = 'application/json'
  '.webmanifest' = 'application/manifest+json'
  '.png'         = 'image/png'
  '.jpg'         = 'image/jpeg'
  '.svg'         = 'image/svg+xml'
  '.ico'         = 'image/x-icon'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response

  $urlPath = $req.Url.LocalPath
  if ($urlPath -eq '/') { $urlPath = '/index.html' }

  $filePath = Join-Path $root $urlPath.TrimStart('/')

  if (Test-Path $filePath -PathType Leaf) {
    $ext  = [System.IO.Path]::GetExtension($filePath)
    $mime = if ($mimeTypes[$ext]) { $mimeTypes[$ext] } else { 'application/octet-stream' }
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $res.ContentType     = $mime
    $res.ContentLength64 = $bytes.Length
    $res.StatusCode      = 200
    $res.Headers.Add('Cache-Control', 'no-cache')
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
    $res.StatusCode      = 404
    $res.ContentType     = 'text/plain'
    $res.ContentLength64 = $msg.Length
    $res.OutputStream.Write($msg, 0, $msg.Length)
  }
  $res.OutputStream.Close()
}
