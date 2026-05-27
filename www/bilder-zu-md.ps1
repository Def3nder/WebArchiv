param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$DirectoryPath
)

if (-not (Test-Path -LiteralPath $DirectoryPath -PathType Container)) {
    Write-Error "Das angegebene Verzeichnis existiert nicht: $DirectoryPath"
    exit 1
}

$images = Get-ChildItem -LiteralPath $DirectoryPath -Recurse -File |
    Where-Object { $_.Extension -match '^\.(png|jpg|jpeg)$' }

foreach ($image in $images) {
    $mdPath = Join-Path -Path $image.DirectoryName -ChildPath ($image.BaseName + ".md")

    if (-not (Test-Path -LiteralPath $mdPath)) {
        New-Item -ItemType File -Path $mdPath | Out-Null
        Write-Host "Erstellt: $mdPath"
    }
    else {
        Write-Host "Existiert bereits: $mdPath"
    }
}
