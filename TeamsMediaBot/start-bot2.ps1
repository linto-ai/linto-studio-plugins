# Load environment variables from .env file
$envFile = "C:\linto-studio-plugins\TeamsMediaBot\src\TeamsMediaBot\.env"
Get-Content $envFile | ForEach-Object {
    if ($_ -match "^([^#=]+)=(.*)$") {
        $name = $matches[1].Trim()
        $value = $matches[2].Trim()
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

# Start the bot directly
Set-Location "C:\linto-studio-plugins\TeamsMediaBot\src\TeamsMediaBot"
& "C:\linto-studio-plugins\TeamsMediaBot\src\TeamsMediaBot\bin\Debug\net6.0\TeamsMediaBot.exe"
