param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodePath = (Get-Command node -ErrorAction Stop).Source
$claudePath = (Get-Command claude -ErrorAction Stop).Source
$configPath = Join-Path $env:USERPROFILE '.claude.json'
if ($env:CLAUDE_CONFIG_DIR) {
    throw 'A custom CLAUDE_CONFIG_DIR is active. Run the documented claude mcp add command in that profile instead.'
}
if (Test-Path -LiteralPath $configPath) {
    $savedConfig = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json -AsHashtable
    $existing = $savedConfig.mcpServers.orvane
    if ($existing) {
        $launchPath = Join-Path $projectRoot 'server/launch.mjs'
        if ($existing.command -eq $nodePath -and $existing.args.Count -eq 1 -and
            [IO.Path]::GetFullPath($existing.args[0]) -eq [IO.Path]::GetFullPath($launchPath) -and
            $existing.env.ORVANE_MCP_PROFILE -in @('netsuite', 'desktop') -and
            $existing.env.ORVANE_DATA_DIR -eq (Join-Path $projectRoot '.orvane')) {
            Write-Output 'Orvane is already installed for Claude Code.'
            exit 0
        }
        throw 'A different user-scoped Orvane configuration already exists. Inspect it with claude mcp get orvane before replacing it.'
    }
    $backupDirectory = Join-Path $env:USERPROFILE '.claude/backups'
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $backupPath = Join-Path $backupDirectory ("before-orvane-mcp-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    Copy-Item -LiteralPath $configPath -Destination $backupPath
    Write-Output "Backed up Claude Code configuration to $backupPath"
}
& $claudePath mcp add --scope user --transport stdio orvane -e 'ORVANE_MCP_PROFILE=netsuite' -e "ORVANE_DATA_DIR=$(Join-Path $projectRoot '.orvane')" -- $nodePath (Join-Path $projectRoot 'server/launch.mjs')
if ($LASTEXITCODE -ne 0) { throw "Claude Code MCP installation failed (exit $LASTEXITCODE)." }
Write-Output 'Installed Orvane for Claude Code. Start a new Claude Code session and check /mcp.'
