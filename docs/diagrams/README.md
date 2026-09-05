# README handoff diagram POC

This POC belongs to `danny0926/entente`. It replaces the README Mermaid block
with a recording of the real Archify viewer, using the same seven nodes and
eight relationships. The original `allenchenhan99/entente` README is unchanged.

- `handoff.architecture.json`: authored source for Archify 2.16.
- `../../presentation/public/diagrams/handoff.html`: validated standalone viewer.
- `../assets/handoff.svg`: Archify's canonical static SVG export.
- `../assets/handoff.gif`: 17-second, 10 fps recording of native selection
  highlights. An overview begins and ends the loop. Camera position stays fixed.

The animation illustrates the documented protocol; it is not a recorded agent
mission or a measured performance result. A declared check's evidentiary strength
still depends on how that check was produced.

## Rebuild

Install the [Archify skill](https://github.com/tt-a1i/archify). From the repository
root, set `ARCHIFY_DIR` to its skill directory, then run:

```bash
node "$ARCHIFY_DIR/bin/archify.mjs" validate architecture \
  docs/diagrams/handoff.architecture.json --quality showcase --json
node "$ARCHIFY_DIR/bin/archify.mjs" deliver architecture \
  docs/diagrams/handoff.architecture.json \
  presentation/public/diagrams/handoff.html --quality showcase --json
```

The source passes all 9 showcase checks with zero composition errors/warnings.
The viewer was checked at 1440x900, 1600x1000, 1920x1080 and 2048x1320, with
light/dark visual review at the smallest and largest sizes.

For the README animation, capture native `Archify.focus.setMany` selections from
the five authored `meta.views`, three seconds each, with one-second overviews at
the beginning and end. Use `mode: 'selection'`, `hideChip: true`, and
`updateUrl: false`; this preserves Archify's native highlights without enabling
its optional moving chapter camera. Record the entire diagram SVG at 10 fps,
then convert the PNG frames using FFmpeg palette generation and palette use.
Do not draw a second graph or patch the delivered viewer to simulate Archify.

Keep capture frames, browser profiles, and raw diagnostics outside tracked source.
