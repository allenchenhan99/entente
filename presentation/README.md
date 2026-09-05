# Entente hackathon presentation

Six slides, approximately five minutes including one demo video of up to two minutes.
Public address: **https://allenchenhan99.github.io/entente/**.

## Run locally

Use Node.js 22.13 or later:

```bash
cd presentation
npm ci
npm run dev
```

Open the printed local URL with `/entente/` appended. `npm run build` checks TypeScript
and creates a static `dist/`; `npm start` previews the production build.

## Present

- Arrow keys, Page Up/Down, Space, or the footer move between slides.
- The first three diagrams **start automatically on entry**. Their 14-, 14-, and
  20-second timelines highlight the current node and moving data path, then stop
  on a complete overview. Pause and replay are optional.
- A hidden tab pauses its timeline. Reduced-motion preference shows the meaningful
  final overview immediately.
- Slide 4 contains the only video slot. It stays empty until the team supplies its demo.
- Slide 5 distinguishes recorded verification/repair evidence from the proposed
  versioned context checkpoint and delivery Passport.

## Add the demo

1. Save the final video (at most 120 seconds) as `public/demo.mp4`.
2. Set `DEMO_VIDEO_SRC` in `lib/report-config.ts` to `"./demo.mp4"`.
3. Run `npm run build`, then commit the video and configuration to `main`.

Use an externally hosted video URL in the same configuration if the file exceeds
GitHub's normal file-size limit. Video playback retains native browser controls.

## Publish on GitHub Pages

The original `allenchenhan99/entente` repository owns the site. A repository owner
first selects **Settings → Pages → Build and deployment → Source → GitHub Actions**.
Then `.github/workflows/pages.yml` builds and publishes changes under `presentation/`
automatically. The workflow also supports **Run workflow** for a manual redeploy.
The base path is `/entente/`; there is no server, ChatGPT hosting configuration,
API key, or external font request.

## Design and sources

The first three slides follow one requirement: “加入登入，不增加付費服務”. The
outermost scope is the team's proposed **Provenance Engineering** positioning;
the smaller layers accumulate rather than replace one another. The rejected
approaches are issue-derived design tradeoffs, not measured experiments.

The redesign was discussed with Claude Code (Opus, high effort). We adopted a
shared example across slides, finite autoplay with a persistent final state,
static rejected-approach annotations, and visible implementation/proposal boundaries.
The 26-second delivery draft was shortened to 20 seconds to leave speaking time.

The slide diagrams use React/SVG with Archify-inspired trace motion.
`public/diagrams/delivery.html` is a separately generated
[Archify](https://github.com/tt-a1i/archify) diagram, with its validated JSON source
beside it. Its optional viewer controls use English fallback labels; authored
diagram content is Traditional Chinese. The supplied Entente logo is unchanged.

Evidence links are embedded in slides 2 and 5. The `fixtures/events-live-7.jsonl`
link is pinned to the recorded source commit so later fixture edits do not silently
change the cited sequence.
