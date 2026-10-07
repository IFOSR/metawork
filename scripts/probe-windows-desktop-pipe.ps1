# Native P0 only. Accounts and processes exist only on the disposable CI runner.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$build = Join-Path $repo '.tmp/windows-pipe-probe'
$evidence = Join-Path $repo '.tmp/windows-desktop-validation'
New-Item -ItemType Directory -Force -Path $build, $evidence | Out-Null
cmake -S (Join-Path $repo 'native/windows-probe') -B $build -A x64
if ($LASTEXITCODE -ne 0) { throw 'P0 native configure failed' }
cmake --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw 'P0 native compilation failed' }
$executable = Join-Path $build 'Release/metawork-windows-probe.exe'
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$otherName = "mwp0$suffix"
$pipe = "\\.\pipe\metawork-p0-$suffix"
$ready = Join-Path $build "ready-$suffix"
$server = $null
$otherCreated = $false
try {
  # Standard second user: no Administrator group membership, secret never logged.
  $password = ConvertTo-SecureString (([Guid]::NewGuid().ToString('N')) + 'Aa!7') -AsPlainText -Force
  New-LocalUser -Name $otherName -Password $password -Description 'Disposable MetaWork P0 test' | Out-Null
  $otherCreated = $true
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $otherName
  $credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$otherName", $password)
  # Grant this test user only fixture-folder access, never repository/account data.
  $fixture = Join-Path $env:PUBLIC "metawork-p0-$suffix"
  New-Item -ItemType Directory -Path $fixture | Out-Null
  & icacls.exe $fixture /grant "${otherName}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'P0 fixture ACL setup failed' }
  Copy-Item $executable (Join-Path $fixture 'probe.exe')
  $server = Start-Process -FilePath $executable -ArgumentList @('serve', $pipe, $ready) -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $evidence 'pipe-server.json') -RedirectStandardError (Join-Path $evidence 'pipe-server-error.txt')
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $ready)) {
    $server.Refresh()
    if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) {
      Get-Content (Join-Path $evidence 'pipe-server-error.txt')
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
  & $executable wrong-pid $pipe ($serverPid + 1) | Set-Content (Join-Path $evidence 'pipe-spoof.json')
  if ($LASTEXITCODE -ne 0) { throw 'Spoofed PID probe failed' }
  Start-Sleep -Milliseconds 100
  & $executable client $pipe $serverPid | Set-Content (Join-Path $evidence 'pipe-client.json')
  if ($LASTEXITCODE -ne 0) { throw 'Authenticated pipe round trip failed' }
  Start-Sleep -Milliseconds 100
  & $executable stop $pipe $serverPid | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Pipe probe stop failed' }
  if (-not $server.WaitForExit(15000)) { throw 'P0 server did not exit' }
  if ($server.ExitCode -ne 0) { throw 'P0 server failed' }
  @{ scope = 'native-pipe-spike'; passed = $true; p0Accepted = $false
     crossAccountDenied = $true; windows11Acceptance = $false
     remoteRejection = 'configured with PIPE_REJECT_REMOTE_CLIENTS; remote machine not exercised'
     remaining = @('ordinary-user server lifecycle', 'production transport integration', 'reparse races', 'remote-machine connection')
  } | ConvertTo-Json | Set-Content (Join-Path $evidence 'pipe-result.json')
} finally {
  if ($server -and -not $server.HasExited) { $server.Kill(); $server.WaitForExit() }
  if ($otherCreated) { Remove-LocalUser -Name $otherName }
  if ($fixture -and (Test-Path -LiteralPath $fixture)) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
