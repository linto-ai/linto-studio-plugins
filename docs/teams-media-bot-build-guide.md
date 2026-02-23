# TeamsMediaBot — Build & Distribution Guide

This document describes how to build the TeamsMediaBot as a self-contained binary, package it for distribution, and configure the Session-API to serve it to manual deployments.

## Prerequisites

- **OS**: Windows 10/11 or Windows Server 2019+ (required — cross-compilation from Linux is not supported due to Media Foundation dependencies)
- **.NET 6.0 SDK** (not just the runtime)
- **Git**
- **PowerShell 5.1+**

## Build Instructions

### 1. Clone and restore

```powershell
git clone <repository-url>
cd emeeting/TeamsMediaBot
dotnet restore src/TeamsMediaBot.sln
```

### 2. Publish as self-contained binary

```powershell
dotnet publish src/TeamsMediaBot/TeamsMediaBot.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -o ./publish
```

This produces a standalone `win-x64` build in `./publish/` that does not require .NET to be installed on the target machine.

## Creating the Distribution Archive

The ZIP must have the following structure so that extraction into `C:\linto-studio-plugins\` places files at the correct paths:

```
TeamsMediaBot-v{version}-win-x64.zip
├── TeamsMediaBot/
│   ├── TeamsMediaBot.exe
│   ├── TeamsMediaBot.dll
│   ├── appsettings.json
│   └── *.dll (runtime + dependencies)
└── scripts/
    ├── configure-services.ps1
    └── phone-home.ps1
```

### Build the ZIP

```powershell
# From the repository root
$version = "1.0.0"  # or extract from RELEASE.md
$stagingDir = ".\staging"

# Prepare staging directory
New-Item -ItemType Directory -Force -Path "$stagingDir\TeamsMediaBot" | Out-Null
New-Item -ItemType Directory -Force -Path "$stagingDir\scripts" | Out-Null

# Copy published binaries
Copy-Item -Recurse -Force ".\TeamsMediaBot\publish\*" "$stagingDir\TeamsMediaBot\"

# Copy runtime scripts
Copy-Item ".\infra\media-host\scripts\configure-services.ps1" "$stagingDir\scripts\"
Copy-Item ".\infra\media-host\scripts\phone-home.ps1" "$stagingDir\scripts\"

# Create ZIP
Compress-Archive -Path "$stagingDir\*" -DestinationPath "TeamsMediaBot-v$version-win-x64.zip" -Force

# Cleanup
Remove-Item -Recurse -Force $stagingDir
```

## SHA256 Checksum

Generate the checksum after building:

```powershell
$hash = (Get-FileHash -Path "TeamsMediaBot-v$version-win-x64.zip" -Algorithm SHA256).Hash
Write-Host "SHA256: $hash"
```

Verify on the target machine:

```powershell
$expected = "<hash-from-build>"
$actual = (Get-FileHash -Path "TeamsMediaBot.zip" -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw "SHA256 mismatch!" }
```

## Publishing the Package

The package can be hosted in several ways:

| Method | `TEAMS_MEDIA_BOT_PACKAGE_URL` value |
|--------|--------------------------------------|
| GitHub Releases | `https://github.com/linagora/emeeting/releases/download/v1.0.0/TeamsMediaBot-v1.0.0-win-x64.zip` |
| Azure Blob Storage | `https://<account>.blob.core.windows.net/packages/TeamsMediaBot-v1.0.0-win-x64.zip` |
| Local file (mounted volume) | `/data/packages/TeamsMediaBot-v1.0.0-win-x64.zip` |

## Session-API Environment Variables

Set these on the Session-API container/service:

| Variable | Description | Example |
|----------|-------------|---------|
| `TEAMS_MEDIA_BOT_PACKAGE_URL` | URL or local path to the ZIP archive | `https://github.com/.../TeamsMediaBot-v1.0.0-win-x64.zip` |
| `TEAMS_MEDIA_BOT_PACKAGE_SHA256` | SHA256 hash of the ZIP | `a1b2c3d4...` |

These values are injected into the generated `setup-manual.ps1` script and also used by the `GET /integration-configs/:id/media-host-package` endpoint.

## CI Integration

### GitHub Actions Example

```yaml
name: Build TeamsMediaBot

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '6.0.x'

      - name: Restore
        run: dotnet restore emeeting/TeamsMediaBot/src/TeamsMediaBot.sln

      - name: Publish
        run: |
          dotnet publish emeeting/TeamsMediaBot/src/TeamsMediaBot/TeamsMediaBot.csproj `
            -c Release -r win-x64 --self-contained true -o ./publish

      - name: Package
        shell: pwsh
        run: |
          $version = "${{ github.ref_name }}"
          New-Item -ItemType Directory -Force -Path staging/TeamsMediaBot | Out-Null
          New-Item -ItemType Directory -Force -Path staging/scripts | Out-Null
          Copy-Item -Recurse -Force ./publish/* staging/TeamsMediaBot/
          Copy-Item emeeting/infra/media-host/scripts/configure-services.ps1 staging/scripts/
          Copy-Item emeeting/infra/media-host/scripts/phone-home.ps1 staging/scripts/
          Compress-Archive -Path staging/* -DestinationPath "TeamsMediaBot-$version-win-x64.zip"

      - name: Compute SHA256
        shell: pwsh
        run: |
          $hash = (Get-FileHash "TeamsMediaBot-${{ github.ref_name }}-win-x64.zip" -Algorithm SHA256).Hash
          Write-Host "SHA256: $hash"
          echo "PACKAGE_SHA256=$hash" >> $env:GITHUB_OUTPUT
        id: sha

      - name: Upload Release Asset
        uses: softprops/action-gh-release@v2
        with:
          files: TeamsMediaBot-${{ github.ref_name }}-win-x64.zip
```

### Jenkins Integration

For integration with the existing Jenkinsfile:

1. Extract the version from `RELEASE.md` (same pattern as `linto-deploy`)
2. Use a Windows agent or a Windows Docker container for the build
3. Publish the artifact to the configured storage (GitHub Releases, Azure Blob, or a mounted volume)
4. Update `TEAMS_MEDIA_BOT_PACKAGE_URL` and `TEAMS_MEDIA_BOT_PACKAGE_SHA256` in the deployment configuration

```groovy
stage('Build TeamsMediaBot') {
    agent { label 'windows' }
    steps {
        bat 'dotnet restore emeeting\\TeamsMediaBot\\src\\TeamsMediaBot.sln'
        bat 'dotnet publish emeeting\\TeamsMediaBot\\src\\TeamsMediaBot\\TeamsMediaBot.csproj -c Release -r win-x64 --self-contained true -o .\\publish'
        powershell '''
            $version = (Select-String -Path "RELEASE.md" -Pattern "^## (\\d+\\.\\d+\\.\\d+)").Matches[0].Groups[1].Value
            # ... package and compute SHA256 (same steps as above)
        '''
    }
}
```
