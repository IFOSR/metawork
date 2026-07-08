# Launch the MetaClaw interactive TUI inside Docker with full input support.
#
# Why this exists:
#   - Ink (the React terminal UI) needs a real TTY; only `docker run -it` allocates one.
#   - The default config ships executor.command=codex, but the image only has `pi`.
#   - `pi` needs ~/.pi/agent/{models.json,settings.json} + OPENAI_API_KEY.
#
# Usage:
#   .\docker\run-tui.ps1                # build image if missing, then launch
#   .\docker\run-tui.ps1 -Rebuild       # force rebuild the image
#
# Requires: docker\pi.env to exist with OPENAI_API_KEY filled in.
[CmdletBinding()]
param(
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'

$repoRoot    = Split-Path -Parent $PSScriptRoot
$imageTag    = 'metaclaw-tui'
$envFile     = Join-Path $repoRoot 'docker\pi.env'
$tuiConfig   = Join-Path $repoRoot 'docker\tui-config.yaml'
$piConfigDir = Join-Path $repoRoot 'docker\pi-config'
$distDir     = Join-Path $repoRoot 'dist'
$workspace   = Join-Path $repoRoot '.tmp\tui-workspace'
$piAgentHome = Join-Path $repoRoot '.tmp\pi-agent-home'
$entrypoint  = Join-Path $repoRoot 'docker\entrypoint.sh'

if (-not (Test-Path $envFile)) {
    $msg = "Missing " + $envFile + ". Copy docker\pi.env.example to docker\pi.env and fill OPENAI_API_KEY."
    Write-Error $msg
    exit 1
}
if (-not (Test-Path $piConfigDir)) {
    Write-Error ("Missing Pi config dir: " + $piConfigDir)
    exit 1
}

# Host must have a built dist\ (the image's .dockerignore excludes dist, so we mount it).
if (-not (Test-Path (Join-Path $distDir 'index.js'))) {
    Write-Host 'dist\index.js not found, building (npm run build)...' -ForegroundColor Yellow
    Push-Location $repoRoot
    try { npm run build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Build the image if missing, or when -Rebuild is passed.
$needBuild = $false
if ($Rebuild) {
    $needBuild = $true
} else {
    docker image inspect $imageTag 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { $needBuild = $true }
}
if ($needBuild) {
    Write-Host ("Building image " + $imageTag + " ...") -ForegroundColor Yellow
    docker build -f (Join-Path $repoRoot 'Dockerfile.test') -t $imageTag $repoRoot
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Persist task artifacts and pi agent state across runs.
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
New-Item -ItemType Directory -Force -Path $piAgentHome | Out-Null

Write-Host 'Starting MetaClaw TUI (interactive)...' -ForegroundColor Cyan
Write-Host ('Workspace: ' + $workspace) -ForegroundColor DarkGray
Write-Host 'Tip: Ctrl+C to quit; /help for commands; /exit to leave.' -ForegroundColor DarkGray

# pi-config is mounted read-only as a template; entrypoint copies it into the
# writable piAgentHome so `pi` can write settings.json.lock without EROFS.
docker run -it --rm `
  --entrypoint /bin/bash `
  -v "${distDir}:/app/dist:ro" `
  -v "${tuiConfig}:/app/.metaclaw/config.yaml:ro" `
  -v "${piConfigDir}:/pi-config-template:ro" `
  -v "${piAgentHome}:/root/.pi/agent" `
  -v "${entrypoint}:/entrypoint.sh:ro" `
  -v "${workspace}:/workspace" `
  -w /workspace `
  --env-file $envFile `
  -e METACLAW_HOME=/app/.metaclaw `
  -e PI_SKIP_VERSION_CHECK=1 `
  -e PI_TELEMETRY=0 `
  $imageTag `
  /entrypoint.sh node /app/dist/index.js
