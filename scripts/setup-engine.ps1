$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Root ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"
$Requirements = Join-Path $Root "engine\requirements.txt"
$Temp = Join-Path $Root ".tmp"
$PipCache = Join-Path $Temp "pip-cache"

New-Item -ItemType Directory -Force -Path $Temp | Out-Null
New-Item -ItemType Directory -Force -Path $PipCache | Out-Null

$env:TEMP = $Temp
$env:TMP = $Temp
$env:PIP_CACHE_DIR = $PipCache

function Invoke-Checked {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  Write-Host $Label
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

if (!(Test-Path $Venv)) {
  Invoke-Checked "Creating Python virtual environment..." { python -m venv $Venv }
}

Invoke-Checked "Bootstrapping pip..." { & $Python -m ensurepip --upgrade --default-pip }

Invoke-Checked "Upgrading pip..." { & $Python -m pip install --upgrade pip }

Invoke-Checked "Installing local transcription engine..." {
  & $Python -m pip install -r $Requirements --extra-index-url https://download.pytorch.org/whl/cu124
}

Write-Host ""
Write-Host "Verifying CUDA availability..."
try {
  & $Python -c "import torch; print(f'PyTorch {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}'); print(f'GPU: {torch.cuda.get_device_name(0)}' if torch.cuda.is_available() else 'No GPU detected')"
} catch {
  Write-Host "  Could not verify CUDA (this is OK for CPU-only usage)"
}

Write-Host ""
Write-Host "Engine ready. Start the desktop app with: npm run dev"
Write-Host "  Default: auto-detects RTX GPU and uses CUDA float16 inference"
Write-Host "  CPU fallback: python engine/transcribe.py audio.mp3 --output out.vtt --device cpu"
