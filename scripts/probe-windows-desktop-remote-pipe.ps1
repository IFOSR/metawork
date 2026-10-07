# Exercise the SMB named-pipe transport through this disposable machine's host
# name. A positive control proves access reaches the server before rejection.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$build = Join-Path $repo '.tmp/windows-pipe-probe'
$exe = Join-Path $build 'Release/metawork-windows-probe.exe'
$evidence = Join-Path $repo '.tmp/windows-desktop-validation/remote-pipe'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
$server = $null
try {
  foreach ($control in @($true, $false)) {
    $suffix = [Guid]::NewGuid().ToString('N')
    $localPipe = "\\.\pipe\metawork-p0-$suffix"
    $remotePipe = "\\$env:COMPUTERNAME\pipe\metawork-p0-$suffix"
    $ready = Join-Path $build "remote-ready-$suffix"
    $label = if ($control) { 'control' } else { 'restricted' }
    $mode = if ($control) { 'serve-remote-control' } else { 'serve' }
    $server = Start-Process $exe -ArgumentList @($mode, $localPipe, $ready) -PassThru `
      -RedirectStandardOutput (Join-Path $evidence "$label-server.json") `
      -RedirectStandardError (Join-Path $evidence "$label-server-error.txt")
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath $ready)) {
      $server.Refresh()
      if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Remote pipe fixture did not start' }
      Start-Sleep -Milliseconds 100
    }
    $clientMode = if ($control) { 'remote' } else { 'remote-denied' }
    $client = Start-Process $exe -ArgumentList @($clientMode, $remotePipe, '0') -PassThru `
      -RedirectStandardOutput (Join-Path $evidence "$label-client.json") `
      -RedirectStandardError (Join-Path $evidence "$label-client-error.txt")
    if (-not $client.WaitForExit(15000)) { $client.Kill(); throw 'SMB pipe probe timed out' }
    if ($client.ExitCode -ne 0) { throw "SMB $label pipe probe failed" }
    Start-Sleep -Milliseconds 100
    & $exe stop $localPipe $server.Id | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Local cleanup connection failed' }
    if (-not $server.WaitForExit(15000)) { throw 'SMB fixture did not stop' }
    if ($server.ExitCode -ne 0) { throw 'SMB fixture failed' }
  }
  @{ scope = 'SMB-loopback-transport'; passed = $true; positiveControl = $true
     remoteFlagDenial = $true; differentMachineVerified = $false; p0Accepted = $false
  } | ConvertTo-Json | Set-Content (Join-Path $evidence 'result.json')
} finally {
  if ($server -and -not $server.HasExited) { $server.Kill(); $server.WaitForExit() }
}
