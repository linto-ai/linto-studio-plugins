param(
    [Parameter(Mandatory=$true)][string]$ProvisioningToken,
    [Parameter(Mandatory=$true)][string]$SessionApiUrl,
    [Parameter(Mandatory=$true)][string]$Fqdn
)

$ErrorActionPreference = "Stop"

Write-Host "Registering media host with Session API..."

$body = @{
    token = $ProvisioningToken
    dns = $Fqdn
} | ConvertTo-Json

$maxRetries = 5
$retryDelay = 10
$response = $null

for ($i = 1; $i -le $maxRetries; $i++) {
    try {
        $response = Invoke-RestMethod -Uri "$SessionApiUrl/register-media-host" -Method POST -Body $body -ContentType 'application/json'
        Write-Host "Registration successful on attempt $i"
        break
    } catch {
        Write-Host "Attempt $i failed: $($_.Exception.Message)"
        if ($i -eq $maxRetries) { throw "Failed to register after $maxRetries attempts" }
        Start-Sleep -Seconds $retryDelay
    }
}

Write-Host "Writing MQTT configuration..."

$envContent = @"
MQTT_HOST=$($response.mqtt.host)
MQTT_PORT=$($response.mqtt.port)
MQTT_USER=$($response.mqtt.user)
MQTT_PASSWORD=$($response.mqtt.password)
INTEGRATION_CONFIG_ID=$($response.integrationConfigId)
"@
Set-Content -Path "C:\linto-studio-plugins\.env" -Value $envContent -Encoding UTF8

Write-Host "Writing application settings..."

$appSettings = @{
    AzureAd = @{
        TenantId = $response.config.tenantId
        ClientId = $response.config.clientId
        ClientSecret = $response.config.clientSecret
    }
    Bot = @{
        Fqdn = $Fqdn
        PlaceCallEndpointUrl = "https://$Fqdn"
    }
} | ConvertTo-Json -Depth 5
Set-Content -Path "C:\linto-studio-plugins\TeamsMediaBot\appsettings.Production.json" -Value $appSettings -Encoding UTF8

Write-Host "Starting services..."
Start-Service "LinTO-BotService"

Write-Host "Phone home completed successfully for $Fqdn"
