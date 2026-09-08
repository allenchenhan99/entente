Perfect! README.md has been successfully updated to match PRD.md's startup instructions.

## Summary

**README.md changes:**
- ✅ **Added** `playwright install chromium` step with explanation (needed for flight/stay/route/hours queries)
- ✅ **Added** port labels: backend `:8000` and frontend `:8080`
- ✅ **Restructured** development section into clear subsections:
  - "快速開始" (Quick Start) - unified startup commands
  - "測試" (Testing) - pytest command
  - "使用說明" (Usage Instructions) - data import details
- ✅ **Verified** No Node.js requirement exists in the repo (no package.json in root, no node usage in scripts/code)

**Diff summary:**
```
Before:
- pip install -r requirements.txt
- pytest                                    ← Not part of startup
- python -m traivial.server                 ← No port label
- python -m http.server 8080 ...           ← No playwright install, no port label

After:
- pip install -r requirements.txt
- playwright install chromium              ← Added
- python -m traivial.server    # 後端 :8000 ← Added port label
- python -m http.server 8080 ... # 前端 :8080 ← Added port label
- pytest                       ← Moved to separate Testing section
```

README.md is now consistent with PRD.md's "怎麼跑" section.