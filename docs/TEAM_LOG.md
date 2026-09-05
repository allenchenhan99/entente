# Agent team log

## 2026-09-05 - curl installer for project-local launches

- Owner: main Codex agent. Scope: `install.sh`, its hermetic tests, LF attributes
  for the shell script/test fixtures, installation documentation, CI, and this
  log. The user requested installation followed by `cd my-project; entente`.
  Product runtime, protocol, presentation drafts, and user workspace changes
  are outside this change. No subagents or real coding agents were launched.
- Inventory: the existing benchmark and report worktrees were preserved. Work
  uses the temporary detached `D:/vscode_python/entente-install` worktree, first
  at `4130ed4`, then advanced without overlapping edits to original
  `origin/main` at `ec7a7246c07b4ad42fd281fe36625a2610929dd6`. No named local or
  remote branch was created. Retirement condition: approved integration into
  the original repository and successful validation, or explicit cancellation.
- Behavior: macOS/Linux/WSL x64 and arm64 source installation builds TypeScript
  plus `termd` and `relay-tui`; compatible Node/Rust are reused, missing tools
  are installed privately. Node archives are checksum-verified. Git, curl, tar,
  and a C compiler are prerequisites. The command is installed to an existing
  PATH directory and preserves cwd/arguments. Immutable release directories
  keep a failed build from replacing the working command. No shell profiles
  are edited. `--no-native` explicitly selects the TypeScript/Ink-only build.
- Narrow validation: `sh -n install.sh` passed; `node --test
  scripts/install.test.mjs` passed all 13 tests on WSL Ubuntu, with fake
  downloads/build tools and temporary directories. Coverage includes piped
  stdin, default PATH selection, cwd/arguments, spaces/apostrophes in paths,
  failed updates, unmanaged paths, concurrent install locks, incomplete native
  builds, private Node relocation/checksum failure, and private Rust bootstrap.
  LF attributes were checked with `git check-attr text eol`.
- Real installation smoke: in an isolated WSL temporary directory, with neither
  Node/npm nor Cargo initially on PATH, the local installer cloned original
  commit `ec7a724`, installed private Node 22.23.2 and Rust 1.98.1, completed
  `npm ci --include=dev`, `npm run build` (`tsc -b`), and
  `cargo build --release --locked -p termd -p relay-tui`. Both native binaries
  existed. The relocated `entente --help` succeeded from a separate empty
  `my-project` directory, which remained empty. No mission/LLM was run.
- Integration validation from that installed release: launcher tests 30/30;
  full `vitest run` 64 files passed, 640 tests passed, 2 skipped. Local QA logs
  are outside tracked source at `/tmp/entente-install-qa.I7UCJgUT/install.log`
  and `vitest.log` inside WSL Ubuntu. macOS execution is configured in the new
  CI matrix but has not been run locally; Windows native PowerShell is outside
  this `.sh` installer.
- Publication: the user approved committing and pushing this installer to
  `allenchenhan99/entente` original `main`. A fresh fetch confirmed the reviewed
  base is still `ec7a724`. This commit integrates only the six scoped files;
  there are no source commits to transplant, merge conflicts, or presentation
  changes. Public script hash and Linux/macOS CI are checked after the push.
  The temporary detached worktree is retired after successful verification.
  Branch audit for this task before publication: one active detached installer
  worktree, zero new remote branches, zero uncertain branches introduced.
  Existing benchmark/report worktrees remain owned by their original tasks.
  The main worktree's preexisting modified/untracked files were preserved.

## 2026-09-05 — animated hackathon presentation and GitHub Pages

- Owner: main Codex agent. User requested a redesign with Claude, automatic
  Archify-style diagram highlights, and publication on the original repository's
  GitHub Pages.
- Inventory: reused the existing `report/hackathon-pitch` worktree at `46d3fcf`
  for design work. No new named local or remote branch was created. Publication
  uses a temporary detached worktree based on original `origin/main` at `70e7024`;
  retirement condition is successful source push and verification of the deployed
  commit, or a documented Pages setup checkpoint.
- Claude Code: Opus with high effort, selected for narrative design and
  counterexample review. Its first prompt restricted reads to report/source
  evidence and Archify documentation. The only later authorized write was a local
  review artifact; implementation, Git operations, hosting and agent spawning
  remained outside its scope. The main agent reviewed the advice and implemented
  all accepted changes. The dedicated Herdr pane was closed when review finished.
- Accepted: one shared login requirement across the first three slides; outward
  scope growth; finite autoplay; current/past/future emphasis; a visible failed
  check and repair route; meaningful reduced-motion overview; implementation and
  proposal labels on slide 3. Rejected alternatives remain static annotations to
  avoid implying measured experiments. The 26-second draft delivery animation
  was shortened to 20 seconds.
- Integration scope: `presentation/**`, `.github/workflows/pages.yml`, README
  report links, and this log. Only accepted presentation files were copied from
  the report worktree. The prior Sites scaffold and hosting configuration,
  reference repositories, raw agent review, browser profiles, QA screenshots,
  credentials and product runtime changes are not published.
- Validation: Node 22 production build and TypeScript pass. Real headless Chrome
  verifies all three autoplay sequences without user interaction, six outward
  scope steps, moving edge traces, the failure/repair route, finite final state,
  pause/resume/replay and reduced motion. All six pages fit 1440×900 without
  content scrolling; all six mobile pages have no page-level horizontal overflow.
  Mobile flow diagrams retain internal horizontal scrolling. A 1920×1080
  projection frame was visually reviewed. The one video slot is intentionally
  empty until the team supplies its <=120-second demo.
- Archify: the frozen delivery-motion specification passes all nine deterministic
  checks with zero errors/warnings. Generated light/dark artifacts were visually
  reviewed at 1440×900 and 2048×1320. The larger slide-native SVG text and slower
  timelines support live narration; the full generated Archify viewer remains
  linked separately.
- Publication constraint discovered before push: authenticated GitHub repository
  permissions include write but not admin/maintain. Pages creation API returns
  404. A repository owner may need to select Settings → Pages → GitHub Actions;
  the checked-in workflow then builds and deploys automatically.
- Branch audit for this task: one active report work line; zero new remote
  branches; one temporary detached publication worktree to retire at checkpoint;
  zero uncertain branches introduced. Existing user benchmark work is preserved.
