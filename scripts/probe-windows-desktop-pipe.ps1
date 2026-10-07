# Native P0 only. Accounts and processes exist only on the disposable CI runner.
param([switch]$StandardUser)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$build = Join-Path $repo '.tmp/windows-pipe-probe'
$evidence = Join-Path $repo '.tmp/windows-desktop-validation'
if ($StandardUser) { $evidence = Join-Path $evidence 'standard-user' }
New-Item -ItemType Directory -Force -Path $build, $evidence | Out-Null
cmake -S (Join-Path $repo 'native/windows-probe') -B $build -A x64
if ($LASTEXITCODE -ne 0) { throw 'P0 native configure failed' }
cmake --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw 'P0 native compilation failed' }
$executable = Join-Path $build 'Release/metawork-windows-probe.exe'
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$otherName = "mwp0$suffix"
$pipe = "\\.\pipe\metawork-p0-$suffix"
$server = $null
$otherCreated = $false
$ownerCreated = $false
$ownerName = "mwo$suffix"
$ownerCredential = $null
$fixture = $null
function Invoke-ProbeClient([string]$mode, [int]$expected) {
  $out = Join-Path $fixture "$mode.json"
  $err = Join-Path $fixture "$mode-error.txt"
  $arguments = @{
    FilePath = (Join-Path $fixture 'probe.exe'); ArgumentList = @($mode, $pipe, $expected)
    WorkingDirectory = $fixture; PassThru = $true
    RedirectStandardOutput = $out; RedirectStandardError = $err
  }
  if ($ownerCredential) { $arguments.Credential = $ownerCredential }
  $client = Start-Process @arguments
  if (-not $client.WaitForExit(15000)) { $client.Kill(); throw "Client $mode timed out" }
  Copy-Item $out, $err $evidence
  if ($client.ExitCode -ne 0) { throw "Client $mode failed" }
}
try {
  # Standard second user: no Administrator group membership, secret never logged.
  $password = ConvertTo-SecureString (([Guid]::NewGuid().ToString('N')) + 'Aa!7') -AsPlainText -Force
  New-LocalUser -Name $otherName -Password $password -Description 'Disposable MetaWork P0 test' | Out-Null
  $otherCreated = $true
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $otherName
  $credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$otherName", $password)
  if ($StandardUser) {
    $ownerPassword = ConvertTo-SecureString (([Guid]::NewGuid().ToString('N')) + 'Aa!7') -AsPlainText -Force
    New-LocalUser -Name $ownerName -Password $ownerPassword -Description 'Disposable MetaWork P0 owner' | Out-Null
    $ownerCreated = $true
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $ownerName
    $ownerCredential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$ownerName", $ownerPassword)
  }
  # Grant this test user only fixture-folder access, never repository/account data.
  $fixture = Join-Path $env:PUBLIC "metawork-p0-$suffix"
  New-Item -ItemType Directory -Path $fixture | Out-Null
  & icacls.exe $fixture /grant "${otherName}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'P0 fixture ACL setup failed' }
  if ($StandardUser) {
    & icacls.exe $fixture /grant "${ownerName}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'P0 owner fixture ACL setup failed' }
  }
  Copy-Item $executable (Join-Path $fixture 'probe.exe')
  $ready = Join-Path $fixture 'ready'
  $serverMode = if ($StandardUser) { 'serve-standard' } else { 'serve' }
  $serverArguments = @{
    FilePath = (Join-Path $fixture 'probe.exe'); ArgumentList = @($serverMode, $pipe, $ready)
    WorkingDirectory = $fixture; PassThru = $true
    RedirectStandardOutput = (Join-Path $fixture 'pipe-server.json')
    RedirectStandardError = (Join-Path $fixture 'pipe-server-error.txt')
  }
  if ($ownerCredential) { $serverArguments.Credential = $ownerCredential }
  $server = Start-Process @serverArguments
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $ready)) {
    $server.Refresh()
    if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) {
      Get-Content (Join-Path $fixture 'pipe-server-error.txt')
      throw 'P0 pipe did not become ready'
    }
    Start-Sleep -Milliseconds 100
  }
  $serverPid = [int](Get-Content -LiteralPath $ready -Raw)
  if ($serverPid -ne $server.Id) { throw 'P0 server PID mismatch' }
  $denied = Start-Process -FilePath (Join-Path $fixture 'probe.exe') -Credential $credential `
    -ArgumentList @('denied', $pipe, $serverPid) -WorkingDirectory $fixture -PassThru `
    -RedirectStandardOutput (Join-Path $fixture 'denied.json') -RedirectStandardError (Join-Path $fixture 'denied-error.txt')
  if (-not $denied.WaitForExit(15000)) { $denied.Kill(); throw 'Cross-account denial timed out' }
  Copy-Item (Join-Path $fixture 'denied-error.txt') $evidence
  if ($denied.ExitCode -ne 0) { throw 'Cross-account denial probe failed' }
  Copy-Item (Join-Path $fixture 'denied.json') $evidence
  Invoke-ProbeClient 'wrong-pid' ($serverPid + 1)
  Start-Sleep -Milliseconds 100
  Invoke-ProbeClient 'client' $serverPid
  Start-Sleep -Milliseconds 100
  Invoke-ProbeClient 'stop' $serverPid
  if (-not $server.WaitForExit(15000)) { throw 'P0 server did not exit' }
  if ($server.ExitCode -ne 0) { throw 'P0 server failed' }
  @{ scope = 'native-pipe-spike'; passed = $true; p0Accepted = $false
     crossAccountDenied = $true; windows11Acceptance = $false
     standardUserRequested = [bool]$StandardUser
     remoteRejection = 'configured with PIPE_REJECT_REMOTE_CLIENTS; remote machine not exercised'
     remaining = @('production transport integration', 'reparse races', 'remote-machine connection', 'ordinary-user installer lifecycle')
  } | ConvertTo-Json | Set-Content (Join-Path $evidence 'pipe-result.json')
} finally {
  if ($server -and -not $server.HasExited) { $server.Kill(); $server.WaitForExit() }
  if ($fixture) {
    foreach ($name in @('pipe-server.json', 'pipe-server-error.txt', 'denied.json', 'denied-error.txt')) {
      $log = Join-Path $fixture $name
      if (Test-Path -LiteralPath $log) { Copy-Item $log $evidence }
    }
  }
  if ($otherCreated) { Remove-LocalUser -Name $otherName }
  if ($ownerCreated) { Remove-LocalUser -Name $ownerName }
  if ($fixture -and (Test-Path -LiteralPath $fixture)) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
