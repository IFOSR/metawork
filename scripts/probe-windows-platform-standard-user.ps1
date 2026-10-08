# Exercise the production file binary as an ordinary local user on disposable CI.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path $repo '.tmp/windows-desktop-validation/platform-files/standard-user'
$name = 'mwf' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$fixture = Join-Path $env:PUBLIC $name
$created = $false
$child = $null
$policy = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$old = Get-ItemProperty -Path $policy -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $evidence, $fixture | Out-Null
try {
  # Explicit prerequisite, configured only in this disposable test machine.
  New-Item -Path $policy -Force | Out-Null
  Set-ItemProperty -Path $policy -Name AllowDevelopmentWithoutDevLicense -Type DWord -Value 1
  $password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'Aa!7') -AsPlainText -Force
  New-LocalUser -Name $name -Password $password | Out-Null
  $created = $true
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
  & icacls.exe $fixture /grant "${name}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Standard-user fixture ACL failed' }
  Copy-Item (Get-Command node.exe).Source (Join-Path $fixture 'node.exe')
  Copy-Item (Join-Path $repo 'native/windows/build/Release/metawork_platform.node') $fixture
  Copy-Item (Join-Path $PSScriptRoot 'probe-windows-platform-files.mjs') $fixture
  Copy-Item (Join-Path $PSScriptRoot 'probe-windows-platform-pipes.mjs') $fixture
  @'
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { probePlatformFiles } from './probe-windows-platform-files.mjs';
import { probePlatformPipes } from './probe-windows-platform-pipes.mjs';
const addon = resolve('metawork_platform.node');
await probePlatformFiles(createRequire(import.meta.url)(addon), resolve('result.json'), addon);
await probePlatformPipes(createRequire(import.meta.url)(addon), resolve('pipes.json'));
'@ | Set-Content (Join-Path $fixture 'run.mjs')
  @'
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Ordinary user required' }
$env:TEMP = $PSScriptRoot
$env:TMP = $PSScriptRoot
Set-Location $PSScriptRoot
& (Join-Path $PSScriptRoot 'node.exe') (Join-Path $PSScriptRoot 'run.mjs')
exit $LASTEXITCODE
'@ | Set-Content (Join-Path $fixture 'run.ps1')
  $credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$name", $password)
  $child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Credential $credential -WorkingDirectory $fixture -PassThru `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $fixture 'run.ps1')) `
    -RedirectStandardOutput (Join-Path $fixture 'stdout.txt') -RedirectStandardError (Join-Path $fixture 'stderr.txt')
  $null = $child.Handle
  if (-not $child.WaitForExit(120000)) { $child.Kill(); throw 'Standard-user native file probe timed out' }
  if ($child.ExitCode -ne 0) {
    Get-Content (Join-Path $fixture 'stderr.txt')
    throw 'Standard-user native file probe failed'
  }
  $report = Get-Content (Join-Path $fixture 'result.json') -Raw | ConvertFrom-Json
  if ($report.passed -ne $true) { throw 'Missing standard-user native file evidence' }
  $pipes = Get-Content (Join-Path $fixture 'pipes.json') -Raw | ConvertFrom-Json
  if ($pipes.passed -ne $true) { throw 'Missing standard-user native pipe evidence' }
} finally {
  if ($child -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
  foreach ($file in @('result.json', 'pipes.json', 'stdout.txt', 'stderr.txt')) {
    if (Test-Path (Join-Path $fixture $file)) { Copy-Item (Join-Path $fixture $file) $evidence }
  }
  if ($created) { Remove-LocalUser -Name $name }
  Remove-Item -LiteralPath $fixture -Recurse -Force
  if ($null -ne $old) {
    Set-ItemProperty -Path $policy -Name AllowDevelopmentWithoutDevLicense -Type DWord -Value $old.AllowDevelopmentWithoutDevLicense
  } else {
    Remove-ItemProperty -Path $policy -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
  }
}
