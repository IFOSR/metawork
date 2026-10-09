# Runs only as the disposable standard user after the environment bootstrap.
$ErrorActionPreference = 'Stop'
$origin = 'http://10.0.2.2:8765/@TOKEN@'
$root = Join-Path $env:TEMP 'metawork-product-acceptance'
$evidence = Join-Path $root 'evidence'
New-Item -ItemType Directory -Force $evidence | Out-Null
$result = @{ scope = 'windows11-desktop-product'; sourceCommit = '@SOURCE_COMMIT@'; passed = $false }
try {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Standard user required' }
  $zip = Join-Path $root 'acceptance.zip'
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri "$origin/kit" -OutFile $zip
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '@KIT_SHA256@') { throw 'Kit hash mismatch' }
  $kit = Join-Path $root 'kit'
  Expand-Archive -LiteralPath $zip -DestinationPath $kit
  $env:GITHUB_ACTIONS = 'true'
  $env:GITHUB_SHA = '@SOURCE_COMMIT@'
  $env:METAWORK_TEST_MODEL = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$origin/model").Content
  Push-Location $kit
  try {
    # Only this test process gets the provider input. Its output stays on the
    # disposable disk; upload only explicitly selected reports and screenshots.
    & (Join-Path $kit 'node.exe') 'scripts/probe-windows11-desktop.mjs' $evidence *> (Join-Path $root 'private-process.log')
    $exitCode = $LASTEXITCODE
  } finally { Pop-Location; Remove-Item Env:METAWORK_TEST_MODEL -ErrorAction SilentlyContinue }
  $result = Get-Content -Raw -LiteralPath (Join-Path $evidence 'windows11-product.json') | ConvertFrom-Json
  if ($exitCode -ne 0 -or -not $result.passed) { throw 'Product assertions failed' }
} catch {
  $result = @{ scope = 'windows11-desktop-product'; sourceCommit = '@SOURCE_COMMIT@'; passed = $false
    errorType = $_.Exception.GetType().Name; processExitCode = $exitCode }
} finally {
  Remove-Item Env:METAWORK_TEST_MODEL -ErrorAction SilentlyContinue
  $names = @('packaged-install.json', 'packaged-install.png', 'packaged-install-failure.json', 'packaged-install-failure.png',
    'packaged-setup-progress.json', 'real-model-task.json', 'native-terminal.json', 'ordinary-browser.json',
    'real-artifact-task.png', 'real-cancelled-task.png', 'browser-artifact.png', 'browser-cancelled.png',
    'reinstall/packaged-install.json', 'reinstall/packaged-install.png')
  foreach ($name in $names) {
    $path = Join-Path $evidence $name
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $bytes = [IO.File]::ReadAllBytes($path)
      if ($bytes.Length -le 8MB) {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Method Post -Uri "$origin/product/$name" -Body $bytes | Out-Null
      }
    }
  }
  $body = [Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Compress))
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Method Post -Uri "$origin/product-result" -Body $body | Out-Null
}
