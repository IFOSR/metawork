# Run environment checks with a non-administrator token on a disposable runner.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path $repo '.tmp/windows-desktop-validation/standard-user'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
$name = 'mwe' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$fixture = Join-Path $env:PUBLIC $name
$created = $false
$child = $null
# Developer mode is an explicit installation prerequisite in the approved plan.
# Configure it only on this disposable VM and restore its previous value.
$policy = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$old = Get-ItemProperty -Path $policy -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
try {
  New-Item -Path $policy -Force | Out-Null
  Set-ItemProperty -Path $policy -Name AllowDevelopmentWithoutDevLicense -Type DWord -Value 1
  $password = ConvertTo-SecureString (([Guid]::NewGuid().ToString('N')) + 'Aa!7') -AsPlainText -Force
  New-LocalUser -Name $name -Password $password -Description 'Disposable MetaWork prerequisite probe' | Out-Null
  $created = $true
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
  $credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$name", $password)
  New-Item -ItemType Directory -Path $fixture | Out-Null
  & icacls.exe $fixture /grant "${name}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Standard-user fixture ACL failed' }
  Copy-Item (Get-Command node.exe).Source (Join-Path $fixture 'node.exe')
  Copy-Item (Join-Path $PSScriptRoot 'probe-windows-desktop-environment.mjs') $fixture
  @'
$ErrorActionPreference = 'Stop'
$env:TEMP = $PSScriptRoot
$env:TMP = $PSScriptRoot
Set-Location $PSScriptRoot
& (Join-Path $PSScriptRoot 'node.exe') (Join-Path $PSScriptRoot 'probe-windows-desktop-environment.mjs') (Join-Path $PSScriptRoot 'windows-environment.json')
exit $LASTEXITCODE
'@ | Set-Content (Join-Path $fixture 'run.ps1')
  $child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Credential $credential -WorkingDirectory $fixture -PassThru `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $fixture 'run.ps1')) `
    -RedirectStandardOutput (Join-Path $fixture 'stdout.txt') -RedirectStandardError (Join-Path $fixture 'stderr.txt')
  if (-not $child.WaitForExit(120000)) { $child.Kill(); throw 'Standard-user environment probe timed out' }
  if ($child.ExitCode -ne 0) { throw 'Standard-user environment probe failed' }
  $report = Get-Content (Join-Path $fixture 'windows-environment.json') -Raw | ConvertFrom-Json
  if ($report.host.elevated -ne $false) { throw 'Standard-user probe unexpectedly elevated' }
  if (@($report.checks | Where-Object { -not $_.passed }).Count -ne 0) { throw 'Standard-user prerequisite check failed' }
} finally {
  if ($child -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
  foreach ($file in @('windows-environment.json', 'stdout.txt', 'stderr.txt')) {
    $path = Join-Path $fixture $file
    if (Test-Path -LiteralPath $path) { Copy-Item $path $evidence }
  }
  if ($created) { Remove-LocalUser -Name $name }
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
  if ($null -ne $old) {
    Set-ItemProperty -Path $policy -Name AllowDevelopmentWithoutDevLicense -Type DWord -Value $old.AllowDevelopmentWithoutDevLicense
  } else {
    Remove-ItemProperty -Path $policy -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
  }
}
