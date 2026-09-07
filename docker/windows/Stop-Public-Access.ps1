[CmdletBinding()]
param([string] $ProjectRoot = $(Join-Path $PSScriptRoot '..\..'))

$ErrorActionPreference = 'Stop'
$publisherRoot = Join-Path $env:LOCALAPPDATA 'Omnichannel'
$stateDir = Join-Path $publisherRoot 'tunnel'
$cloudflaredExe = Join-Path $publisherRoot 'cloudflared\cloudflared.exe'
$stopped = 0

foreach ($name in @('gateway', 'chatwoot')) {
  $pidFile = Join-Path $stateDir "$name.pid"
  if (-not [IO.File]::Exists($pidFile)) { continue }

  $storedPid = 0
  if ([int]::TryParse(([IO.File]::ReadAllText($pidFile)).Trim(), [ref]$storedPid)) {
    $process = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'cloudflared') {
      $sameExecutable = $false
      try { $sameExecutable = [IO.Path]::GetFullPath($process.Path) -eq [IO.Path]::GetFullPath($cloudflaredExe) } catch {}
      if ($sameExecutable) {
        Stop-Process -Id $storedPid -Force
        $stopped++
      }
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

$manifestFile = Join-Path $stateDir 'omnichannel-endpoint.json'
if ([IO.File]::Exists($manifestFile)) {
  try {
    $manifest = [IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json
    $manifest.online = $false
    $manifest.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    [IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  } catch {}
}

Write-Host "Acessos publicos encerrados: $stopped processo(s)."
