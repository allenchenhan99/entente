# Entente hackathon presentation

Seven slides, 120 seconds. Team: **Atrophied Intelligence**.
Published at https://allenchenhan99.github.io/entente/.

The current entry is `index.html`, adopted from the approved pitch v2. It contains
layouts, diagram animations, navigation and speaker notes. Images live in
`public/`. The existing Archify viewer at `public/diagrams/handoff.html` remains
available to the presentation and repository README.

## Run and build

Use Node.js 22.13 or later:

```bash
cd presentation
npm ci
npm run dev
```

Open the printed URL with `/entente/` appended. `npm run build` checks TypeScript
and builds `dist/`; `npm start` previews the production build. The previous React
presentation source remains but is not imported by this entry.

## Present

- Slide durations: 5 / 20 / 30 / 20 / 25 / 10 / 10 seconds.
- Arrows navigate; N toggles speaker notes; F enters fullscreen.
- The playback button starts/resumes timed navigation. Diagrams animate automatically.
- Slide 3 displays the Contract beside the session tree and context packet.
- Slide 4 uses the unchanged team terminal screenshot with automatic annotations.
- The Demo links to the team's Drive folder; no video is downloaded or embedded.
- Provenance Engineering is introduced on the final slide.

## Publish

The existing Pages workflow builds and deploys presentation changes on `main`.
Asset paths use the `/entente/` base. Keep the standalone handoff diagram path
stable because the repository README links to it.
