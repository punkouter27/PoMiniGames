# Voice clips for PoBrawl's fighters

`voices.json` lists every fighter (`trump`, `biden`, … `hoover`, `bob`; the ids in
`PoBrawlRoster` / `js/pobrawl/fighters.js`) × 5 emotions × 5 levels with its WAV path, an
`exists` flag and the fighter's procedural voice profile (`voice`: pitch, formant scale, breath,
rasp, vibrato, tempo, timbre; tune those by hand).

To record a line, drop `<id>/<emotion>-<level>.wav` here (emotions `angry`, `happy`, `hurt`,
`insult`, `celebrate`; levels `1` mild to `5` all out, e.g. `nixon/hurt-3.wav`) and run
`pwsh scripts/pofighter/voices.ps1 -Game pobrawl`: it processes the clip and marks it `exists`.
Every cell without a clip plays the advanced procedural imitation in that fighter's voice
(`wwwroot/js/platform/emotionVoice.js`, driven from `wwwroot/js/pobrawl/fighterVoice.js`).
