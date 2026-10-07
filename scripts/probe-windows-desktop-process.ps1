param([switch]$StandardUser)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo '.tmp/windows-pipe-probe/Release/metawork-process-probe.exe'
$evidence = Join-Path $repo '.tmp/windows-desktop-validation/process-job'
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$name = "mwj$suffix"
$fixture = Join-Path $env:PUBLIC "metawork-process-p0-$suffix 中文 workspace"
if ($StandardUser) { $evidence = Join-Path $evidence 'standard-user' }
New-Item -ItemType Directory -Force -Path $evidence, $fixture | Out-Null
$process = $null
$created = $false
try {
  $arguments = @{
    FilePath = $exe; ArgumentList = @('probe', ('"' + $fixture + '"')); PassThru = $true
    WorkingDirectory = $fixture
    RedirectStandardOutput = (Join-Path $fixture 'result.json')
    RedirectStandardError = (Join-Path $fixture 'error.txt')
  }
  if ($StandardUser) {
    $password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'Aa!7') -AsPlainText -Force
    New-LocalUser -Name $name -Password $password | Out-Null; $created = $true
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
    & icacls.exe $fixture /grant "${name}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Process fixture ACL failed' }
    Copy-Item $exe (Join-Path $fixture 'probe.exe')
    $arguments.FilePath = (Join-Path $fixture 'probe.exe')
    $arguments.ArgumentList = @('probe-standard', ('"' + $fixture + '"'))
    $arguments.Credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$name", $password)
  }
  $process = Start-Process @arguments
  $null = $process.Handle
  if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Job process probe timed out' }
  if ($process.ExitCode -ne 0) {
    Get-Content (Join-Path $fixture 'error.txt')
    throw 'Job process probe failed'
  }
} finally {
  if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
  foreach ($file in @('result.json', 'error.txt')) {
    if (Test-Path (Join-Path $fixture $file)) { Copy-Item (Join-Path $fixture $file) $evidence }
  }
  if ($created) { Remove-LocalUser -Name $name }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
