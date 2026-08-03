[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Event,

    [Parameter(Mandatory = $true)]
    [string]$Bank,

    [string[]]$ReferencedBank = @(),

    [Parameter(Mandatory = $true)]
    [string]$Output,

    [ValidateRange(0.1, 3600)]
    [double]$Seconds = 15,

    [switch]$TrimLeadingSilence,

    [string]$NoitaDir,

    [string]$AudioDir
)

$ErrorActionPreference = 'Stop'

function Find-NoitaDirectory {
    $steamRoots = @()
    foreach ($key in @(
        'HKCU:\Software\Valve\Steam',
        'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam',
        'HKLM:\SOFTWARE\Valve\Steam'
    )) {
        if (-not (Test-Path -LiteralPath $key)) { continue }
        $properties = Get-ItemProperty -LiteralPath $key
        if ($properties.SteamPath) { $steamRoots += $properties.SteamPath }
        if ($properties.InstallPath) { $steamRoots += $properties.InstallPath }
    }

    $libraries = @($steamRoots)
    foreach ($steamRoot in ($steamRoots | Select-Object -Unique)) {
        $libraryFile = Join-Path $steamRoot 'steamapps\libraryfolders.vdf'
        if (-not (Test-Path -LiteralPath $libraryFile)) { continue }
        foreach ($line in Get-Content -LiteralPath $libraryFile) {
            if ($line -match '"path"\s+"([^"]+)"') {
                $libraries += $Matches[1].Replace('\\', '\')
            }
        }
    }

    foreach ($library in ($libraries | Select-Object -Unique)) {
        $candidate = Join-Path $library 'steamapps\common\Noita'
        if (Test-Path -LiteralPath (Join-Path $candidate 'noita.exe')) { return $candidate }
    }
    throw 'Noita was not found in the configured Steam libraries. Pass -NoitaDir explicitly.'
}

function Resolve-BankPath([string]$Name) {
    $candidate = if ([IO.Path]::IsPathRooted($Name)) { $Name } else { Join-Path $AudioDir $Name }
    $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction Stop
    return $resolved.Path
}

if (-not $NoitaDir) { $NoitaDir = Find-NoitaDirectory }
$NoitaDir = (Resolve-Path -LiteralPath $NoitaDir).Path
if (-not $AudioDir) { $AudioDir = Join-Path $NoitaDir 'data\audio\Desktop' }
$AudioDir = (Resolve-Path -LiteralPath $AudioDir).Path

foreach ($dll in @('fmod.dll', 'fmodstudio.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $NoitaDir $dll))) {
        throw "$dll was not found in $NoitaDir."
    }
}

$ffmpeg = Get-Command ffmpeg -ErrorAction Stop
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw 'Visual Studio Build Tools with the x86 C++ compiler are required.'
}
$visualStudio = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio Build Tools with the x86 C++ compiler are required.' }
$vcvars = Join-Path $visualStudio 'VC\Auxiliary\Build\vcvars32.bat'

$buildDir = Join-Path $PSScriptRoot '.build'
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
$source = Join-Path $PSScriptRoot 'render_noita_event.c'
$renderer = Join-Path $buildDir 'render_noita_event.exe'
$object = Join-Path $buildDir 'render_noita_event.obj'
if (-not (Test-Path -LiteralPath $renderer) -or (Get-Item $source).LastWriteTimeUtc -gt (Get-Item $renderer).LastWriteTimeUtc) {
    $compile = "call `"$vcvars`" >nul && cl /nologo /O2 `"$source`" /Fo:`"$object`" /Fe:`"$renderer`""
    cmd /d /s /c $compile
    if ($LASTEXITCODE -ne 0) { throw "The local FMOD renderer failed to compile (exit $LASTEXITCODE)." }
}

$outputPath = [IO.Path]::GetFullPath($Output)
$outputDirectory = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$temporaryWav = Join-Path $buildDir "render-$PID.wav"
$banks = @(
    Resolve-BankPath 'Master Bank.bank'
    Resolve-BankPath 'Master Bank.strings.bank'
    Resolve-BankPath $Bank
)
$banks += $ReferencedBank | ForEach-Object { Resolve-BankPath $_ }
$banks = $banks | Select-Object -Unique

try {
    & $renderer $NoitaDir $Event $temporaryWav ([string]$Seconds) @banks
    if ($LASTEXITCODE -ne 0) { throw "FMOD event rendering failed (exit $LASTEXITCODE)." }

    $extension = [IO.Path]::GetExtension($outputPath).ToLowerInvariant()
    $filter = if ($TrimLeadingSilence) {
        'silenceremove=start_periods=1:start_duration=0.02:start_threshold=-55dB,afade=t=in:st=0:d=0.015'
    } else { $null }
    $arguments = @('-y', '-hide_banner', '-loglevel', 'error', '-i', $temporaryWav)
    if ($filter) { $arguments += @('-af', $filter) }
    $arguments += @('-t', ([string]$Seconds))
    if ($extension -eq '.mp3') {
        $arguments += @('-c:a', 'libmp3lame', '-b:a', '160k')
    } elseif ($extension -eq '.wav') {
        $arguments += @('-c:a', 'pcm_s16le')
    } else {
        throw 'Output must end in .mp3 or .wav.'
    }
    $arguments += $outputPath
    & $ffmpeg.Source @arguments
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg conversion failed (exit $LASTEXITCODE)." }
} finally {
    if (Test-Path -LiteralPath $temporaryWav) { Remove-Item -LiteralPath $temporaryWav -Force }
}

Get-Item -LiteralPath $outputPath | Select-Object FullName, Length, LastWriteTime
