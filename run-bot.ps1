$ErrorActionPreference = "Stop"

$workspace = "C:\Users\USER\Desktop\grabador-pro\mcpserver\whatsapp-web-mcp-server"
$env:WHATSAPP_BOT_CONFIG_FILE = Join-Path $workspace "tmp\bot.config.json"

Set-Location $workspace
node dist/bot.js
