$ErrorActionPreference = "Stop"

Write-Host "Configuring Windows Firewall rules..."

# Remove existing rules if they exist (idempotent)
$ruleNames = @("LinTO-HTTPS", "LinTO-BotService", "LinTO-Calling", "LinTO-Media-UDP")
foreach ($name in $ruleNames) {
    $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if ($existing) { Remove-NetFirewallRule -DisplayName $name }
}

New-NetFirewallRule -DisplayName "LinTO-HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
New-NetFirewallRule -DisplayName "LinTO-BotService" -Direction Inbound -Protocol TCP -LocalPort 9441,9442 -Action Allow
New-NetFirewallRule -DisplayName "LinTO-Calling" -Direction Inbound -Protocol TCP -LocalPort 8445 -Action Allow
New-NetFirewallRule -DisplayName "LinTO-Media-UDP" -Direction Inbound -Protocol UDP -LocalPort 49152-65535 -Action Allow

Write-Host "Registering Windows services..."

$servicePath = "C:\linto-studio-plugins"

# Remove existing services if they exist (idempotent)
foreach ($svcName in @("LinTO-BotService", "LinTO-MediaPlatform")) {
    $existing = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-Service -Name $svcName -Force -ErrorAction SilentlyContinue
        sc.exe delete $svcName
        # Wait for the service to be fully removed (marked-for-deletion state)
        $retries = 0
        while ((Get-Service -Name $svcName -ErrorAction SilentlyContinue) -and $retries -lt 30) {
            Write-Host "Waiting for service $svcName to be removed..."
            Start-Sleep -Seconds 1
            $retries++
        }
        if (Get-Service -Name $svcName -ErrorAction SilentlyContinue) {
            throw "Service $svcName is still marked for deletion. Close services.msc and any other management tools, then retry (or reboot)."
        }
    }
}

sc.exe create "LinTO-BotService" binPath= "$servicePath\TeamsMediaBot\TeamsMediaBot.exe" start= auto
if ($LASTEXITCODE -ne 0) {
    throw "Failed to create LinTO-BotService (sc.exe exit code: $LASTEXITCODE). If error 1072, reboot the server and retry."
}

Write-Host "Services configured successfully."
