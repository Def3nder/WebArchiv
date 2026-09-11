<#
.SYNOPSIS
    Kodiert alle MP3-Dateien eines Verzeichnisbaums mit FFmpeg neu (konstante Bitrate)
    und legt sie in einem gespiegelten Verzeichnisbaum ab.

.DESCRIPTION
    Durchsucht das Quellverzeichnis rekursiv nach *.mp3, kodiert jede Datei mit
    libmp3lame in konstanter Bitrate (CBR) neu und speichert sie unter gleichem Namen
    und gleichem relativen Pfad im Zielverzeichnis. ID3-Tags und eingebettete Cover
    werden übernommen. Die Quelldateien bleiben unverändert.

.PARAMETER Source
    Quellverzeichnis, z. B. "audio".

.PARAMETER Destination
    Zielverzeichnis. Standard: Quellverzeichnis mit Suffix "-neu", z. B. "audio-neu".

.PARAMETER Bitrate
    Zielbitrate. Standard: 64k.

.PARAMETER Mono
    Ausgabe auf Mono heruntermischen (sinnvoll bei reiner Sprache).

.PARAMETER Overwrite
    Vorhandene Zieldateien überschreiben. Ohne diesen Schalter werden sie übersprungen,
    sodass ein abgebrochener Lauf einfach fortgesetzt werden kann.

.PARAMETER CopyOtherFiles
    Nicht-MP3-Dateien (z. B. cover.jpg, .txt) unverändert mitkopieren.

.PARAMETER FfmpegPath
    Pfad zu ffmpeg.exe, falls ffmpeg nicht im PATH liegt.

.EXAMPLE
    .\Convert-Mp3Tree.ps1 -Source .\audio

.EXAMPLE
    .\Convert-Mp3Tree.ps1 -Source D:\audio -Destination E:\audio-neu -Overwrite -CopyOtherFiles
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Source,

    [Parameter(Position = 1)]
    [string]$Destination,

    [string]$Bitrate = '64k',

    [switch]$Mono,

    [switch]$Overwrite,

    [switch]$CopyOtherFiles,

    [string]$FfmpegPath = 'ffmpeg'
)

# --- Vorprüfungen ---------------------------------------------------------------

$ffmpeg = Get-Command -Name $FfmpegPath -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $ffmpeg) {
    Write-Error "FFmpeg wurde nicht gefunden ('$FfmpegPath'). Bitte in den PATH aufnehmen oder -FfmpegPath angeben."
    exit 1
}

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    Write-Error "Quellverzeichnis nicht gefunden: $Source"
    exit 1
}
$srcRoot = (Resolve-Path -LiteralPath $Source).ProviderPath.TrimEnd('\', '/')

if ([string]::IsNullOrWhiteSpace($Destination)) {
    $Destination = "$srcRoot-neu"
}
$dstRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination).TrimEnd('\', '/')

# Das Ziel darf nicht im Quellbaum liegen, sonst würden neue Dateien erneut erfasst.
$srcPrefix = $srcRoot + [IO.Path]::DirectorySeparatorChar
if ($dstRoot -eq $srcRoot -or $dstRoot.StartsWith($srcPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Error "Das Zielverzeichnis darf nicht mit dem Quellverzeichnis identisch sein oder darin liegen."
    exit 1
}

function Get-RelativePath([string]$FullPath) {
    return $FullPath.Substring($srcRoot.Length).TrimStart('\', '/')
}

Write-Host "Quelle:  $srcRoot"
Write-Host "Ziel:    $dstRoot"
Write-Host "Bitrate: $Bitrate CBR$(if ($Mono) { ', Mono' })"
Write-Host ""

# --- Verzeichnisstruktur spiegeln (auch leere Ordner) ------------------------------

[void][IO.Directory]::CreateDirectory($dstRoot)
Get-ChildItem -LiteralPath $srcRoot -Recurse -Directory | ForEach-Object {
    [void][IO.Directory]::CreateDirectory([IO.Path]::Combine($dstRoot, (Get-RelativePath $_.FullName)))
}

# --- MP3-Dateien neu kodieren ---------------------------------------------------

# Filter '*.mp3' würde unter Windows auch z. B. '.mp3x' treffen, daher zusätzlich exakt prüfen.
$files = @(Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Filter '*.mp3' |
    Where-Object { $_.Extension -eq '.mp3' })

$total   = $files.Count
$ok      = 0
$skipped = 0
$failed  = New-Object System.Collections.Generic.List[string]
$i       = 0

foreach ($file in $files) {
    $i++
    $rel     = Get-RelativePath $file.FullName
    $outFile = [IO.Path]::Combine($dstRoot, $rel)
    $tmpFile = "$outFile.part"

    Write-Progress -Activity "MP3 neu kodieren ($Bitrate CBR)" `
                   -Status "$i / $total : $rel" `
                   -PercentComplete ([int](100 * $i / $total))

    if ((Test-Path -LiteralPath $outFile) -and -not $Overwrite) {
        $skipped++
        continue
    }

    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outFile))

    $ffArgs = @(
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-i', $file.FullName,
        '-map', '0:a:0',            # erste Audiospur
        '-map', '0:v?',             # eingebettetes Cover, falls vorhanden
        '-c:a', 'libmp3lame',
        '-b:a', $Bitrate            # -b:a ohne '-abr 1' = konstante Bitrate
    )
    if ($Mono) { $ffArgs += @('-ac', '1') }
    $ffArgs += @(
        '-c:v', 'copy',
        '-map_metadata', '0',       # ID3-Tags übernehmen
        '-id3v2_version', '3',
        '-f', 'mp3',
        $tmpFile                    # erst in .part schreiben, bei Erfolg umbenennen
    )

    $log = & $ffmpeg.Path @ffArgs 2>&1 | Out-String

    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $tmpFile)) {
        if (Test-Path -LiteralPath $outFile) { Remove-Item -LiteralPath $outFile -Force }
        [IO.File]::Move($tmpFile, $outFile)
        $ok++
    }
    else {
        if (Test-Path -LiteralPath $tmpFile) { Remove-Item -LiteralPath $tmpFile -Force }
        $failed.Add($rel)
        Write-Warning "Fehler bei '$rel':`n$log"
    }
}

Write-Progress -Activity "MP3 neu kodieren" -Completed

# --- Optional: übrige Dateien mitkopieren ----------------------------------------

$copied = 0
if ($CopyOtherFiles) {
    Get-ChildItem -LiteralPath $srcRoot -Recurse -File |
        Where-Object { $_.Extension -ne '.mp3' } |
        ForEach-Object {
            $target = [IO.Path]::Combine($dstRoot, (Get-RelativePath $_.FullName))
            if ($Overwrite -or -not (Test-Path -LiteralPath $target)) {
                [IO.File]::Copy($_.FullName, $target, $true)
                $copied++
            }
        }
}

# --- Zusammenfassung ---------------------------------------------------------------

Write-Host "Fertig. $total MP3-Dateien gefunden."
Write-Host "  Neu kodiert:     $ok"
Write-Host "  Übersprungen:    $skipped (existierten bereits; -Overwrite zum Überschreiben)"
if ($CopyOtherFiles) {
    Write-Host "  Andere kopiert:  $copied"
}
Write-Host "  Fehlgeschlagen:  $($failed.Count)"
foreach ($f in $failed) { Write-Host "    $f" }

exit ([int]($failed.Count -gt 0))
