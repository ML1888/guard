param(
    [switch]$Reload,
    [switch]$Demo
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendPath = Join-Path $PSScriptRoot "frontend"
$backendPath = Join-Path $PSScriptRoot "backend"
$dataRoot = Join-Path $projectRoot ".agentguard-runtime"
$nodeNpm = Join-Path $env:CONDA_PREFIX "npm.cmd"
$pythonExe = Join-Path $env:CONDA_PREFIX "python.exe"

if (-not $env:CONDA_PREFIX -or -not (Test-Path $nodeNpm) -or -not (Test-Path $pythonExe)) {
    throw "Activate a Conda environment containing Python and Node.js 22 before starting this service."
}

$cachePaths = @{
    temp = Join-Path $dataRoot "temp"
    npm = Join-Path $dataRoot "npm-cache"
    pip = Join-Path $dataRoot "pip-cache"
    python = Join-Path $dataRoot "python-cache"
    general = Join-Path $dataRoot "cache"
    huggingface = Join-Path $dataRoot "huggingface"
    uv = Join-Path $dataRoot "uv-cache"
}
$cachePaths.Values | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

$env:AGENTGUARD_DATA_ROOT = $dataRoot
$env:AGENTGUARD_RUNTIME_ROOT = Join-Path $dataRoot "non-git-runs"
$env:TEMP = $cachePaths.temp
$env:TMP = $cachePaths.temp
$env:TMPDIR = $cachePaths.temp
$env:npm_config_cache = $cachePaths.npm
$env:PIP_CACHE_DIR = $cachePaths.pip
$env:PYTHONPYCACHEPREFIX = $cachePaths.python
$env:XDG_CACHE_HOME = $cachePaths.general
$env:HF_HOME = $cachePaths.huggingface
$env:HF_DATASETS_CACHE = Join-Path $cachePaths.huggingface "datasets"
$env:UV_CACHE_DIR = $cachePaths.uv

Push-Location $frontendPath
try {
    if (-not (Test-Path "node_modules") -or -not (Test-Path "node_modules\@types\node")) {
        & $nodeNpm install
        if ($LASTEXITCODE -ne 0) { throw "Frontend dependency installation failed." }
    }
    & $nodeNpm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
}
finally {
    Pop-Location
}

$env:AGENTGUARD_ROOT = Join-Path $projectRoot "codex-process-supervisor-main"
if ($Demo) {
    $env:AGENTGUARD_DEMO = "vip-discount"
}
else {
    Remove-Item Env:AGENTGUARD_DEMO -ErrorAction SilentlyContinue
}
Push-Location $backendPath
try {
    $uvicornArgs = @("-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000")
    if ($Reload) { $uvicornArgs += "--reload" }
    & $pythonExe @uvicornArgs
}
finally {
    Pop-Location
}
