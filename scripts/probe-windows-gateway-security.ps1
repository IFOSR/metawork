# Real production Gateway under a standard account; disposable Actions runner only.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable Actions runner required' }
$repo = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path $repo '.tmp/windows-desktop-validation/gateway-security'
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$fixture = Join-Path $env:PUBLIC "mwgs-$suffix"
$owner = "mwgo$suffix"
$other = "mwgd$suffix"
$created = @()
$server = $null
$pipe = "\\.\pipe\metawork-gateway-$suffix"
New-Item -ItemType Directory -Force -Path $fixture, $evidence | Out-Null
function Invoke-Fixture([string]$mode, [string]$name, [int]$expected, $credential) {
  $child = Start-Process (Join-Path $fixture 'node.exe') -Credential $credential -WorkingDirectory $fixture -PassThru `
    -ArgumentList @((Join-Path $fixture 'probe.mjs'), $mode, $name, $expected) `
    -RedirectStandardOutput (Join-Path $evidence "$mode.json") -RedirectStandardError (Join-Path $evidence "$mode-error.txt")
  $null = $child.Handle
  if (-not $child.WaitForExit(15000)) { $child.Kill(); $child.WaitForExit(); throw "$mode timed out" }
  if ($child.ExitCode -ne 0) { Get-Content (Join-Path $evidence "$mode-error.txt"); throw "$mode failed" }
}
try {
  $credentials = @{}
  foreach ($name in @($owner, $other)) {
    $password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'Aa!7') -AsPlainText -Force
    New-LocalUser -Name $name -Password $password | Out-Null
    $created += $name
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
    $credentials[$name] = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$name", $password)
    & icacls.exe $fixture /grant "${name}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture ACL failed' }
    # Start-Process redirects into the evidence directory before switching identity.
  }
  Copy-Item (Get-Command node.exe).Source (Join-Path $fixture 'node.exe')
  Copy-Item (Join-Path $repo 'native/windows/build/Release/metawork_platform.node') $fixture
  & node --input-type=module -e "import {build} from 'esbuild'; await build({entryPoints:['scripts/probe-windows-gateway-security.ts'],outfile:process.argv[1],bundle:true,platform:'node',format:'esm',target:'node22'});" (Join-Path $fixture 'probe.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Gateway security fixture build failed' }
  # A positive SMB control executes under the same owner account as the native
  # server. It proves remote transport works before testing the reject flag.
  @'
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Standard user required' }
$name = 'metawork-control-' + [Guid]::NewGuid().ToString('N')
$server = New-Object IO.Pipes.NamedPipeServerStream($name, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous)
$client = New-Object IO.Pipes.NamedPipeClientStream($env:COMPUTERNAME, $name, [IO.Pipes.PipeDirection]::InOut)
try {
  [Console]::Error.WriteLine('SMB control: accepting')
  $waiting = $server.WaitForConnectionAsync()
  $client.Connect(5000)
  [Console]::Error.WriteLine('SMB control: connected')
  if (-not $waiting.Wait(5000)) { throw 'SMB control accept timed out' }
  $buffer = New-Object byte[] 1
  $reading = $server.ReadAsync($buffer, 0, 1)
  $writing = $client.WriteAsync([byte[]]@(42), 0, 1)
  if (-not $writing.Wait(5000)) { throw 'SMB control write timed out' }
  $client.Flush()
  if (-not $reading.Wait(5000)) { throw 'SMB control read timed out' }
  if ($reading.Result -ne 1 -or $buffer[0] -ne 42) { throw 'SMB control did not exchange bytes' }
  Write-Output '{"passed":true,"scope":"same-standard-user-SMB-control"}'
} finally { $client.Dispose(); $server.Dispose() }
'@ | Set-Content (Join-Path $fixture 'control.ps1')
  $server = Start-Process (Join-Path $fixture 'node.exe') -Credential $credentials[$owner] -WorkingDirectory $fixture -PassThru `
    -ArgumentList @((Join-Path $fixture 'probe.mjs'), 'serve', $pipe) `
    -RedirectStandardOutput (Join-Path $evidence 'server.txt') -RedirectStandardError (Join-Path $evidence 'server-error.txt')
  $null = $server.Handle
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path (Join-Path $fixture 'ready'))) {
    if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) {
      Get-Content (Join-Path $evidence 'server-error.txt'); throw 'Production Gateway did not start'
    }
    Start-Sleep -Milliseconds 50
  }
  $pidValue = [int](Get-Content (Join-Path $fixture 'ready') -Raw)
  if ($pidValue -ne $server.Id) { throw 'Gateway process identity mismatch' }
  Invoke-Fixture 'client' $pipe $pidValue $credentials[$owner]
  Invoke-Fixture 'denied' $pipe $pidValue $credentials[$other]
  $control = Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Credential $credentials[$owner] -WorkingDirectory $fixture -PassThru `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $fixture 'control.ps1')) `
    -RedirectStandardOutput (Join-Path $evidence 'control.json') -RedirectStandardError (Join-Path $evidence 'control-error.txt')
  $null = $control.Handle
  if (-not $control.WaitForExit(25000)) { $control.Kill(); $control.WaitForExit(); throw 'SMB control timed out' }
  if ($control.ExitCode -ne 0) { Get-Content (Join-Path $evidence 'control-error.txt'); throw 'SMB control failed' }
  Invoke-Fixture 'remote-denied' "\\$env:COMPUTERNAME\pipe\metawork-gateway-$suffix" $pidValue $credentials[$owner]
  Invoke-Fixture 'client' $pipe $pidValue $credentials[$owner]
  Set-Content (Join-Path $fixture 'stop') 'stop'
  if (-not $server.WaitForExit(15000)) { throw 'Gateway did not close' }
  if ($server.ExitCode -ne 0) { Get-Content (Join-Path $evidence 'server-error.txt'); throw 'Gateway failed' }
  @{ passed = $true; scope = 'production-gateway-native-transport'; standardUser = $true;
     crossAccountDenied = $true; endpointReadDenied = $true; smbPositiveControl = $true;
     smbRemoteDenied = $true; windows11Acceptance = $false } | ConvertTo-Json | Set-Content (Join-Path $evidence 'result.json')
} finally {
  if ($server -and -not $server.HasExited) { $server.Kill(); $server.WaitForExit() }
  foreach ($name in $created) { Remove-LocalUser -Name $name }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
