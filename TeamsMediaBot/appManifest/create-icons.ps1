Add-Type -AssemblyName System.Drawing

# Create color icon (192x192) - Blue background with "CC" text
$colorBitmap = New-Object System.Drawing.Bitmap(192, 192)
$graphics = [System.Drawing.Graphics]::FromImage($colorBitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(0, 120, 212))  # Teams blue

$font = New-Object System.Drawing.Font("Segoe UI", 72, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::White
$stringFormat = New-Object System.Drawing.StringFormat
$stringFormat.Alignment = [System.Drawing.StringAlignment]::Center
$stringFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

$rect = New-Object System.Drawing.RectangleF(0, 0, 192, 192)
$graphics.DrawString("CC", $font, $brush, $rect, $stringFormat)

$colorBitmap.Save("$PSScriptRoot\color.png", [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$colorBitmap.Dispose()

Write-Host "Created color.png (192x192)"

# Create outline icon (32x32) - Transparent background with black "CC" text
$outlineBitmap = New-Object System.Drawing.Bitmap(32, 32)
$graphics = [System.Drawing.Graphics]::FromImage($outlineBitmap)
$graphics.Clear([System.Drawing.Color]::Transparent)

$font = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::Black
$rect = New-Object System.Drawing.RectangleF(0, 0, 32, 32)
$graphics.DrawString("CC", $font, $brush, $rect, $stringFormat)

$outlineBitmap.Save("$PSScriptRoot\outline.png", [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$outlineBitmap.Dispose()

Write-Host "Created outline.png (32x32)"
