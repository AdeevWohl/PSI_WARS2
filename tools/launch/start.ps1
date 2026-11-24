# Psi Wars launcher: builds the game, starts the server and opens the browser.
# With -Online it also opens a free Cloudflare Quick Tunnel and shows the link to share.
# Closing this window stops everything.
param([switch]$Online)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
$env:Path = "C:\Program Files\nodejs;C:\Program Files (x86)\cloudflared;C:\Program Files\cloudflared;$env:Path"
$Host.UI.RawUI.WindowTitle = 'Psi Wars - keep this window open while playing'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
  Say ''
  Say "PROBLEM: $text" 'Red'
  Say ''
  Read-Host 'Press Enter to close'
  exit 1
}

# Any unexpected error: show it and keep the window open instead of closing.
trap {
  Say ''
  Say "PROBLEM: $($_.Exception.Message)" 'Red'
  Say ''
  Read-Host 'Press Enter to close'
  exit 1
}

Say ''
Say '  PSI WARS' 'Cyan'
Say ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed. Install it from https://nodejs.org (the LTS version), then double-click this file again.' }

$port = 8787
try {
  Invoke-WebRequest -UseBasicParsing "http://localhost:$port/api/health" -TimeoutSec 2 | Out-Null
  Fail "Psi Wars is already running (another launcher window is open). Use that window, or close it and try again."
} catch [System.Net.WebException] { }

if (-not (Test-Path 'node_modules')) {
  Say 'First run: installing the game''s parts (one time only, takes a minute)...'
  & npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed. Check your internet connection and try again.' }
}

Say 'Building the game...'
# Run through cmd so build warnings on stderr are logged, not treated as a PowerShell error.
$buildLog = Join-Path $env:TEMP 'psiwars-build.log'
& cmd /c "npm run build --silent > `"$buildLog`" 2>&1"
if ($LASTEXITCODE -ne 0) { Fail "The build failed. Details are in $env:TEMP\psiwars-build.log" }

Say 'Starting the game server...'
$serverLog = Join-Path $env:TEMP 'psiwars-server.log'
$server = Start-Process -FilePath 'node' -ArgumentList '--import', 'tsx', 'packages/server-local/src/main.ts' -NoNewWindow -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err"
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try { Invoke-WebRequest -UseBasicParsing "http://localhost:$port/api/health" -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { }
  if ($server.HasExited) { break }
}
if (-not $ready) { Fail "The game server did not start. Details are in $serverLog.err" }

$link = "http://localhost:$port"
$tunnel = $null
if ($Online) {
  if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Say 'Installing Cloudflare''s tunnel tool (one time only)...'
    & winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements --silent | Out-Null
    $env:Path = "C:\Program Files (x86)\cloudflared;C:\Program Files\cloudflared;$env:Path"
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) { $server.Kill(); Fail 'Could not install cloudflared. Install it with: winget install --id Cloudflare.cloudflared' }
  }
  Say 'Opening the internet link (takes a few seconds)...'
  $tunnelLog = Join-Path $env:TEMP 'psiwars-tunnel.log'
  if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }
  $tunnel = Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://localhost:$port" -NoNewWindow -PassThru -RedirectStandardError $tunnelLog -RedirectStandardOutput "$tunnelLog.out"
  $public = $null
  for ($i = 0; $i -lt 60 -and -not $public; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $tunnelLog) {
      $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { $public = $m.Matches[0].Value }
    }
  }
  if (-not $public) { $tunnel.Kill(); $server.Kill(); Fail "Could not open the internet link. Details are in $tunnelLog" }
  # A new Quick Tunnel address takes up to a minute to become reachable; wait so the link works when shown.
  Say 'Almost ready, waiting for the link to go live...'
  for ($i = 0; $i -lt 45; $i++) {
    try { Invoke-WebRequest -UseBasicParsing "$public/api/health" -TimeoutSec 5 | Out-Null; break } catch { Start-Sleep -Seconds 2 }
  }
  $link = $public
  try { Set-Clipboard -Value $link } catch { }
}

Start-Process $link
Say ''
Say '  ====================================================' 'Green'
if ($Online) {
  Say '   The game is online. Send this link to your friends:' 'Green'
  Say ''
  Say "   $link" 'Yellow'
  Say ''
  Say '   (It is already copied - just paste it in a message.)' 'Green'
  Say '   Then: Host Game -> Copy invite link -> send it.' 'Green'
} else {
  Say '   The game is running at:' 'Green'
  Say ''
  Say "   $link" 'Yellow'
  Say ''
  Say '   Play vs AI and Hot-seat work on this computer.' 'Green'
  Say '   To play with friends elsewhere, use "Start Psi Wars Online".' 'Green'
}
Say '  ====================================================' 'Green'
Say ''
Say '  Keep this window open while you play. Close it to stop the game.' 'Cyan'
Say ''

try {
  while (-not $server.HasExited) {
    if ($tunnel -and $tunnel.HasExited) { Say 'The internet link closed. Close this window and start again for a new link.' 'Red'; break }
    Start-Sleep -Seconds 2
  }
  if ($server.HasExited) { Say "The game server stopped. Details are in $serverLog.err" 'Red' }
} finally {
  foreach ($p in @($tunnel, $server)) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch { } } }
}
Read-Host 'Press Enter to close'
