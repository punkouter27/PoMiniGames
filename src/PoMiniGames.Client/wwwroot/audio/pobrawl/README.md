# Voice clips for PoBrawl's fighters

One folder per fighter id (`trump`, `biden`, … `hoover`, `bob`; the ids in
`PoBrawlRoster` / `js/pobrawl/fighters.js`), each holding WAV files named `<emotion>-<level>.wav`:
emotions `angry`, `happy`, `hurt`, `insult`, `celebrate`; levels `1` (mild) to `5` (all out),
e.g. `nixon/hurt-3.wav`. Then run `pwsh scripts/pofighter/voices.ps1 -Game pobrawl` to list them
in `manifest.json`. Any clip not listed plays a stand-in (`wwwroot/js/pobrawl/fighterVoice.js`):
`hurt` the existing pain grunt, `angry` the effort "hup", the rest the shared procedural voice
(`wwwroot/js/platform/emotionVoice.js`).
