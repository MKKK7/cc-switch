param([switch]$Preview)
$ErrorActionPreference = 'Stop'
$previousTestHome = $env:CC_SWITCH_TEST_HOME
$exe = Join-Path $PSScriptRoot 'cc-switch.exe'
if (!(Test-Path $exe)) { throw 'Run this script from the built trae-portable folder.' }
if ($Preview) {
    # Separate config and client home for testing, not the installed CLI profile.
    $env:CC_SWITCH_TEST_HOME = Join-Path $PSScriptRoot 'preview-home'
    New-Item -ItemType Directory -Force $env:CC_SWITCH_TEST_HOME | Out-Null
} else {
    if (Get-Process 'cc-switch' -ErrorAction SilentlyContinue) {
        throw 'Please exit the existing CC Switch before starting this fork. No process was stopped.'
    }
    # Snapshot the existing default config before the newer fork opens it.
    $config = Join-Path $env:USERPROFILE '.cc-switch'
    if (Test-Path $config) {
        $backup = Join-Path $PSScriptRoot ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Force $backup | Out-Null
        Copy-Item -LiteralPath $config -Destination $backup -Recurse
    }
}
try {
    Start-Process -FilePath $exe -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
} finally {
    $env:CC_SWITCH_TEST_HOME = $previousTestHome
}
