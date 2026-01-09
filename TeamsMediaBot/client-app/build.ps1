$nodePath = "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Microsoft\VisualStudio\NodeJs"
$env:PATH = "$nodePath;$env:PATH"

Set-Location $PSScriptRoot

if (Test-Path node_modules) {
    Remove-Item -Recurse -Force node_modules
}

Write-Host "Running npm install..."
npm install

if ($LASTEXITCODE -eq 0) {
    Write-Host "Running npm run build..."
    npm run build
}
