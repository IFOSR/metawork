# Runs once inside the disposable Windows 11 evaluation guest. No product secrets.
$ErrorActionPreference = 'Stop'
$report = @{ scope = 'windows11-cloud-environment'; sourceCommit = '@SOURCE_COMMIT@'; desktopAppVerified = $false }
$localEvidence = Join-Path $env:TEMP 'metawork-guest'
New-Item -ItemType Directory -Force $localEvidence | Out-Null
'first-logon' | Set-Content -LiteralPath (Join-Path $localEvidence 'stage.txt')
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
function Prepare-ProductSession {
  if ('@PRODUCT_ENABLED@' -ne 'true') { return }
  if (-not $report.elevated) {
    # If setup already logged on with a standard token, keep that session.
    # Developer Mode is a declared machine prerequisite set by Windows Setup.
    $runner = Join-Path $localEvidence 'product-runner.ps1'
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri 'http://10.0.2.2:8765/@TOKEN@/product-runner' -OutFile $runner
    $script:ordinaryProductRunner = $runner
    $report.productSessionPrepared = $true
    return
  }
  $name = 'MWProduct'
  $password = ConvertTo-SecureString '@PRODUCT_PASSWORD@' -AsPlainText -Force
  if (-not (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) {
    New-LocalUser -Name $name -Password $password -Description 'Disposable ordinary-user product acceptance' | Out-Null
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
  }
  # Declared symlink prerequisite; the product still runs with an ordinary token.
  $policy = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
  New-Item -Path $policy -Force | Out-Null
  Set-ItemProperty -Path $policy -Name AllowDevelopmentWithoutDevLicense -Type DWord -Value 1
  $directory = 'C:\ProgramData\MetaWorkAcceptance'
  New-Item -ItemType Directory -Force $directory | Out-Null
  $runner = Join-Path $directory 'run.ps1'
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri 'http://10.0.2.2:8765/@TOKEN@/product-runner' -OutFile $runner
  $account = "$env:COMPUTERNAME\$name"
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File $runner"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
  $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 65)
  Register-ScheduledTask -TaskName 'MetaWorkOrdinaryUserAcceptance' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  $logon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $logon -Name AutoAdminLogon -Value '1'
  Set-ItemProperty $logon -Name DefaultDomainName -Value $env:COMPUTERNAME
  Set-ItemProperty $logon -Name DefaultUserName -Value $name
  Set-ItemProperty $logon -Name DefaultPassword -Value '@PRODUCT_PASSWORD@'
  Set-ItemProperty $logon -Name AutoLogonCount -Type DWord -Value 1
  $report.productSessionPrepared = $true
}
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
  $report.account = $identity.Name
  $report.expectedProvisionedAccount = $env:USERNAME -eq 'MWCI'
  $report.secureBoot = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State').UEFISecureBootEnabled -eq 1
  $tpm = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'ACPI\MSFT0101*' -and $_.ConfigManagerErrorCode -eq 0 })
  $report.tpmPresent = $tpm.Count -gt 0
  $report.secureBootEvidence = 'firmware-backed-system-registry'
  $report.tpmEvidence = 'started-ACPI-MSFT0101-device'
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
      [IO.File]::WriteAllBytes((Join-Path $localEvidence 'screen.png'), $stream.ToArray())
      $report.screenshotCaptured = $true
      try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Method Post -Uri 'http://10.0.2.2:8765/@TOKEN@/screen' -ContentType 'image/png' -Body $stream.ToArray() | Out-Null
        $report.screenshotUploaded = $true
      } catch { $report.screenshotUploaded = $false }
    } finally { $stream.Dispose() }
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
  if ($report.passed) { Prepare-ProductSession }
} catch {
  $report.passed = $false
  $report.error = $_.Exception.Message.Replace('@TOKEN@', '[redacted]').Replace('@PRODUCT_PASSWORD@', '[redacted]')
}
[IO.File]::WriteAllText((Join-Path $localEvidence 'result.json'), ($report | ConvertTo-Json), [Text.Encoding]::UTF8)
Write-SerialEvidence $report
$body = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json))
for ($attempt = 0; $attempt -lt 12; $attempt++) {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Method Post -Uri 'http://10.0.2.2:8765/@TOKEN@/result' -ContentType 'application/json' -Body $body | Out-Null
    break
  } catch { Start-Sleep -Seconds 5 }
}
if ($report.passed -and $report.productSessionPrepared) {
  if ($ordinaryProductRunner) { & $ordinaryProductRunner }
  else { shutdown.exe /r /t 10 | Out-Null }
}
