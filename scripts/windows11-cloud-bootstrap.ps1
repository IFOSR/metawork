# Runs once inside the disposable Windows 11 evaluation guest. No product secrets.
$ErrorActionPreference = 'Stop'
$report = @{ scope = 'windows11-cloud-environment'; sourceCommit = '@SOURCE_COMMIT@'; desktopAppVerified = $false }
'first-logon' | Set-Content -LiteralPath 'C:\Windows\Temp\metawork-guest-stage.txt'
function Write-SerialEvidence($value) {
  # Independent of guest NIC drivers; never write credentials or answer media.
  $serial = $null
  try {
    $serial = [IO.Ports.SerialPort]::new('COM1', 115200, [IO.Ports.Parity]::None, 8, [IO.Ports.StopBits]::One)
    $serial.WriteTimeout = 5000
    $serial.Open()
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress)))
    $serial.WriteLine('MWCI_REPORT=' + $encoded)
  } catch { } finally { if ($null -ne $serial) { $serial.Dispose() } }
}
Write-SerialEvidence @{ scope = $report.scope; stage = 'first-logon' }
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $report.os = $os.Caption
  $report.build = $os.BuildNumber
  $report.productType = $os.ProductType
  $report.architecture = $os.OSArchitecture
  $report.interactive = [Environment]::UserInteractive
  $report.elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $report.secureBoot = Confirm-SecureBootUEFI
  $report.tpmPresent = (Get-Tpm).TpmPresent
  $report.passed = $os.Caption -match 'Windows 11' -and $os.ProductType -eq 1 -and $report.secureBoot -and $report.tpmPresent -and $report.interactive
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Start-Sleep -Seconds 15
  $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object Drawing.Bitmap($bounds.Width, $bounds.Height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
    $stream = New-Object IO.MemoryStream
    try {
      $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
      [IO.File]::WriteAllBytes('C:\Windows\Temp\metawork-guest-screen.png', $stream.ToArray())
      $report.screenshotCaptured = $true
      try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Method Post -Uri 'http://10.0.2.2:8765/@TOKEN@/screen' -ContentType 'image/png' -Body $stream.ToArray() | Out-Null
        $report.screenshotUploaded = $true
      } catch { $report.screenshotUploaded = $false }
    } finally { $stream.Dispose() }
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
} catch {
  $report.passed = $false
  $report.error = $_.Exception.Message.Replace('@TOKEN@', '[redacted]')
}
[IO.File]::WriteAllText('C:\Windows\Temp\metawork-guest-result.json', ($report | ConvertTo-Json), [Text.Encoding]::UTF8)
Write-SerialEvidence $report
$body = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json))
for ($attempt = 0; $attempt -lt 12; $attempt++) {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Method Post -Uri 'http://10.0.2.2:8765/@TOKEN@/result' -ContentType 'application/json' -Body $body | Out-Null
    break
  } catch { Start-Sleep -Seconds 5 }
}
