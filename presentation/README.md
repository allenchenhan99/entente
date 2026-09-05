# Entente hackathon presentation

The only presentation entry is `index.html`: the seven-slide, 120-second pitch
by Atrophied Intelligence. The old React presentation and entry were removed.
Public URL: https://allenchenhan99.github.io/entente/

## Build

```bash
cd presentation
npm run build
```

Requires Node 22; no dependency installation. The build validates the seven
slides, inline JavaScript syntax and image references, clears only the generated
`presentation/dist` directory, and copies the current HTML and public assets.
GitHub Pages uploads that directory. The standalone Archify handoff diagram
remains available at `diagrams/handoff.html` for existing README links.

## Present

Arrows navigate; N toggles notes; F enters fullscreen. The playback button starts
or resumes the 120-second presentation. Diagrams animate automatically.
Slide 4 shows the team's real Demo screenshot. Video is linked, not embedded.

To preview the built project URL locally, place `dist` beneath an HTTP server's
`entente/` path, matching the deployed image paths.
