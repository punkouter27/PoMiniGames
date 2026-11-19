# Prepares PoFighter's voice clips and rewrites wwwroot/audio/pofighter/manifest.json, so voice.js
# plays a recording for every <fighter>/<mood>-<level>.wav that exists and a procedural sound for
# the rest. Run after adding or removing clips.
#
# Processing (needs ffmpeg on PATH; skipped with a warning when it is missing, or with -NoProcess):
#   - trims silence off both ends (below -45 dB), so a line starts on the frame it is triggered;
#   - normalises loudness to -16 LUFS (true peak -1.5 dB), so no clip jumps out of the mix;
#   - writes mono 16-bit at 24 kHz, about a quarter of a stereo 44.1 kHz recording.
# The untouched original is kept in scripts/pofighter/voices-raw/<fighter>/ the first time a clip is
# processed; a clip with an original there counts as done. -Force reprocesses every clip from its
# original (after changing the settings below, say).
param([switch]$NoProcess, [switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '../../src/PoMiniGames.Client/wwwroot/audio/pofighter'
$rawRoot = Join-Path $PSScriptRoot 'voices-raw'
$moods = 'angry', 'happy', 'hurt', 'insult', 'celebrate'
$filter = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,' +
    'areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,' +
    'loudnorm=I=-16:TP=-1.5:LRA=11'

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $NoProcess -and -not $ffmpeg) { Write-Warning 'ffmpeg not found: clips are listed as they are, unprocessed.' }
$process = -not $NoProcess -and $ffmpeg

$manifest = [ordered]@{}
$done = 0
foreach ($dir in Get-ChildItem $root -Directory | Sort-Object Name) {
    $clips = Get-ChildItem $dir.FullName -Filter *.wav | ForEach-Object { $_.BaseName } |
        Where-Object { $_ -match "^($($moods -join '|'))-[1-5]$" } | Sort-Object
    $bad = Get-ChildItem $dir.FullName -Filter *.wav | Where-Object { $_.BaseName -notin $clips }
    foreach ($b in $bad) { Write-Warning "Ignored $($dir.Name)/$($b.Name): name it <mood>-<1..5>.wav" }
    if ($process) {
        $rawDir = Join-Path $rawRoot $dir.Name
        foreach ($clip in $clips) {
            $wav = Join-Path $dir.FullName "$clip.wav"
            $raw = Join-Path $rawDir "$clip.wav"
            if ((Test-Path $raw) -and -not $Force) { continue }
            if (-not (Test-Path $raw)) {
                New-Item -ItemType Directory -Force $rawDir | Out-Null
                Copy-Item $wav $raw
            }
            $tmp = "$wav.tmp.wav"
            & $ffmpeg.Source -hide_banner -loglevel error -y -i $raw -af $filter -ac 1 -ar 24000 -c:a pcm_s16le $tmp
            if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -ErrorAction SilentlyContinue; throw "ffmpeg failed on $($dir.Name)/$clip.wav" }
            Move-Item -Force $tmp $wav
            $done++
        }
    }
    if ($clips) { $manifest[$dir.Name] = @($clips) }
}
$json = if ($manifest.Count) { $manifest | ConvertTo-Json -Depth 3 } else { '{}' }
Set-Content -Path (Join-Path $root 'manifest.json') -Value $json -Encoding utf8NoBOM
$count = ($manifest.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
Write-Host "manifest.json: $([int]$count) clip(s) across $($manifest.Count) fighter(s); $done processed"
