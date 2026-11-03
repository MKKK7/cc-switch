param(
    [string]$Toolchain = '1.95-x86_64-pc-windows-gnu',
    [string]$MinGWBin = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    if ($MinGWBin) { $env:PATH = "$MinGWBin;$env:PATH" }
    $env:PATH = "$(Join-Path $env:USERPROFILE '.cargo\bin');$env:PATH"
    $env:RUSTUP_TOOLCHAIN = $Toolchain
    $env:CARGO_PROFILE_DEV_DEBUG = '0'
    $env:TAURI_CONFIG = Get-Content 'src-tauri/tauri.trae.conf.json' -Raw
    if (!(Test-Path node_modules)) {
        npm exec --yes --package=pnpm@10.12.3 -- pnpm install --frozen-lockfile
        if ($LASTEXITCODE) { throw 'Dependency installation failed' }
    }
    npm run build:renderer
    if ($LASTEXITCODE) { throw 'Frontend build failed' }
    cargo build --manifest-path src-tauri/Cargo.toml --features 'tauri/custom-protocol,portable-no-console' --bin cc-switch
    if ($LASTEXITCODE) { throw 'Rust build failed' }
    $output = Join-Path $repo 'release\providers-portable'
    New-Item -ItemType Directory -Force $output | Out-Null
    Copy-Item 'src-tauri/target/debug/cc-switch.exe' $output
    if (Test-Path 'src-tauri/target/debug/WebView2Loader.dll') { Copy-Item 'src-tauri/target/debug/WebView2Loader.dll' $output }
    Copy-Item 'trae-adapter' $output -Recurse -Force
    Copy-Item 'commandcode-adapter' $output -Recurse -Force
    Copy-Item 'LICENSE' $output
    Copy-Item 'scripts/Start-CCSwitch-Trae.ps1' $output
    if ($MinGWBin) {
        foreach ($dll in @('libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll')) {
            $dllPath = Join-Path $MinGWBin $dll
            if (Test-Path $dllPath) { Copy-Item $dllPath $output }
        }
    }
    Write-Output "Portable build: $output"
} finally { Pop-Location }
