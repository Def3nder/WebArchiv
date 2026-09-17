#requires -Version 5.1
<#
.SYNOPSIS
Prueft Qwen und startet WebArchiv lokal mit temporaeren Provider-Umgebungsvariablen.
.EXAMPLE
.\Start-WebArchivQwen.ps1 -BaseUrl 'http://192.168.1.65:8765'
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://192.168.1.65:8765',
    [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$server = Join-Path $project 'server.js'
$config = Get-Content -LiteralPath (Join-Path $project 'tts/config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.tts.provider -ne 'qwen') { throw 'tts/config.json muss tts.provider = qwen enthalten.' }
if ($config.qwen.base_url_environment_variable -ne 'QWEN_TTS_BASE_URL' -or
    $config.qwen.token_environment_variable -ne 'QWEN_TTS_TOKEN') {
    throw 'Die konfigurierten Qwen-Umgebungsvariablen entsprechen nicht diesem Startscript.'
}
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw 'server.js fehlt im Projektverzeichnis.' }
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$token = Read-Host 'Qwen-Token (wie auf dem Qwen-Server)' -AsSecureString
$pointer = [IntPtr]::Zero
$previousUrl = $env:QWEN_TTS_BASE_URL
$previousToken = $env:QWEN_TTS_TOKEN
$locationChanged = $false
try {
    & (Join-Path $PSScriptRoot 'Test-QwenServer.ps1') -BaseUrl $BaseUrl -Token $token | Out-Host
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
    $env:QWEN_TTS_BASE_URL = $BaseUrl.TrimEnd('/')
    $env:QWEN_TTS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
    Push-Location -LiteralPath $project
    $locationChanged = $true
    Write-Host 'Starte WebArchiv im Vordergrund. Beenden mit Strg+C.'
    Write-Host 'Danach im Browser als Admin: kurzer Artikel ohne MP3 > Aktionen > Audio erzeugen.'
    & $node $server
    if ($LASTEXITCODE -ne 0) { throw "WebArchiv wurde mit Exit-Code $LASTEXITCODE beendet." }
} finally {
    if ($locationChanged) { Pop-Location }
    $env:QWEN_TTS_BASE_URL = $previousUrl
    $env:QWEN_TTS_TOKEN = $previousToken
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $token.Dispose()
}
