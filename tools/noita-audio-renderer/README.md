# Noita FMOD event renderer

This local-only tool renders an authored Noita FMOD event through the FMOD
2.01.05 runtime installed with Noita, then converts the result to a web-ready
MP3 or PCM WAV. It does not copy or deploy the FMOD engine or source banks.

Requirements:

- A Steam installation of Noita
- Visual Studio Build Tools with the x86 C++ workload
- `ffmpeg` available on `PATH`

Render the Game Over event without its authored leading silence:

```powershell
.\tools\noita-audio-renderer\render.ps1 `
  -Event 'event:/event_cues/game_over/create' `
  -Bank 'event_cues.bank' `
  -ReferencedBank 'player.bank' `
  -Seconds 7 `
  -TrimLeadingSilence `
  -Output '.\public\audio\noita-game-over.mp3'
```

Render an event from the main music bank:

```powershell
.\tools\noita-audio-renderer\render.ps1 `
  -Event 'event:/music/ancient_tracks/00' `
  -Bank 'music.bank' `
  -Seconds 101 `
  -Output '.\artifacts\ancient-tracks-00.mp3'
```

The script finds Noita across configured Steam libraries. Use `-NoitaDir` or
`-AudioDir` to override discovery. Add every extra bank referenced by an event
with `-ReferencedBank`.
