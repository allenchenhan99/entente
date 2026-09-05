# Third-party sources, licenses, and data provenance

Entente's original code is distributed under the [MIT License](LICENSE).
Third-party software, model services, and assets retain their own terms; the
project's MIT license does not replace them. This document covers the Node/Rust
applications, demo, replay data, experiments, and presentation.

## Software dependencies

The inventories include direct, transitive, development, optional, and
platform-specific dependencies recorded by the lockfiles. A recorded dependency
is not necessarily shipped in every build. Local npm workspace links and the
project's own Rust crates are excluded from the third-party inventories.

| Ecosystem | Versioned source and license inventory | Evidence |
| --- | --- | --- |
| npm: root workspace, demo, presentation | [npm-dependencies.json](docs/third-party/npm-dependencies.json) | Each lockfile's package version, declared license, resolved download URL, and integrity digest |
| Rust: terminal host and terminal UI | [cargo-dependencies.json](docs/third-party/cargo-dependencies.json) | Cargo.lock version/source/checksum plus crates.io version metadata; registry checksums must match the lock |

These include Hono, the MCP SDK, Zod, node-pty, xterm, Ink, React, Ratatui,
Crossterm, Tokio, Axum, and the presentation's UI/build dependencies. The exact
license expression for each version is in the inventories; do not assume all
dependencies use MIT. Registry license declarations are provenance evidence,
not a license-compatibility assessment or a substitute for upstream license texts.
Retain applicable upstream LICENSE/NOTICE files when distributing dependencies.

To refresh after a lockfile change, run with Python 3.11+ and network access:

```sh
python docs/third-party/generate-inventory.py
```

The generator only reads lockfiles and public registry metadata and writes the
two documentation inventories. It does not install dependencies or run packages.

## Agent runtimes and model services

Live missions use separately installed runtimes and the operator's configured
model/account. Entente does not bundle model weights or grant access to a hosted
model. Replay does not require a live model. Model names in a recording identify
that recording, not a model entitlement or a fixed default for future runs.

| Component | Source | License or applicable terms |
| --- | --- | --- |
| Claude Code / Claude | [Anthropic Claude Code](https://github.com/anthropics/claude-code) | [Upstream license/terms notice](https://github.com/anthropics/claude-code/blob/main/LICENSE.md); [consumer terms](https://www.anthropic.com/legal/consumer-terms) or [commercial terms](https://www.anthropic.com/legal/commercial-terms), according to the operator's account |
| Codex CLI / OpenAI models | [OpenAI Codex](https://github.com/openai/codex) | [CLI license](https://github.com/openai/codex/blob/main/LICENSE); hosted services are separately governed by the applicable [Terms of Use](https://openai.com/policies/terms-of-use/) or [Services Agreement](https://openai.com/policies/services-agreement/) |

The provider's current agreement governs actual use. Development assistance and
recorded agent output do not transfer ownership of provider models to Entente.

## Diagrams, presentation, and branding

| Material | Source and attribution | License / provenance |
| --- | --- | --- |
| Archify standalone viewers and handoff SVG/GIF exports | [tt-a1i/archify](https://github.com/tt-a1i/archify); authored inputs in docs/diagrams and presentation/public/diagrams | MIT; retained [Archify license](presentation/public/diagrams/ARCHIFY-LICENSE.txt), including tt-a1i and Cocoon AI notices. See [rebuild instructions](docs/diagrams/README.md). |
| Presentation React/SVG diagrams | Project-authored material; design sources described in [presentation/README.md](presentation/README.md) | Project MIT license; third-party UI/icon packages are listed separately in the npm inventory. |
| Entente logo (LOGO.png and presentation/public/logo.png) | Generated with GPT (OpenAI), confirmed by the project maintainer on 2026-09-06; supplied as Entente project branding | AI-generated project asset. Generation is subject to the applicable OpenAI terms linked above. No separate asset license has been specified; the exact model version and generation date were not recorded. |
| README badges | [Shields.io](https://shields.io/), loaded from img.shields.io | [Upstream source and license](https://github.com/badges/shields/blob/master/LICENSE); service-rendered badges are external resources. |

No stock-image collection, external training dataset, or model-weight bundle is
declared in the checked-in project. The logo's GPT origin is based on maintainer
confirmation.

## Demo, replay, and experiment data

- The demo application, example contracts, and hand-written fixtures are project
  materials distributed with the repository under MIT.
- The live event logs record project demo missions, not customer production data.
  Their origins and outcomes are described in [fixtures/README.md](fixtures/README.md).
  Recorded personal home paths in live JSONL and Rust replay fixtures are replaced
  by `/Users/relay-demo`; event identities, checks, and verdicts are preserved.
- The maintainer confirmed on 2026-09-06 that the names, emails, organization and
  account identifiers, and debug bypass token in
  [P3's conversation history](experiments/round-2/cases/P3/history.md) are synthetic.
  They are intentionally retained as leak-detection canaries, with patterns in
  that case's case.json. They are not real customer records or usable credentials.
- Anonymization applies to the current fixture files. Earlier Git revisions and
  presentation evidence links pinned to older commits retain their historical
  content; this documentation change does not rewrite that history.
