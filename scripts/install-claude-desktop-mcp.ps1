# Requires PowerShell 7 (ConvertFrom-Json -AsHashtable preserves case-sensitive keys).
param(
    [string]$ConfigPath = (Join-Path $env:APPDATA 'Claude/claude_desktop_config.json')
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodePath = (Get-Command node -ErrorAction Stop).Source
$launchPath = Join-Path $projectRoot 'server/launch.mjs'
$dataPath = Join-Path $projectRoot '.orvane'
$configExists = Test-Path -LiteralPath $ConfigPath
$config = if ($configExists) {
    Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json -AsHashtable
} else { [ordered]@{} }
if (-not $config.Contains('mcpServers')) { $config['mcpServers'] = [ordered]@{} }
$existing = $config['mcpServers']['orvane']
if ($existing) {
    if ($existing.command -eq $nodePath -and $existing.args.Count -eq 1 -and
        [IO.Path]::GetFullPath($existing.args[0]) -eq [IO.Path]::GetFullPath($launchPath) -and
        $existing.env.ORVANE_MCP_PROFILE -eq 'netsuite' -and
        $existing.env.ORVANE_DATA_DIR -eq $dataPath) {
        Write-Output 'Orvane is already installed in Claude Desktop with the Batch 1 NetSuite profile.'
        exit 0
    }
    throw 'A different Orvane entry already exists in Claude Desktop. Inspect it before replacing it.'
}
$config['mcpServers']['orvane'] = [ordered]@{
    command = $nodePath
    args = @($launchPath)
    env = [ordered]@{ ORVANE_MCP_PROFILE = 'netsuite'; ORVANE_DATA_DIR = $dataPath }
}
$directory = Split-Path -Parent ([IO.Path]::GetFullPath($ConfigPath))
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$temporary = Join-Path $directory ('.orvane-mcp-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    [IO.File]::WriteAllText($temporary, (($config | ConvertTo-Json -Depth 100) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    if ($configExists) {
        $backup = $ConfigPath + '.before-orvane-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.bak'
        [IO.File]::Replace($temporary, [IO.Path]::GetFullPath($ConfigPath), $backup)
        Write-Output "Backed up the original configuration to $backup"
    } else {
        [IO.File]::Move($temporary, [IO.Path]::GetFullPath($ConfigPath))
    }
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
Write-Output 'Installed Orvane alongside existing Claude Desktop servers. Fully quit Claude Desktop, reopen it, and check Settings > Developer > Local MCP servers.'
