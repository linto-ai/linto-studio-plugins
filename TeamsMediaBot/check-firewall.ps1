# Check firewall rules for ports 9441, 9442
Write-Host "=== Firewall rules for ports 9441, 9442 ==="
Get-NetFirewallRule -Direction Inbound -Enabled True | Where-Object {
    $portFilter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $_
    $portFilter.LocalPort -eq '9441' -or $portFilter.LocalPort -eq '9442'
} | Select-Object DisplayName, Enabled, Profile

Write-Host "`n=== Testing local access ==="
try {
    $response = Invoke-WebRequest -Uri "https://localhost:9441/configure.html" -SkipCertificateCheck -UseBasicParsing -TimeoutSec 5
    Write-Host "Local access OK - Status: $($response.StatusCode)"
} catch {
    Write-Host "Local access failed: $_"
}

Write-Host "`n=== Current listening ports ==="
netstat -ano | Select-String "LISTENING" | Select-String "9441|9442"
