param(
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $repo "edge-bridge\extension"
$project = Join-Path $repo "edge-bridge\host\RawEdgeBridge.csproj"
$installRoot = Join-Path $env:USERPROFILE ".raw\edge-bridge"
$publish = Join-Path $installRoot ("host-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$configDir = Join-Path $env:USERPROFILE ".raw"
$configPath = Join-Path $configDir "edge-bridge.json"
$nativeManifest = Join-Path $installRoot "com.raw.edge_bridge.json"
$extensionId = "gfpadofoapicldopjkghnfbnbkljihmk"

New-Item -ItemType Directory -Path $publish -Force | Out-Null
dotnet publish $project -c $Configuration -o $publish --nologo
if ($LASTEXITCODE -ne 0) { throw "edge bridge host build failed" }

New-Item -ItemType Directory -Path $configDir -Force | Out-Null
if (Test-Path -LiteralPath $configPath) {
  $bridgeConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
} else {
  $bytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  $bridgeConfig = [pscustomobject]@{ version = 1; token = $token; port = 9333 }
  $bridgeConfig | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
}

$hostExe = Join-Path $publish "raw-edge-bridge.exe"
$manifest = [ordered]@{
  name = "com.raw.edge_bridge"
  description = "Local bridge between Raw and the user's Edge profile"
  path = $hostExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$extensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $nativeManifest -Encoding UTF8

$registryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.raw.edge_bridge"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $nativeManifest

# The extension reconnects automatically and starts the newly registered host.
Get-Process raw-edge-bridge -ErrorAction SilentlyContinue | Stop-Process -Force

[pscustomobject]@{
  ExtensionId = $extensionId
  ExtensionPath = $extension
  HostPath = $hostExe
  NativeManifest = $nativeManifest
  ConfigPath = $configPath
} | ConvertTo-Json
