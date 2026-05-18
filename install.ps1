<#
.SYNOPSIS
  One-command Windows installer for CEBAB.

.DESCRIPTION
  Fetch + run, nothing else to type:

      irm https://raw.githubusercontent.com/maxopich/claude-code-wrapper/main/install.ps1 | iex

  `irm | iex` runs this script as a *string*, so it is NOT subject to the
  PowerShell execution policy (no Set-ExecutionPolicy needed) and needs no Git
  to fetch itself. The script then:

    1. Installs Git and Node.js LTS via winget if they are missing. Windows
       shows a UAC elevation prompt for those installs. If winget is
       unavailable it prints exact manual instructions and stops.
    2. Clones (or fast-forward-pulls) the repo into .\claude-code-wrapper.
    3. Verifies the `claude` CLI is present. It is a hard prerequisite and is
       deliberately NOT auto-installed (no global npm changes) - if absent the
       script prints how to install + log in, then stops before bootstrap.
    4. Runs `npm run bootstrap` (deps + the one native better-sqlite3 build +
       git hooks).

  Idempotent - safe to re-run: clone becomes a ff-pull, prereq installs are
  skipped when already present.

  Preview everything without changing the system (dry run):

      & ([scriptblock]::Create((irm https://raw.githubusercontent.com/maxopich/claude-code-wrapper/main/install.ps1))) -DryRun

  Compatible with Windows PowerShell 5.1 and PowerShell 7+.

.PARAMETER DryRun
  Print every system-changing action instead of performing it. Detection
  (winget / Git / Node / claude presence) still runs so the preview is accurate.

.PARAMETER InstallDir
  Parent directory for the checkout. Default: the current directory. The repo
  lands in <InstallDir>\claude-code-wrapper.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$InstallDir = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

$RepoUrl  = 'https://github.com/maxopich/claude-code-wrapper.git'
$RawUrl   = 'https://raw.githubusercontent.com/maxopich/claude-code-wrapper/main/install.ps1'
$OneLiner = "irm $RawUrl | iex"

function Write-Step   { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Gray }
function Write-DryRun { param([string]$Message) Write-Host "[dry-run] would: $Message" -ForegroundColor DarkYellow }

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Update-PathFromRegistry {
  # winget puts Git/Node on PATH via the registry; the current process keeps
  # its stale PATH until we re-read Machine + User and rebuild it in-process.
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts   = @()
  if ($machine) { $parts += $machine }
  if ($user)    { $parts += $user }
  $env:Path = ($parts -join ';')
}

function Install-Prereq {
  param(
    [string]$Command,
    [string]$WingetId,
    [string]$Friendly,
    [bool]$HasWinget
  )

  if (Test-Command $Command) {
    Write-Note "$Friendly already installed."
    return
  }

  if (-not $HasWinget) {
    Write-Host ""
    Write-Host "$Friendly is required but not installed, and winget is unavailable." -ForegroundColor Red
    Write-Note "Install winget (App Installer):  https://aka.ms/getwinget"
    Write-Note "or install the prerequisites directly:"
    Write-Note "  Git       https://git-scm.com/download/win"
    Write-Note "  Node LTS  https://nodejs.org/en/download"
    Write-Note "then re-run:  $OneLiner"
    throw "$Friendly missing and winget unavailable"
  }

  if ($DryRun) {
    Write-DryRun "winget install --id $WingetId -e   (installs $Friendly; Windows prompts for elevation)"
    return
  }

  Write-Step "Installing $Friendly via winget (a Windows elevation prompt is expected)..."
  & winget install --id $WingetId -e --source winget --accept-source-agreements --accept-package-agreements --silent
  $code = $LASTEXITCODE
  Update-PathFromRegistry

  if (Test-Command $Command) {
    Write-Note "$Friendly installed."
    return
  }

  if ($code -ne 0) {
    Write-Note "winget exited with code $code."
  }
  Write-Host ""
  Write-Host "$Friendly was installed but is not visible in this shell yet." -ForegroundColor Yellow
  Write-Note "Open a NEW PowerShell window and re-run (safe to re-run):"
  Write-Note "  $OneLiner"
  throw "$Friendly not on PATH in this session"
}

function Get-Repo {
  param([string]$Target)

  if (Test-Path -LiteralPath $Target) {
    if (Test-Path -LiteralPath (Join-Path $Target '.git')) {
      Write-Step "Updating existing checkout ($Target)..."
      if ($DryRun) { Write-DryRun "git -C `"$Target`" pull --ff-only"; return }
      & git -C $Target pull --ff-only
      if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed in $Target" }
      return
    }
    throw "Path exists but is not a git checkout: $Target  (remove it or pass -InstallDir elsewhere)"
  }

  Write-Step "Cloning $RepoUrl ..."
  if ($DryRun) { Write-DryRun "git clone $RepoUrl `"$Target`""; return }
  & git clone $RepoUrl $Target
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}

function Invoke-Install {
  Write-Host ""
  Write-Host "CEBAB Windows installer" -ForegroundColor Green
  if ($DryRun) { Write-Host "(dry run - nothing will be changed)" -ForegroundColor DarkYellow }
  Write-Note "Installs Git + Node.js LTS via winget if missing (UAC prompt expected),"
  Write-Note "clones the repo, then runs 'npm run bootstrap'."
  Write-Host ""

  $hasWinget = Test-Command 'winget'
  if (-not $hasWinget) {
    Write-Note "winget not detected - will fall back to printed instructions if a prereq is missing."
  }

  Install-Prereq -Command 'git'  -WingetId 'Git.Git'          -Friendly 'Git'         -HasWinget $hasWinget
  Install-Prereq -Command 'node' -WingetId 'OpenJS.NodeJS.LTS' -Friendly 'Node.js LTS' -HasWinget $hasWinget

  $target = Join-Path $InstallDir 'claude-code-wrapper'
  Get-Repo -Target $target

  if ($DryRun) {
    Write-DryRun "Set-Location `"$target`""
  } else {
    Set-Location -LiteralPath $target
  }

  # claude CLI: hard prerequisite, deliberately NOT auto-installed (no global
  # npm mutation). Fail fast here so the user is not surprised post-bootstrap.
  if (Test-Command 'claude') {
    Write-Note "claude CLI found."
  } else {
    Write-Host ""
    Write-Host "The 'claude' CLI is required and was not found." -ForegroundColor Red
    Write-Note "1) Install it:   npm install -g @anthropic-ai/claude-code"
    Write-Note "2) Log in:       claude        (verify with:  claude auth status )"
    Write-Note "3) Re-run (safe to re-run):"
    Write-Note "     $OneLiner"
    if ($DryRun) {
      Write-DryRun "stop here (claude missing) - exit before bootstrap"
    } else {
      throw "claude CLI not installed"
    }
  }

  Write-Step "Running npm run bootstrap (deps + native better-sqlite3 build + git hooks)..."
  if ($DryRun) {
    Write-DryRun "npm run bootstrap"
  } else {
    & npm run bootstrap
    if ($LASTEXITCODE -ne 0) {
      throw "npm run bootstrap failed (exit $LASTEXITCODE) - scroll up for the error, then re-run"
    }
  }

  Write-Host ""
  Write-Host "Done." -ForegroundColor Green
  Write-Note "Next steps:"
  Write-Note "  cd claude-code-wrapper"
  Write-Note "  npm run dev          # server :4319 + web :5173 (Ctrl+C stops both)"
  Write-Note "  then open http://127.0.0.1:5173"
  Write-Note "Optional: copy .env.example to .env to override workspace root / port / mock."
  Write-Note "Confirm Claude login any time with:  claude auth status"
}

try {
  Invoke-Install
} catch {
  Write-Host ""
  Write-Host ("Install aborted: " + $_.Exception.Message) -ForegroundColor Red
  # Signal failure to non-interactive callers WITHOUT calling `exit` - an
  # `irm | iex` run executes in the user's shell, and `exit` would close
  # their window and scroll the actionable guidance above off-screen.
  $global:LASTEXITCODE = 1
}
