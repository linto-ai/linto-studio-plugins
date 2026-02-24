param(
    [Parameter(Mandatory=$true)][string]$Fqdn,
    [Parameter(Mandatory=$true)][string]$ProvisioningToken,
    [Parameter(Mandatory=$true)][string]$SessionApiCallbackUrl,
    [string]$SslMode = "letsencrypt",
    [string]$PfxPath
)

$ErrorActionPreference = "Stop"
$logFile = "C:\linto-studio-plugins\logs\setup-manual.log"
Start-Transcript -Path $logFile -Append

try {
    $scriptsPath = "C:\linto-studio-plugins\scripts"

    Write-Host "Starting manual setup for FQDN: $Fqdn"

    if ($SslMode -eq "letsencrypt") {
        Write-Host "Requesting SSL certificate via win-acme..."
        & "C:\win-acme\wacs.exe" --target manual --host $Fqdn --validation selfhosting --store certificatestore --certificatestore My --installation iis --accepttos --emailaddress "admin@$Fqdn"

        $cert = Get-ChildItem -Path Cert:\LocalMachine\My | Where-Object { $_.Subject -match $Fqdn } | Select-Object -First 1
        if (-not $cert) {
            Write-Warning "SSL certificate not found in store, continuing anyway..."
        } else {
            Write-Host "SSL certificate installed: $($cert.Thumbprint)"
        }
    } elseif ($SslMode -eq "pfx") {
        if (-not $PfxPath) {
            throw "PfxPath is required when SslMode is 'pfx'"
        }
        if (-not (Test-Path $PfxPath)) {
            throw "PFX file not found: $PfxPath"
        }
        Write-Host "Importing PFX certificate from $PfxPath..."
        $pfxPassword = Read-Host -Prompt "Enter PFX password" -AsSecureString
        $cert = Import-PfxCertificate -FilePath $PfxPath -CertStoreLocation Cert:\LocalMachine\My -Password $pfxPassword
        Write-Host "PFX certificate imported: $($cert.Thumbprint)"
    } else {
        throw "Invalid SslMode: $SslMode. Expected 'letsencrypt' or 'pfx'"
    }

    Write-Host "Configuring services..."
    & "$scriptsPath\configure-services.ps1"

    Write-Host "Performing phone home..."
    & "$scriptsPath\phone-home.ps1" -ProvisioningToken $ProvisioningToken -SessionApiUrl $SessionApiCallbackUrl -Fqdn $Fqdn

    Write-Host "Manual setup completed successfully for $Fqdn"
} catch {
    Write-Error "Setup failed: $($_.Exception.Message)"
    throw
} finally {
    Stop-Transcript
}
