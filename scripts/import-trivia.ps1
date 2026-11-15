#Requires -Version 7
<#
.SYNOPSIS
    Tops up the PoFunQuiz question bank from Open Trivia DB (https://opentdb.com, CC BY-SA 4.0).

.DESCRIPTION
    Run by hand, at authoring time. The app itself never calls a trivia service: it reads
    src/PoMiniGames.Api/Features/PoFunQuiz/Data/questions.json and nothing else.

    For each Open Trivia DB category in -Map, this fetches every multiple-choice question,
    applies the same identity and quality rules as QuizQuality.cs (so nothing lands in the
    file that the app would drop at load), skips anything already in the bank, and appends
    the rest in the bank's one-object-per-line format.

    Open Trivia DB allows one request per IP every five seconds; the script waits six.

.PARAMETER Map
    Open Trivia DB category id -> bank category. The default feeds the bank's thin
    categories: Technology (Computers, Gadgets), General and Sports.

.PARAMETER WhatIf
    Fetch and report, but do not write the file.

.EXAMPLE
    pwsh scripts/import-trivia.ps1
    pwsh scripts/import-trivia.ps1 -Map @{ 27 = 'Science' } -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [hashtable] $Map = @{ 18 = 'Technology'; 30 = 'Technology'; 9 = 'General'; 21 = 'Sports' },
    [string] $BankPath = (Join-Path $PSScriptRoot '..' 'src' 'PoMiniGames.Api' 'Features' 'PoFunQuiz' 'Data' 'questions.json'),
    [int] $DelaySeconds = 6
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$validCategories = 'General', 'Science', 'History', 'Geography', 'Sports', 'Entertainment', 'Technology', 'ArtCulture'
foreach ($target in $Map.Values) {
    if ($target -notin $validCategories) { throw "Unknown bank category '$target'. Use one of: $($validCategories -join ', ')." }
}

# ── QuizQuality.cs, restated ──────────────────────────────────────────────────
# Keep these two functions in step with QuizQuality.Normalize / QuizQuality.Reject. The unit
# tier loads the file through the real ones, so a drift shows up there as a failing test.
$articles = [System.Collections.Generic.HashSet[string]]::new([string[]]@('a', 'an', 'the'))

function Get-Normalized([string] $text) {
    if ([string]::IsNullOrWhiteSpace($text)) { return '' }
    $sb = [System.Text.StringBuilder]::new($text.Length)
    foreach ($ch in $text.Normalize([System.Text.NormalizationForm]::FormD).ToCharArray()) {
        if ([System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch) -eq [System.Globalization.UnicodeCategory]::NonSpacingMark) { continue }
        [void] $sb.Append($(if ([char]::IsLetterOrDigit($ch)) { [char]::ToLowerInvariant($ch) } else { ' ' }))
    }
    $words = $sb.ToString().Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries) | Where-Object { -not $articles.Contains($_) }
    return ($words -join ' ')
}

function Get-RejectReason([string] $text, [string[]] $options) {
    # $options[0] is the correct answer, as in the bank file.
    if ([string]::IsNullOrWhiteSpace($text)) { return 'empty question' }
    if ($options.Count -ne 4) { return 'needs exactly four options' }
    $normalized = @($options | ForEach-Object { Get-Normalized $_ })
    if ($normalized | Where-Object { $_.Length -eq 0 }) { return 'blank option' }
    if (@($normalized | Select-Object -Unique).Count -ne 4) { return 'options are not distinct' }
    $answer = $normalized[0]
    if ($answer.Length -ge 3 -and " $(Get-Normalized $text) ".Contains(" $answer ", [System.StringComparison]::Ordinal)) {
        return 'answer appears in the question'
    }
    $correctLength = $options[0].Trim().Length
    $othersAverage = ($options[1..3] | ForEach-Object { $_.Trim().Length } | Measure-Object -Average).Average
    if ($correctLength -gt 2.5 * [Math]::Max(1.0, $othersAverage)) { return 'correct option is much longer than the others' }
    return $null
}

function ConvertFrom-B64([string] $value) {
    [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($value)).Trim()
}

# ── The bank as it stands ─────────────────────────────────────────────────────
$BankPath = (Resolve-Path $BankPath).Path
$bankText = [System.IO.File]::ReadAllText($BankPath)
$seen = [System.Collections.Generic.HashSet[string]]::new()
foreach ($item in ($bankText | ConvertFrom-Json)) { [void] $seen.Add((Get-Normalized $item.q)) }
Write-Host "Bank: $($seen.Count) distinct questions in $BankPath"

# ── Fetch ─────────────────────────────────────────────────────────────────────
# A session token makes the API hand out each question once, so paging until it has nothing
# left to give, even one at a time, walks the whole category.
$headers = @{ 'User-Agent' = 'trivia-bank-import' }
$token = (Invoke-RestMethod 'https://opentdb.com/api_token.php?command=request' -Headers $headers).token
$difficulty = @{ easy = 'Easy'; medium = 'Medium'; hard = 'Hard' }
$added = [System.Collections.Generic.List[object]]::new()
$stats = [ordered]@{}

foreach ($id in ($Map.Keys | Sort-Object)) {
    $target = $Map[$id]
    $fetched = 0; $dupes = 0; $rejected = 0; $kept = 0
    $amount = 50
    while ($amount -ge 1) {
        Start-Sleep -Seconds $DelaySeconds
        $url = "https://opentdb.com/api.php?amount=$amount&category=$id&type=multiple&encode=base64&token=$token"
        try { $response = Invoke-RestMethod $url -Headers $headers }
        catch {
            # 429: one more wait covers it. Anything else is a real failure.
            if ($_.Exception.Response.StatusCode.value__ -ne 429) { throw }
            Start-Sleep -Seconds ($DelaySeconds * 2)
            continue
        }
        # 1 = the category has fewer than $amount; 4 = the token has fewer than $amount left to
        # give. Either way a smaller page may still succeed, so halve down to 1 before stopping:
        # treating 4 as "done" drops each category's last partial page.
        if ($response.response_code -in 1, 4) {
            $amount = [Math]::Floor($amount / 2)
            continue
        }
        if ($response.response_code -ne 0) { throw "Open Trivia DB returned code $($response.response_code) for category $id." }

        foreach ($r in $response.results) {
            $fetched++
            $q = ConvertFrom-B64 $r.question
            $a = ConvertFrom-B64 $r.correct_answer
            $w = @($r.incorrect_answers | ForEach-Object { ConvertFrom-B64 $_ })
            $key = Get-Normalized $q
            if ($seen.Contains($key)) { $dupes++; continue }
            if (Get-RejectReason $q (@($a) + $w)) { $rejected++; continue }
            [void] $seen.Add($key)
            $kept++
            $added.Add([ordered]@{ c = $target; d = $difficulty[(ConvertFrom-B64 $r.difficulty)]; q = $q; a = $a; w = $w })
        }
    }
    $stats["$id -> $target"] = "fetched $fetched, new $kept, already in bank $dupes, failed quality $rejected"
}

$stats.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-20} {1}" -f $_.Key, $_.Value) }
Write-Host "New questions: $($added.Count)"
if ($added.Count -eq 0) { return }

# ── Append, in the bank's own layout (two-space indent, one object per line, LF) ──
$lines = $added | ForEach-Object { '  ' + ($_ | ConvertTo-Json -Compress -Depth 4) }
$close = $bankText.LastIndexOf(']')
$body = $bankText.Substring(0, $close).TrimEnd()
$updated = $body + ",`n" + ($lines -join ",`n") + "`n]`n"

if ($PSCmdlet.ShouldProcess($BankPath, "Append $($added.Count) questions")) {
    [System.IO.File]::WriteAllText($BankPath, $updated, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Wrote $BankPath"
}
