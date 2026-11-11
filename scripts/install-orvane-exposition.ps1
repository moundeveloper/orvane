param(
    [string]$ConfigDirectory = (Join-Path $env:USERPROFILE '.claude'),
    [string]$McpConfig = (Join-Path $env:USERPROFILE '.claude.json'),
    [string]$DesktopConfig = (Join-Path $env:APPDATA 'Claude/claude_desktop_config.json')
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$nodePath = (Get-Command node -ErrorAction Stop).Source
if ($env:CLAUDE_CONFIG_DIR -and $ConfigDirectory -eq (Join-Path $env:USERPROFILE '.claude')) { throw 'A custom Claude profile is active. Supply its ConfigDirectory and McpConfig explicitly.' }
New-Item -ItemType Directory -Force -Path $ConfigDirectory | Out-Null
function Read-Object([string]$path) { if (Test-Path -LiteralPath $path) { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable }; return @{} }
$launchPath = Join-Path $projectRoot 'server/launch.mjs'
$dataPath = Join-Path $projectRoot '.orvane'
function Test-OrvaneEntry($entry, [string[]]$profiles) {
    return $entry.command -eq $nodePath -and $entry.args.Count -eq 1 -and
        $entry.args[0] -eq $launchPath -and $entry.env.ORVANE_DATA_DIR -eq $dataPath -and
        $entry.env.ORVANE_MCP_PROFILE -in $profiles
}
$configs = [ordered]@{}
foreach ($path in @($McpConfig, $DesktopConfig)) {
    $path = [IO.Path]::GetFullPath($path)
    $config = Read-Object $path
    if (-not $config.ContainsKey('mcpServers')) { $config.mcpServers = @{} }
    $existing = $config.mcpServers.orvane
    $legacy = $config.mcpServers.'orvane-exposition'
    if ($null -ne $existing -and -not (Test-OrvaneEntry $existing @('netsuite', 'desktop'))) {
        throw "A different orvane entry exists in $path. Inspect it before replacing it."
    }
    if ($null -ne $legacy -and -not (Test-OrvaneEntry $legacy @('exposition'))) {
        throw "A different orvane-exposition entry exists in $path. Inspect it before removing it."
    }
    if ($existing.env.ORVANE_MCP_PROFILE -eq 'desktop' -and $null -eq $legacy) { continue }
    if ($null -eq $existing) {
        $existing = @{type='stdio';command=$nodePath;args=@($launchPath);env=@{ORVANE_DATA_DIR=$dataPath}}
        $config.mcpServers.orvane = $existing
    }
    if ($null -ne $legacy) {
        foreach ($name in $legacy.env.Keys) {
            if ($name -eq 'ORVANE_MCP_PROFILE') { continue }
            if ($existing.env.Contains($name) -and $existing.env[$name] -cne $legacy.env[$name]) {
                throw "Conflicting Orvane environment variable $name in $path."
            }
            $existing.env[$name] = $legacy.env[$name]
        }
        $config.mcpServers.Remove('orvane-exposition')
    }
    $existing.env.ORVANE_MCP_PROFILE = 'desktop'
    $configs[$path] = $config
}
$settingsPath = [IO.Path]::GetFullPath((Join-Path $ConfigDirectory 'settings.json'))
$settings = Read-Object $settingsPath
if (-not $settings.ContainsKey('hooks')) { $settings.hooks = @{} }
$hookFile = Join-Path $projectRoot 'scripts/orvane-session-context.mjs'
$hookCommand = '"' + $nodePath + '" "' + $hookFile + '"'
$starts = @($settings.hooks.SessionStart | Where-Object { $null -ne $_ })
if (-not ($starts | Where-Object { $_.hooks | Where-Object { $_.command -eq $hookCommand } })) {
    $settings.hooks.SessionStart = $starts + @{hooks=@(@{type='command';command=$hookCommand})}
    $configs[$settingsPath] = $settings
}
$backupDir = Join-Path $ConfigDirectory 'backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-ffff'
foreach ($path in $configs.Keys) {
    $directory = Split-Path -Parent $path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = Join-Path $directory ('.orvane-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $configs[$path] | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $temporary -Encoding utf8
        if (Test-Path -LiteralPath $path) {
            Copy-Item -LiteralPath $path -Destination (Join-Path $backupDir ((Split-Path $path -Leaf) + '.orvane-' + $stamp + '.bak'))
            [IO.File]::Move($temporary, $path, $true)
        } else {
            [IO.File]::Move($temporary, $path)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}
$skillDir = Join-Path $ConfigDirectory 'skills/orvane-exposition'
if (Test-Path -LiteralPath $skillDir) { $previous = Join-Path $skillDir 'SKILL.md'; if ((Test-Path -LiteralPath $previous) -and (Get-Content -LiteralPath $previous -Raw) -ne (Get-Content -LiteralPath (Join-Path $projectRoot 'skills/orvane-exposition/SKILL.md') -Raw)) { Copy-Item -LiteralPath $previous -Destination (Join-Path $backupDir ('orvane-exposition-skill-' + $stamp + '.md')) } }
New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'skills/orvane-exposition/SKILL.md') -Destination (Join-Path $skillDir 'SKILL.md') -Force
Write-Output 'Installed NetSuite and Exposition tools under the Orvane connector. Fully quit and reopen Claude Desktop, then open a local Code session.'
