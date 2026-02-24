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
    }
}

sc.exe create "LinTO-BotService" binPath= "$servicePath\TeamsMediaBot\TeamsMediaBot.exe" start= auto

Write-Host "Services configured successfully."
