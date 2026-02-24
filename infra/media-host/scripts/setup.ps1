param(
    [Parameter(Mandatory=$true)][string]$ProvisioningToken,
    [Parameter(Mandatory=$true)][string]$SessionApiCallbackUrl
)

$ErrorActionPreference = "Stop"
$logFile = "C:\linto-studio-plugins\logs\setup.log"
Start-Transcript -Path $logFile -Append

try {
    $scriptsPath = "C:\linto-studio-plugins\scripts"

    Write-Host "Retrieving Azure Instance Metadata..."
    $metadata = Invoke-RestMethod -Uri "http://169.254.169.254/metadata/instance?api-version=2021-02-01" -Headers @{"Metadata"="true"} -TimeoutSec 10
    $fqdn = $metadata.network.interface[0].ipv4.ipAddress[0].publicIpAddress.fqdn

    if (-not $fqdn) {
        throw "Could not retrieve FQDN from Azure Instance Metadata"
    }
    Write-Host "FQDN: $fqdn"

    Write-Host "Requesting SSL certificate via win-acme..."
    & "C:\win-acme\wacs.exe" --target manual --host $fqdn --validation selfhosting --store certificatestore --certificatestore My --installation iis --accepttos --emailaddress "admin@$fqdn"

    $cert = Get-ChildItem -Path Cert:\LocalMachine\My | Where-Object { $_.Subject -match $fqdn } | Select-Object -First 1
    if (-not $cert) {
        Write-Warning "SSL certificate not found in store, continuing anyway..."
    } else {
        Write-Host "SSL certificate installed: $($cert.Thumbprint)"
    }

    Write-Host "Configuring services..."
    & "$scriptsPath\configure-services.ps1"

    Write-Host "Performing phone home..."
    & "$scriptsPath\phone-home.ps1" -ProvisioningToken $ProvisioningToken -SessionApiUrl $SessionApiCallbackUrl -Fqdn $fqdn

    Write-Host "Setup completed successfully for $fqdn"
} catch {
    Write-Error "Setup failed: $($_.Exception.Message)"
    throw
} finally {
    Stop-Transcript
}
