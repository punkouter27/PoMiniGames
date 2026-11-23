# Prepares a game's voice clips and rewrites wwwroot/audio/<game>/voices.json, the one voice
# manifest per game (schema po-voice-manifest/1): every character × 5 emotions × 5 levels with its
# WAV path and an `exists` flag, plus each character's procedural voice profile (`voice`). The
# shared emotion voice (js/platform/emotionVoice.js) plays a cell's WAV when `exists` is true and
# its advanced procedural imitation otherwise. Run after adding or removing clips. -Game picks the
# game: pofighter (default) or pobrawl.
#
# Characters are the ones already in voices.json (their `voice` profiles are kept as they are)
# plus any new folder under the game's audio folder (added with a default profile: tune it by
# hand). `exists` is only ever written here. Prints "N of M clips recorded" and what is missing.
#
# Processing (needs ffmpeg on PATH; skipped with a warning when it is missing, or with -NoProcess):
#   - trims silence off both ends (below -45 dB), so a line starts on the frame it is triggered;
#   - normalises loudness to -16 LUFS (true peak -1.5 dB), so no clip jumps out of the mix;
#   - writes mono 16-bit at 24 kHz, about a quarter of a stereo 44.1 kHz recording.
# The untouched original is kept in scripts/<game>/voices-raw/<character>/ the first time a clip is
# processed; a clip with an original there counts as done. -Force reprocesses every clip from its
# original (after changing the settings below, say).
param([ValidateSet('pofighter', 'pobrawl')][string]$Game = 'pofighter', [switch]$NoProcess, [switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot "../../src/PoMiniGames.Client/wwwroot/audio/$Game"
$rawRoot = Join-Path $PSScriptRoot "../$Game/voices-raw"
$manifestPath = Join-Path $root 'voices.json'
$moods = 'angry', 'happy', 'hurt', 'insult', 'celebrate'
$levels = 1..5
$defaultVoice = [ordered]@{ pitchHz = 150; formantScale = 1.0; breath = 0.2; rasp = 0.2; vibratoHz = 5.0; vibratoDepth = 0.02; tempo = 1.0; timbre = 'neutral' }
$filter = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,' +
    'areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,' +
    'loudnorm=I=-16:TP=-1.5:LRA=11'

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $NoProcess -and -not $ffmpeg) { Write-Warning 'ffmpeg not found: clips are listed as they are, unprocessed.' }
$process = -not $NoProcess -and $ffmpeg

# The characters and their profiles so far.
$old = if (Test-Path $manifestPath) { Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
$characters = [ordered]@{}
foreach ($c in @($old.characters)) {
    if ($c -and $c.id) { $characters[$c.id.ToLowerInvariant()] = @{ name = $c.name ?? $c.id; voice = $c.voice ?? $defaultVoice } }
}
foreach ($dir in Get-ChildItem $root -Directory | Sort-Object Name) {
    $id = $dir.Name.ToLowerInvariant()
    if (-not $characters.Contains($id)) {
        Write-Warning "New character '$id': added with the default voice profile; tune it in voices.json"
        $characters[$id] = @{ name = $dir.Name; voice = $defaultVoice }
    }
}

$done = 0
$recorded = 0
$missing = [ordered]@{}
$list = foreach ($id in $characters.Keys) {
    $dir = Join-Path $root $id
    if (Test-Path $dir) {
        $bad = Get-ChildItem $dir -Filter *.wav | Where-Object { $_.BaseName -notmatch "^($($moods -join '|'))-[1-5]$" }
        foreach ($b in $bad) { Write-Warning "Ignored $id/$($b.Name): name it <emotion>-<1..5>.wav" }
    }
    $clips = [ordered]@{}
    foreach ($mood in $moods) {
        $clips[$mood] = @(foreach ($level in $levels) {
            $wav = Join-Path $dir "$mood-$level.wav"
            $exists = Test-Path $wav
            if ($exists -and $process) {
                $raw = Join-Path (Join-Path $rawRoot $id) "$mood-$level.wav"
                if ($Force -or -not (Test-Path $raw)) {
                    if (-not (Test-Path $raw)) {
                        New-Item -ItemType Directory -Force (Split-Path $raw) | Out-Null
                        Copy-Item $wav $raw
                    }
                    $tmp = "$wav.tmp.wav"
                    & $ffmpeg.Source -hide_banner -loglevel error -y -i $raw -af $filter -ac 1 -ar 24000 -c:a pcm_s16le $tmp
                    if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -ErrorAction SilentlyContinue; throw "ffmpeg failed on $id/$mood-$level.wav" }
                    Move-Item -Force $tmp $wav
                    $done++
                }
            }
            if ($exists) { $recorded++ } else { $missing[$id] = 1 + ($missing[$id] ?? 0) }
            [ordered]@{ level = $level; file = "$id/$mood-$level.wav"; exists = [bool]$exists }
        })
    }
    [ordered]@{ id = $id; name = $characters[$id].name; voice = $characters[$id].voice; clips = $clips }
}

$doc = [ordered]@{
    schema = 'po-voice-manifest/1'
    game = $Game
    generated = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    root = "src/PoMiniGames.Client/wwwroot/audio/$Game"
    emotions = $moods
    levels = $levels
    fallback = 'procedural'
    characters = @($list)
}
$json = $doc | ConvertTo-Json -Depth 8
# Keep the old timestamp when nothing else changed, so a re-run leaves the file untouched.
if ($old.generated) {
    $stamp = '"generated": "[^"]*"'
    $previous = if ($old.generated -is [datetime]) { $old.generated.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } else { "$($old.generated)" }
    $same = ($json -replace $stamp, '') -eq ((Get-Content $manifestPath -Raw).TrimEnd() -replace $stamp, '')
    if ($same) { $json = $json -replace $stamp, "`"generated`": `"$previous`"" }
}
Set-Content -Path $manifestPath -Value $json -Encoding utf8NoBOM

$total = $characters.Count * $moods.Count * $levels.Count
$gaps = ($missing.Keys | ForEach-Object { "$_ ($($missing[$_]))" }) -join ', '
Write-Host "$Game voices.json: $recorded of $total clips recorded across $($characters.Count) character(s); $done processed"
if ($gaps) { Write-Host "missing (procedural): $gaps" }
