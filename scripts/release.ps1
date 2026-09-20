# Thin PowerShell wrapper around scripts/release.mjs.
# All release logic lives in release.mjs (single source of truth);
# this file only forwards arguments so you can also run it as .\scripts\release.ps1
#
# Usage:
#   .\scripts\release.ps1              # normal release
#   .\scripts\release.ps1 --dry-run    # preview only
#   .\scripts\release.ps1 0.2.0-rc.1   # explicit version

node "$PSScriptRoot\release.mjs" @args
exit $LASTEXITCODE
