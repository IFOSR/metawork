$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo '.tmp/windows-pipe-probe/Release/metawork-process-probe.exe'
$evidence = Join-Path $repo '.tmp/windows-desktop-validation/process-job'
$fixture = Join-Path $env:TEMP ('metawork-process-p0-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $evidence, $fixture | Out-Null
$process = $null
try {
  $process = Start-Process $exe -ArgumentList @('probe', ('"' + $fixture + '"')) -PassThru `
    -RedirectStandardOutput (Join-Path $evidence 'result.json') `
    -RedirectStandardError (Join-Path $evidence 'error.txt')
  if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Job process probe timed out' }
  if ($process.ExitCode -ne 0) {
    Get-Content (Join-Path $evidence 'error.txt')
    throw 'Job process probe failed'
  }
} finally {
  if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
