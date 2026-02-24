$ErrorActionPreference = "Stop"

Write-Host "=== LinTO Media Host Prerequisites Installation ==="

# Disable IE Enhanced Security
Write-Host "Disabling IE Enhanced Security..."
$adminKey = "HKLM:\SOFTWARE\Microsoft\Active Setup\Installed Components\{A509B1A7-37EF-4b3f-8CFC-4F3A74704073}"
if (Test-Path $adminKey) {
    Set-ItemProperty -Path $adminKey -Name "IsInstalled" -Value 0
}

# Create directories
Write-Host "Creating directories..."
$dirs = @(
    "C:\linto-studio-plugins\logs",
    "C:\linto-studio-plugins\certs",
    "C:\linto-studio-plugins\scripts",
    "C:\linto-studio-plugins\TeamsMediaBot"
)
foreach ($dir in $dirs) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# Install .NET Runtimes via official install script
Write-Host "Downloading .NET install script..."
$dotnetInstallScript = "$env:TEMP\dotnet-install.ps1"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri "https://dot.net/v1/dotnet-install.ps1" -OutFile $dotnetInstallScript

Write-Host "Installing .NET 6.0 Runtime..."
& $dotnetInstallScript -Channel 6.0 -Runtime dotnet -InstallDir "C:\Program Files\dotnet"

# Add dotnet to system PATH if not already there
$dotnetPath = "C:\Program Files\dotnet"
$currentPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($currentPath -notlike "*$dotnetPath*") {
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$dotnetPath", "Machine")
}

# Install win-acme
Write-Host "Installing win-acme..."
$winAcmeVersion = "2.2.9.1701"
$winAcmeUrl = "https://github.com/win-acme/win-acme/releases/download/v$winAcmeVersion/win-acme.v$winAcmeVersion.x64.pluggable.zip"
$winAcmeZip = "$env:TEMP\win-acme.zip"
Invoke-WebRequest -Uri $winAcmeUrl -OutFile $winAcmeZip
Expand-Archive -Path $winAcmeZip -DestinationPath "C:\win-acme" -Force

# Install IIS
Write-Host "Installing IIS..."
Install-WindowsFeature -Name Web-Server -IncludeManagementTools

Write-Host "=== Prerequisites installation completed ==="
