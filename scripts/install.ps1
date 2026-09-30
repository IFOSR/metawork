param(
  [string]$ManifestUrl = $env:METAWORK_INSTALL_MANIFEST,
  [string]$InstallRoot = $env:METAWORK_INSTALL_ROOT,
  [string]$Channel = $(if ($env:METAWORK_RELEASE_CHANNEL) { $env:METAWORK_RELEASE_CHANNEL } else { 'preview' }),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TrustedKeyId = 'metawork-release-2026-03'
$TrustedPublicKey = @'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJm/qnGNd9Aeg+41GoIjKOgpasxivfCXJCsZwyMbyIVE=
-----END PUBLIC KEY-----
'@

if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA 'MetaWork'
}
if (-not $ManifestUrl) {
  $ManifestUrl = "https://14.103.216.193/metawork-release/latest/manifest.win32-x64.json"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js >= 22.19.0 is required.'
}

if ($Uninstall) {
  if (Test-Path $InstallRoot) {
    Remove-Item -Recurse -Force $InstallRoot
  }
  Write-Output "Uninstalled MetaWork from $InstallRoot."
  exit 0
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("metawork-release-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $staging | Out-Null
try {
  $manifestPath = Join-Path $staging 'manifest.json'
  Invoke-WebRequest -UseBasicParsing -Uri $ManifestUrl -OutFile $manifestPath

  $verifyScript = Join-Path $staging 'verify-manifest.mjs'
  @'
import { readFileSync } from 'node:fs';
import { verify } from 'node:crypto';

const [manifestPath, expectedChannel, trustedKeyId, trustedPublicKey] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.channel !== expectedChannel) throw new Error('channel mismatch');
if (manifest.platform !== 'win32' || manifest.arch !== 'x64') {
  throw new Error('this installer only accepts win32-x64 releases');
}
if (Date.parse(manifest.expiresAt) <= Date.now()) throw new Error('manifest expired');
if (manifest.signature?.algorithm !== 'ed25519') throw new Error('unsupported signature algorithm');
if (manifest.signature.keyId !== trustedKeyId) throw new Error('unknown release signing key');
const { signature, ...payload } = manifest;
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
if (!verify(null, Buffer.from(stable(payload)), trustedPublicKey,
  Buffer.from(signature.value, 'base64'))) {
  throw new Error('release manifest signing verification failed');
}
process.stdout.write(JSON.stringify({
  releaseId: manifest.releaseId,
  runtimeUrl: manifest.metawork.url,
  runtimeSha256: manifest.metawork.sha256,
  plannerUrl: manifest.planner.url,
  plannerSha256: manifest.planner.sha256,
}));
'@ | Set-Content -Encoding UTF8 $verifyScript

  $metadata = & node $verifyScript $manifestPath $Channel $TrustedKeyId $TrustedPublicKey | ConvertFrom-Json
  $manifestUri = [Uri]$ManifestUrl
  $runtimeUri = [Uri]::new($manifestUri, [string]$metadata.runtimeUrl)
  $plannerUri = [Uri]::new($manifestUri, [string]$metadata.plannerUrl)
  $runtimeArchive = Join-Path $staging 'metawork.zip'
  $plannerArchive = Join-Path $staging 'planner.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $runtimeUri -OutFile $runtimeArchive
  Invoke-WebRequest -UseBasicParsing -Uri $plannerUri -OutFile $plannerArchive

  $runtimeHash = (Get-FileHash -Algorithm SHA256 $runtimeArchive).Hash.ToLowerInvariant()
  $plannerHash = (Get-FileHash -Algorithm SHA256 $plannerArchive).Hash.ToLowerInvariant()
  if ($runtimeHash -ne [string]$metadata.runtimeSha256) { throw 'Runtime artifact hash mismatch.' }
  if ($plannerHash -ne [string]$metadata.plannerSha256) { throw 'Planner artifact hash mismatch.' }

  $runtimeRoot = Join-Path $staging 'runtime'
  $plannerRoot = Join-Path $staging 'planner'
  Expand-Archive -Path $runtimeArchive -DestinationPath $runtimeRoot -Force
  Expand-Archive -Path $plannerArchive -DestinationPath $plannerRoot -Force
  $runtimeRoot = Join-Path $runtimeRoot 'metawork'
  $plannerRoot = Join-Path $plannerRoot 'planner'
  if (-not (Test-Path (Join-Path $runtimeRoot 'dist\install-cli.js'))) {
    throw 'Verified Runtime artifact is missing dist\install-cli.js.'
  }

  $command = if (Test-Path (Join-Path $InstallRoot 'app\current')) { 'update' } else { 'install' }
  $env:METAWORK_INSTALL_ROOT = $InstallRoot
  $env:METAWORK_SECRET_STORE = 'file'
  & node (Join-Path $runtimeRoot 'dist\install-cli.js') $command $metadata.releaseId `
    '--source-root' $runtimeRoot '--planner-root' $plannerRoot
  if ($LASTEXITCODE -ne 0) { throw "MetaWork installer failed with exit code $LASTEXITCODE." }
} finally {
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
}
