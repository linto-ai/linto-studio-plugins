# Start the Live Captions Server
# This script starts the standalone server for Teams Live Captions on port 443

$ErrorActionPreference = "Stop"

Write-Host "=== Starting Live Captions Server ===" -ForegroundColor Cyan

# Set the environment
$env:ASPNETCORE_ENVIRONMENT = "Production"

# Project path
$projectPath = Join-Path $PSScriptRoot "src\LiveCaptionsServer"
$dllPath = Join-Path $projectPath "bin\Release\net8.0\LiveCaptionsServer.dll"

# Check if built
if (-not (Test-Path $dllPath)) {
    Write-Host "Building LiveCaptionsServer..." -ForegroundColor Yellow
    Push-Location $projectPath
    dotnet build --configuration Release
    Pop-Location
}

# Check wwwroot files
$wwwrootPath = Join-Path $projectPath "bin\Release\net8.0\wwwroot"
if (-not (Test-Path $wwwrootPath)) {
    Write-Host "WARNING: wwwroot not found at $wwwrootPath" -ForegroundColor Yellow
    Write-Host "Copying from TeamsMediaBot..." -ForegroundColor Yellow

    $sourcewwwroot = Join-Path $PSScriptRoot "src\TeamsMediaBot\wwwroot"
    if (Test-Path $sourcewwwroot) {
        Copy-Item -Path $sourcewwwroot -Destination $wwwrootPath -Recurse -Force
        Write-Host "wwwroot copied successfully" -ForegroundColor Green
    } else {
        Write-Host "ERROR: Source wwwroot not found. Please build the React client first." -ForegroundColor Red
        Write-Host "Run: cd src\TeamsMediaBot\client-app && npm install && npm run build" -ForegroundColor Yellow
        exit 1
    }
}

Write-Host ""
Write-Host "Configuration:" -ForegroundColor Cyan
Write-Host "  Port: 443 (HTTPS)"
Write-Host "  MQTT Broker: 176.165.40.47:1883"
Write-Host "  Certificate: F1CC6D08925009C92F9236B785C63406E1EC2B5E"
Write-Host ""

# Start the server
Write-Host "Starting server..." -ForegroundColor Green
Push-Location $projectPath
dotnet run --configuration Release --no-build
Pop-Location
