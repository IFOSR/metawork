$ErrorActionPreference = 'Stop'

npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
docker build -f docker/Dockerfile.attempt-codex -t metaclaw-executor-codex:phase5 .
if ($LASTEXITCODE -ne 0) { throw "Codex attempt image build failed with exit code $LASTEXITCODE" }
docker build -f docker/Dockerfile.attempt-pi -t metaclaw-executor-pi:phase5 .
if ($LASTEXITCODE -ne 0) { throw "Pi attempt image build failed with exit code $LASTEXITCODE" }
