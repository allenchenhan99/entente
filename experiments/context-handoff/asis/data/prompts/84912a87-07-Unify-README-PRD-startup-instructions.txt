Repo: D:\vscode_python\unvisited (Traivial). You may ONLY touch README.md. Do not touch PRD.md, any code, or any other file.

This is P1 item 9 from docs/PRODUCT_COMPLETION_PLAN.md ("交付驗證補強"): "統一 README 與 PRD 的啟動方式：後端 :8000、前端 :8080，並標示 node 與 playwright install chromium 需求。"

Steps:
1. Read PRD.md's "怎麼跑" section near the end (search for "怎麼跑" or "pip install -r requirements.txt") — it documents: `pip install -r requirements.txt`, `playwright install chromium` (needed for flight/stay/route/hours queries), `python -m traivial.server` (backend :8000), `cd web && python -m http.server 8080` (frontend), first run is demo mode, and a table of optional env vars.
2. Read README.md in full and check whether its startup/quickstart instructions match PRD.md's: same commands, same ports, and crucially whether it mentions the `node` requirement (check if README currently requires Node.js for anything, e.g. `node --check` used in testing/dev, or a build step) and the `playwright install chromium` requirement.
3. If README.md's quickstart section is missing or inconsistent with PRD.md's (wrong port, missing playwright install step, missing node mention if node is actually required elsewhere in the repo — check package.json or scripts/ for node usage), fix README.md's quickstart section to match. If README.md already fully matches, make no changes and just report that.
4. Do not invent a Node.js requirement if none exists in the repo — first verify by checking for package.json or web/js usage requiring a node runtime (vs. just being served as static files via `python -m http.server`).

Report: whether README.md needed changes, what you changed (or confirmed already consistent), and paste a diff-style summary. Keep this narrowly scoped — do not restructure README.md beyond the startup/quickstart section.