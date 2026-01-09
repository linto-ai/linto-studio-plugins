$processId = 11888

# Try to get environment from WMI
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
if ($process) {
    Write-Host "Process found: $($process.Name)"
    Write-Host "Command: $($process.CommandLine)"
}

# Alternative: check if there's a .env file or config anywhere
$envFiles = @(
    "C:\linto-studio-plugins\TeamsMediaBot\.env",
    "C:\linto-studio-plugins\TeamsMediaBot\src\TeamsMediaBot\.env",
    "$env:USERPROFILE\.env"
)

foreach ($file in $envFiles) {
    if (Test-Path $file) {
        Write-Host "`nFound env file: $file"
        Get-Content $file | Where-Object { $_ -match "ServiceDnsName|AadAppId|MediaDnsName" }
    }
}

# Check user environment variables
Write-Host "`nUser Environment Variables:"
[Environment]::GetEnvironmentVariables("User") | ForEach-Object {
    $_.GetEnumerator() | Where-Object { $_.Key -match "Service|Aad|Dns|Bot" } | ForEach-Object {
        Write-Host "$($_.Key): $($_.Value)"
    }
}

# Check machine environment variables
Write-Host "`nMachine Environment Variables:"
[Environment]::GetEnvironmentVariables("Machine") | ForEach-Object {
    $_.GetEnumerator() | Where-Object { $_.Key -match "Service|Aad|Dns|Bot" } | ForEach-Object {
        Write-Host "$($_.Key): $($_.Value)"
    }
}
