# Voice clips for fighter `kim`

Drop WAV files here named `<mood>-<level>.wav`: moods `angry`, `happy`, `hurt`, `insult`,
`celebrate`; levels `1` (mild) to `5` (all out), e.g. `hurt-3.wav`. Then run
`pwsh scripts/pofighter/voices.ps1` to list them in `../manifest.json`. Any clip not here plays
a procedural stand-in (`wwwroot/js/pofighter/voice.js`).
