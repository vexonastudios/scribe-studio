$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# -- Resolve paths ---------------------------------------------------------------
# When installed: $PSScriptRoot = <install>\resources\scripts\
#   Split-Path -Parent -> <install>\resources\  (engine\ lives here)
# When in dev:    $PSScriptRoot = <project>\scripts\
#   Split-Path -Parent -> <project>\           (engine\ lives here too)

$ResourcesDir     = Split-Path -Parent $PSScriptRoot
$RequirementsFile = Join-Path $ResourcesDir "engine\requirements.txt"

# .venv and pip cache always go into %APPDATA%\Scribe Studio (always writable)
$UserDataDir = Join-Path $env:APPDATA "Scribe Studio"
$Venv        = Join-Path $UserDataDir ".venv"
$PipCache    = Join-Path $UserDataDir "pip-cache"

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $PipCache   | Out-Null

$env:PIP_CACHE_DIR = $PipCache

Write-Host "Resources dir : $ResourcesDir"
Write-Host "Requirements  : $RequirementsFile"
Write-Host "Venv location : $Venv"
Write-Host ""

if (!(Test-Path $RequirementsFile)) {
    throw "requirements.txt not found at: $RequirementsFile`nPlease reinstall the app."
}

# -- Helper: run a command and throw if it fails ---------------------------------
function Invoke-Checked {
    param([string]$Label, [scriptblock]$Command)
    Write-Host $Label
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

# -- Helper: refresh PATH from registry ------------------------------------------
function Update-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path    = @($machinePath, $userPath) -join ";"
}

# -- Helper: find Python 3 on current PATH ----------------------------------------
function Find-Python {
    foreach ($candidate in @("py", "python3", "python")) {
        try {
            $ver = & $candidate --version 2>&1
            if ($LASTEXITCODE -eq 0 -and "$ver" -match "Python 3") {
                Write-Host "Found Python: $candidate ($ver)"
                return $candidate
            }
        } catch { }
    }
    return $null
}

# -- Step 1: Ensure Python 3 is available ----------------------------------------
$SystemPython = Find-Python

if (-not $SystemPython) {
    Write-Host "Python 3 not found on PATH. Attempting automatic installation..."
    Write-Host ""

    $pythonInstalled = $false

    # Method A: winget (built into Windows 10 1709+ and Windows 11)
    try {
        Write-Host "Trying winget..."
        winget install --id Python.Python.3.12 -e --silent `
            --accept-package-agreements --accept-source-agreements 2>&1
        if ($LASTEXITCODE -eq 0) {
            Update-Path
            $SystemPython = Find-Python
            if ($SystemPython) {
                Write-Host "Python installed via winget."
                $pythonInstalled = $true
            }
        }
    } catch {
        Write-Host "  winget not available or failed, trying direct download..."
    }

    # Method B: Download Python installer from python.org
    if (-not $pythonInstalled) {
        Write-Host "Downloading Python 3.12 installer (~25 MB)..."
        $pyVersion   = "3.12.10"
        $pyUrl       = "https://www.python.org/ftp/python/$pyVersion/python-$pyVersion-amd64.exe"
        $pyInstaller = Join-Path $env:TEMP "python-$pyVersion-setup.exe"

        try {
            Invoke-WebRequest $pyUrl -OutFile $pyInstaller -UseBasicParsing
            Write-Host "Installing Python silently (this takes ~1 minute)..."
            & $pyInstaller /quiet `
                InstallAllUsers=0 `
                PrependPath=1 `
                Include_pip=1 `
                Include_test=0 `
                Include_doc=0
            Start-Sleep -Seconds 5   # give installer time to finish writing PATH
            Update-Path
            $SystemPython = Find-Python

            if ($SystemPython) {
                Write-Host "Python installed successfully."
                $pythonInstalled = $true
            } else {
                throw "Python was installed but could not be found on PATH after installation."
            }
        } catch {
            throw @"
Automatic Python installation failed: $_

Please install Python 3.10+ manually:
  1. Go to https://python.org/downloads
  2. Download the Windows installer
  3. Run it and check 'Add Python to PATH'
  4. Reopen the app and click Retry
"@
        } finally {
            # Clean up installer
            try { Remove-Item $pyInstaller -Force } catch { }
        }
    }
}

# -- Step 2: Create venv if needed -----------------------------------------------
if (!(Test-Path $Venv)) {
    Invoke-Checked "Creating Python virtual environment..." { & $SystemPython -m venv $Venv }
} else {
    Write-Host "Existing venv found at $Venv -- updating packages..."
}

$VenvPython = Join-Path $Venv "Scripts\python.exe"

# -- Step 3: Install packages ----------------------------------------------------
Invoke-Checked "Bootstrapping pip..."     { & $VenvPython -m ensurepip --upgrade --default-pip }
Invoke-Checked "Upgrading pip..."         { & $VenvPython -m pip install --upgrade pip }

Write-Host "Installing transcription engine (downloading ~3-4 GB -- please wait, this takes several minutes)..."
& $VenvPython -m pip install -r $RequirementsFile `
    --extra-index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) {
    throw "Package installation failed with exit code $LASTEXITCODE"
}

# -- Step 4: Verify CUDA ---------------------------------------------------------
Write-Host ""
Write-Host "Verifying GPU / CUDA availability..."
try {
    $ptVer  = & $VenvPython -c "import torch; print(torch.__version__)" 2>&1
    $cudaOk = & $VenvPython -c "import torch; print(torch.cuda.is_available())" 2>&1
    Write-Host "  PyTorch $ptVer"
    if ($cudaOk -eq "True") {
        $gpuName = & $VenvPython -c "import torch; print(torch.cuda.get_device_name(0))" 2>&1
        $vramGb  = & $VenvPython -c "import torch; print(round(torch.cuda.get_device_properties(0).total_memory/1024**3,1))" 2>&1
        Write-Host "  GPU: $gpuName ($vramGb GB VRAM)"
    } else {
        Write-Host "  No NVIDIA GPU detected - CPU mode will be used (slower but fully functional)"
    }
} catch {
    Write-Host "  Could not verify CUDA - CPU mode will be used."
}

Write-Host ""
Write-Host "Engine setup complete!"
