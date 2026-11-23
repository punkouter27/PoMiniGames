# Voice clips for fighter `p1`

Drop WAV files here named `<mood>-<level>.wav`: moods `angry`, `happy`, `hurt`, `insult`,
`celebrate`; levels `1` (mild) to `5` (all out), e.g. `hurt-3.wav`. Then run
`pwsh scripts/pofighter/voices.ps1` to mark them `exists` in `../voices.json`, which lists every
fighter's 25 cells and its voice profile. Any cell without a clip plays the advanced procedural
imitation in that fighter's voice (`wwwroot/js/platform/emotionVoice.js`).
