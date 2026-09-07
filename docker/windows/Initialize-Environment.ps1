[CmdletBinding()]
param(
  [string] $Path,
  [string] $ProjectRoot = $(if ($Path) { [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)) } else { Join-Path $PSScriptRoot '..\..' })
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateData.Common.ps1')

$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  function New-Secret([int] $Size) {
    $bytes = New-Object byte[] $Size
    $random.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  }

  $project = [IO.Path]::GetFullPath($ProjectRoot)
  $paths = Get-OmnichannelEnvironmentPaths -ProjectRoot $project
  Initialize-OmnichannelDataFolders -DataRoot $paths.DataRoot

  $legacyPath = Join-Path $project '.env'
  $legacy = Read-OmnichannelEnvFile -Path $legacyPath
  $platform = Read-OmnichannelEnvFile -Path $paths.Platform
  $machine = Read-OmnichannelEnvFile -Path $paths.Machine
  $existingInstallation = $legacy.Count -gt 0 -or $platform.Count -gt 0

  foreach ($entry in $legacy.GetEnumerator()) {
    if ($entry.Key -eq 'OMNICHANNEL_DATA_ROOT') { continue }
    if ($entry.Key -like 'MEGA_*') { $machine[$entry.Key] = $entry.Value }
    elseif (-not $platform.ContainsKey($entry.Key)) { $platform[$entry.Key] = $entry.Value }
  }
  foreach ($key in @($platform.Keys)) {
    if ($key -like 'MEGA_*') {
      if (-not $machine[$key]) { $machine[$key] = $platform[$key] }
      $platform.Remove($key)
    } elseif ($key -eq 'OMNICHANNEL_DATA_ROOT') {
      $platform.Remove($key)
    }
  }

  $defaults = @{
    POSTGRES_PASSWORD = New-Secret 24
    GATEWAY_ENCRYPTION_KEY = New-Secret 32
    ADMIN_TOKEN = New-Secret 32
    COMMERCIAL_EVENTS_TOKEN = New-Secret 32
    N8N_ENCRYPTION_KEY = New-Secret 32
    EMBEDDING_PROVIDER = 'local'
    CHATWOOT_SECRET_KEY_BASE = New-Secret 48
    CHATWOOT_FRONTEND_URL = 'http://localhost:3000'
    CHATWOOT_ADMIN_EMAIL = 'admin@example.local'
    CHATWOOT_ADMIN_PASSWORD = "$(New-Secret 18)!Aa1"
    GOOGLE_OAUTH_CLIENT_ID = ''
    GOOGLE_OAUTH_CLIENT_SECRET = ''
    GOOGLE_OAUTH_CALLBACK_URL = ''
  }
  foreach ($entry in $defaults.GetEnumerator()) {
    if (-not $platform[$entry.Key]) { $platform[$entry.Key] = $entry.Value }
  }
  if (-not $platform['COMPOSE_PROJECT_NAME']) {
    $platform['COMPOSE_PROJECT_NAME'] = if ($existingInstallation) {
      'omnichannel-platform'
    } else {
      'omnichannel-' + [guid]::NewGuid().ToString('N').Substring(0, 10)
    }
  }
  if ($platform['CHATWOOT_ADMIN_PASSWORD'] -notmatch '[!@#$%^&*()_+\-=\[\]{}|"/\\.,`<>:;?~]') {
    $platform['CHATWOOT_ADMIN_PASSWORD'] = "$(New-Secret 18)!Aa1"
  }

  $machineDefaults = @{
    MEGA_SYNC_ENABLED = 'false'
    MEGA_USER = ''
    MEGA_PASS_DPAPI = ''
    MEGA_REMOTE_PATH = 'omnichannel-private/private-data'
  }
  foreach ($entry in $machineDefaults.GetEnumerator()) {
    if (-not $machine.ContainsKey($entry.Key)) { $machine[$entry.Key] = $entry.Value }
  }

  Set-OmnichannelEnvValues -ProjectRoot $project -Values $platform -Scope Platform
  Set-OmnichannelEnvValues -ProjectRoot $project -Values $machine -Scope Machine

  $localAppRoot = Join-Path $env:LOCALAPPDATA 'Omnichannel'
  [IO.Directory]::CreateDirectory($localAppRoot) | Out-Null
  [IO.File]::WriteAllText((Join-Path $localAppRoot 'data-root.txt'), $paths.DataRoot, [Text.UTF8Encoding]::new($false))
  $runtime = @(
    '@echo off'
    "set `"OMNICHANNEL_DATA_ROOT=$($paths.DataRoot)`""
    "set `"OMNICHANNEL_PLATFORM_ENV=$($paths.Platform)`""
    "set `"COMPOSE_ENV_FILES=$($paths.Platform)`""
  )
  [IO.File]::WriteAllLines((Join-Path $localAppRoot 'runtime.cmd'), $runtime, [Text.UTF8Encoding]::new($false))

  if ([IO.File]::Exists($legacyPath)) { Remove-Item -LiteralPath $legacyPath -Force }
  Write-Host "Dados privados: $($paths.DataRoot)"
} finally {
  $random.Dispose()
}
