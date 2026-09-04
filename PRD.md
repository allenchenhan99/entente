# RelayGraph — PRD (Hackathon MVP)

> 版本：v0.2 · 日期：2026-09-05 · 賽事：FUTUREMODE BUILDMODE Gen-AI Hackathon 2026（台北）
> Track：AI Agents & Automation · 團隊：2 人（Engine ×1、UI ×1）
> 狀態：v0.1 的 MVP 與 Phase 2 R1/R2 已實作（見 §16、§22）；本版把敘事對齊到「痛點 → Agent Networking → 自建 terminal base」，並把外部 terminal host 降為選配 adapter。

---

## 0. 一句話

**RelayGraph 把 coding agents 之間模糊的自然語言交接，變成可確認、可追蹤、可驗證、可重試的工作契約。**

> Agent frameworks tell you whether an agent is running.
> RelayGraph tells you whether agents actually understand each other.

它由兩層組成，從零開發：

1. **Agent Networking 控制層（relayd）**：agents 之間的每一次交接都是一條有 handshake、有證據、有終止條件的 **edge**；agents 可以再委派 subtask，於是整個協作是一張會長大的 **graph**（§1.5）。
2. **自己的 terminal base（Relay Terminal：termd + relay-tui）**：一個知道 agent 在幹嘛的終端機。pane 依圖擺放、契約畫在 pane 之間、人的動作放在需要它的 pane 旁邊、就緒偵測與 prompt 送達有量測、錄製回放在同一視窗。

它不重做 agent runtime（Claude Code、Codex 原樣使用，透過 MCP 參與協定），也不做通用 workflow engine。現有的 terminal multiplexer 與 agent terminal 管理工具是我們對照的痛點來源，不是產品前提。

---

## 1. 問題

多個 coding agents 已經可以被啟動、互傳訊息、呼叫工具。但「訊息送達」不等於「任務交接成功」。實際常見的失敗：

| 失敗 | 根因層 |
|---|---|
| Recipient 缺少關鍵 input，卻依自己的假設開工 | Specification |
| 雙方對「完成」定義不同 | Specification |
| 整段對話紀錄被原封轉傳，關鍵資訊被淹沒 | Inter-agent misalignment |
| Agent 回報 `done`，沒有 diff、測試結果或任何 evidence | Verification |
| 驗證失敗後整份任務重跑，浪費 token 與時間 | Termination / repair |
| Agent 被 block，其他人不知道它在等什麼 | Observability |
| 兩個 agents 改同一批檔案，產出互相覆蓋 | Coordination |

**研究佐證**

- MAST（*Why Do Multi-Agent LLM Systems Fail?*, arXiv 2503.13657）整理出 14 類失敗，集中在 specification、inter-agent misalignment、task verification/termination；受測系統失敗率 41%–86.7%。
- EAGER（arXiv 2603.21522, 2026）Table 1：在固定的 MAS 裡失敗模式高度集中且重複。AutoGen-Code 的失敗 48.3% 是 Incorrect Code、34.5% 是 Decomposition Error；SWE-Agent 則是 Incorrect Code 46.2%、Localization Error 28.2%、Editing Error 25.6%。結論：失敗可預期，值得在交接邊界上事前攔截，並在失敗後做 **scoped**、分層（單一 agent vs 整體 orchestration）的修復。

RelayGraph 的立場：EAGER 事後從失敗 trace 學習；RelayGraph 事前把交接結構化，讓多數協調失敗不會發生，剩下的失敗天生可定位。兩者互補。

### 1.4 現有 agent terminal 工具的痛點

多 agent 的日常工具是 terminal multiplexer 加一層 agent 管理。我們自己用這類工具跑了十幾個 agent 之後，痛點很一致：

| 痛點 | 後果 | RelayGraph 的做法 |
|---|---|---|
| 終端機只知道「有個 process 在跑」，不知道 agent 在做哪個任務、理解對不對 | 人要逐個 pane 讀螢幕猜狀態 | agent 透過 MCP 自己宣告契約、狀態、問題、證據；pane 是圖上的節點 |
| 「就緒」靠猜：prompt 何時能送、送到了沒、被吃掉了沒，全靠人盯 | 大段 prompt 卡在 composer、多按一次 Enter 才送出、agent 空轉 | 每個 pane 有 screen model 與 readiness 判斷，prompt 送達與接受有量測（`PaneTimings`），失敗有明確錯誤 |
| Agent 間傳話是自由文字或整段對話紀錄 | 關鍵資訊被淹沒、對「完成」定義不同 | Task Contract：結構化交接 + accept/clarify handshake |
| 主 agent 叫子 agent 沒有回程 | 回報靠人搬，沒有證據、沒有驗證 | `propose_subtask` / `await_task`：委派也是 edge，一樣有 handshake、evidence、verdict |
| Blocked 沒有通道 | agent 卡住等人，人不知道它在等什麼 | `report_blocker` → inbox → `relay reply`，回覆進 agent 的 `await_reply` |
| 版面是 pane 的樹，不是工作的圖 | 六個 agent 就看不出誰依賴誰、誰在等誰 | 版面由 graph object model 驅動；edge 上畫 handoff 狀態 |
| 錄製回放要另外接工具 | demo / audit 靠事後拼 | 事件 log 與每個 pane 的 asciinema cast 共用時間軸，同一視窗回放 |

這些是我們決定自建 terminal base 的直接原因（§22）。

### 1.5 Agent Networking：loop engineering 與 graph engineering

RelayGraph 對「多 agent 協作」的模型只有兩個概念，兩者都由事件 log 導出、都畫在畫面上：

**Graph engineering — 協作是一張圖。**
- 節點：`human`、`planner`、每個 task 的 agent、`verifier`（relayd 的驗證引擎與人的 `human_review`，虛擬節點）。
- 邊：`contract`（誰派給誰、第幾版、handshake 狀態）、`evidence`（agent → verifier）、`dependency`（task 之間）、`question` / `reply`（agent ↔ human）。
- 圖是動態的：agent 可以 `relay_propose_subtask` 委派子任務，子任務有自己的 worktree、契約、驗證；完成後 relayd 把它 merge 回父 worktree，父 agent 用 `relay_await_task` 拿到結果。這就是 **agent networking**：agents 之間有可驗證的呼叫與回程，而不是一條聊天串。
- 圖上每個物件都是 object：可選取、可 `describe`（事實）、可 `story`（它的事件敘事）、可 `actions`（此刻人能做什麼）。

**Loop engineering — 每條邊都是一個有終止條件的迴圈。**
- 交接迴圈：`proposed → needs_clarification → revised → accepted`，直到理解對齊才能開工。
- 驗證迴圈：`evidence_submitted → checks → verified | retry_requested(delta repair) → …`，只重跑失敗的 criterion。
- 升級梯子：local repair → orchestration（重新拆解）→ human；同一失敗重複、預算用盡、停滯、需要人的決策，四種條件之一即終止。
- Lint（communication debt）在迴圈開始前攔截：沒有可機器驗證的 AC、缺 input、範圍重疊，契約就不會 spawn。

Relay Terminal 是這兩個概念的畫面：左邊是圖（節點、邊、迴圈狀態），右邊是節點本身（真實 agent terminal），下面是需要人的地方（inbox）。

---

## 2. 目標與非目標

### 2.1 Hackathon MVP 要證明的五件事

1. Agent 在寫 code 之前，是否清楚理解收到的任務（accept / clarify handshake）。
2. 任務是否有明確、**可機器驗證**的 acceptance criteria。
3. Agent 的「完成」宣告是否有 evidence，且 evidence 由系統而非 agent 自己產生。
4. 驗證失敗時，是否只修必要的部分（delta repair），而不是整個 workflow 重跑。
5. 人類能否從一個畫面看懂每個 agent 與每條 handoff 的真實狀態。

### 2.2 Demo 核心指標（評審一句話能記住的）

> RelayGraph 在 agent 寫 code 前攔截一個模糊 handoff，並在驗證失敗後只重跑一個 criterion，而不是整個 workflow。

### 2.3 非目標（明確不做）

- 不做通用 terminal multiplexer 或 shell 替代品：Relay Terminal 只承載由 RelayGraph 派出的 agent pane 與其圖；一般 shell 工作交給使用者原本的終端機。
- 不依賴任何外部 terminal multiplexer 或 agent terminal 管理工具；它們至多是效率對比的基準。
- 不做通用 low-code workflow builder、不做拖拉節點。
- 不做 cloud scheduler、agent marketplace、production deployment。
- 不做跨組織 IAM。
- 不做所有 agent framework 的支援；MVP 一個真實 adapter 協定，兩個 runtime 走同一協定。
- 不做 autonomous graph rewriting。

---

## 3. 目標使用者與場景

**Primary user**：同時操作 2–6 個 coding agents 的開發者或小團隊。典型組合：一個 planner 拆任務、frontend / backend / test agents 平行、一個 verifier 收尾；人在 Relay Terminal 一個視窗裡看圖、看 pane、回答問題。

**初始 use cases**：feature implementation、bug repair、migration、test generation、平行前後端、code review remediation。

**Hackathon demo mission**（刻意模糊）：

```
Add secure login to this application.
```

---

## 4. 產品原則

1. **Clarify before execution**：資訊不足時先問，不猜。
2. **Contract over conversation dump**：傳結構化契約與 artifact references，不傳聊天紀錄。
3. **Evidence over self-reporting**：`done` 必須對應每條 acceptance criterion 的 evidence，且 evidence 由 RelayGraph 在 worktree 中執行檢查而得。
4. **Local repair over global retry**：只重做失敗的 criterion；同樣失敗重複時才升級到 orchestration 層。
5. **Explicit termination**：每個 loop 都有成功、預算、停滯、人工介入四種終止條件。
6. **Human-visible coordination**：人看得到 agent 的理解、假設、blocker、依賴與 retry 原因。
7. **Edge is the product**：UI 的主角是 handoff（edge），不是 agent（node）。

---

## 5. 系統架構

### 5.1 總覽

```
┌─ Relay Terminal ── relay-tui (Rust, Ratatui) ─────────────────────────────────────────┐
│ ┌ MISSION / WORKTREES ┐ ┌ PANES（真實 agent terminal，依圖擺放）────────────────────┐ │
│ │ tree                │ │ backend · t-backend-auth · working                        │ │
│ ├ HANDOFFS（graph）───┤ │ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │ │
│ │ human ─v2✓─▶ backend│ │ │ planner      │ │ frontend     │ │ subtask      │        │ │
│ │ backend ─sub⏳─▶ …  │ │ └──────────────┘ └──────────────┘ └──────────────┘        │ │
│ ├ INBOX ──────────────┤ └───────────────────────────────────────────────────────────┘ │
│ │ ? backend asks 6    │  status: live · seq · frame p95 · pane ready/accept/render      │
└─┴─────────────────────┴───────────────────────────────────────────────────────────────┘
        │ HTTP /state /graph /story · SSE /events · POST 命令        │ WS /pty/:id
        ▼                                                          ▼（relayd 轉發）
┌─ relayd (TypeScript daemon) ───────────────────────────┐   ┌─ termd (Rust) ────────────────┐
│ Contract store │ Event log (JSONL) │ State reducer      │   │ PTY per pane（portable-pty）  │
│ Linter         │ Verification      │ Repair policy      │──▶│ screen model（vt100）          │
│ MCP server     │ Agent launcher    │ Recorder/Replayer  │   │ readiness · prompt delivery   │
│ Graph object model over HTTP · Worktree manager        │   │ asciinema cast · PaneTimings   │
│ TerminalHost: relayterm(termd, 預設) · relay(TS 備援)   │   │ HTTP/WS socket API + /metrics │
│               · 外部 host adapter（選配）               │   └───────────────────────────────┘
└────────────────────────────┬───────────────────────────┘
                             ▲ MCP (streamable HTTP, bearer task token)
                    Claude Code / Codex agents（每個 task 一個 git worktree）
                    Demo repo (Node + vitest web app) · .relay/wt/<task-id>
```

入口是 root bin `entente`：打 relayd 的 `/health`，沒回應就以 detached 背景程序啟動 relayd，等健康後把終端機交給 relay-tui；Rust 沒 build 時退回 TypeScript host 與 Ink TUI。

### 5.2 元件與責任

| 元件 | 語言 / 技術 | 責任 | 負責人 |
|---|---|---|---|
| `packages/protocol` | TS, zod | Contract / Event / State 型別與 schema；純函式 `reduce(state, event)`；lint rules。engine 與 UI 共用 | Engine |
| `apps/relayd` | Node/TS, Hono 或 Fastify, `@modelcontextprotocol/sdk` | HTTP API、SSE、MCP server、agent launcher、worktree、verification、repair、recording | Engine |
| `crates/termd` | Rust（tokio、axum、portable-pty、vt100） | Relay Terminal 的 PTY host：pane、screen model、readiness、prompt 送達、cast、`PaneTimings` / `HostMetrics`；wire protocol 凍結於 `packages/protocol/src/pty.ts`（`docs/relay-term-spec.md`） | Engine |
| `crates/relay-tui` | Rust（Ratatui、crossterm、tui-term） | Relay Terminal 客戶端：tree、graph、真實 pane grid、inbox、inspector；只走 HTTP/SSE/WS，不跑 reducer | UI |
| `apps/launcher` + `bin/entente.mjs` | TS | root bin `entente`：health check → detached relayd → TUI；`status` / `down` | Engine |
| `apps/tui` | TS, Ink | 備援 TUI（Rust 未 build 時），同一套 graph object model | UI |
| `apps/cli` | TS | `relay up / status / clarify / review / reply / inbox / explain / story / pane * / replay` 薄包裝 | Engine |
| `demo-repo/` | Node + vitest | 有 user model、session store、email stub 的小型 web app | Engine（Day 1 建好） |
| `fixtures/` | JSONL + .cast | 錄好的事件流與 terminal cast，供 UI 開發與 replay 保底 | 兩人 |

### 5.3 關鍵設計決策

| 決策 | 選擇 | 理由 |
|---|---|---|
| Adapter 形式 | **RelayGraph 本身是 MCP server**，agent 透過 MCP tools 參與協定 | Claude Code 與 Codex 都原生支援 MCP；不用抓 terminal 字；同一個 server 接兩個 runtime 即證明協定跨模型 |
| Terminal host | 自建：`termd`（Rust）為預設 host，relayd 以 `relayterm` 驅動並轉發 `/panes*`、`/pty/*`、`/metrics`；TypeScript `relay` host 為備援；外部 terminal host 以選配 adapter 接入 | §1.4 的痛點只有掌握 PTY 與 screen model 才解得掉；就緒與送達必須可量測 |
| UI 形式 | 自己的 terminal base（relay-tui, Ratatui）：圖與真實 agent pane 在同一視窗 | 版面由 graph object model 驅動；agent terminal 是真的 pane，不是截圖 |
| 分工 | 腦（協定、reducer、驗證、repair、MCP）留 TypeScript；terminal base 用 Rust | 協定與 reducer 已驗證且與 UI 共用 zod schema；PTY/渲染要低延遲與長時穩定 |
| 效率量測 | 每個 pane 從 R1 起記錄 `PaneTimings`（spawn、first output、readiness、prompt write/accept、Enter retries、render p50/p95、throughput），`GET /metrics` 彙總 | 產品要能與純 claude / codex CLI 對比執行率，不能事後補 |
| 狀態來源 | Append-only event log，所有 state 由 reducer 導出 | Replay、audit、UI 與 engine 用同一份 reducer |
| 驗證方式 | Deterministic checks 由 relayd 在 worktree 執行；agent 的自我宣稱僅作對照 | 「done」第一次有機器意義；self-report mismatch 本身是指標 |
| Repair 執行 | 同一個 agent session 收到 delta repair contract（MCP `await_verdict` 回傳） | 保留 context，真正省 token；不重開 session |
| Clarification 回答者 | 人類在 TUI 回答；planner 自動回答為 nice-to-have | Demo 可控、可解釋 |
| 平行寫 code | 每個 task 一個 git worktree + branch（spawn 前建立），`allowed_paths` 限制範圍 | 避免互相覆蓋；non_goals 變成可機器檢查；Claude Code 的 cwd 在啟動時固定，所以 worktree 必須先於 agent 存在 |
| 主要 runtime | Claude Code 為主，Codex 為第二個 agent | OpenAI 為贊助商；同一協定跨 runtime |

---

## 6. 核心資料模型

所有 schema 定義於 `packages/protocol`，用 zod 宣告，同時產生 TS 型別與 JSON Schema（給 MCP tool 描述用）。

### 6.1 Mission

```yaml
mission:
  id: m-001
  repo: /path/to/demo-repo
  title: Add secure login to this application
  success_definition: Users can sign in securely; all task contracts verified
  status: planning | executing | integrating | verified | failed | canceled
  budget:
    max_repairs_per_task: 3
```

### 6.2 Task Contract

```yaml
task_contract:
  id: t-backend-auth
  mission_id: m-001
  version: 2                       # 每次 revise +1，舊版保留
  sender: planner
  recipient: backend               # agent role name
  runtime: claude-code | codex     # 由 planner 或 human 指定

  goal: Implement email magic-link authentication endpoints

  inputs:                          # 路徑相對於 repo root，lint 會檢查存在
    - docs/auth-spec.md
    - src/models/user.ts
    - src/session/store.ts

  constraints:
    - Reuse the existing session storage
    - Magic links expire after 15 minutes
    - Links are single-use

  non_goals:
    - OAuth login
    - Account recovery
    - Frontend UI

  scope:
    allowed_paths:                 # diff 只能落在這些路徑，否則 evidence 被拒
      - src/auth/**
      - src/routes/auth.ts
      - tests/auth/**

  acceptance_criteria:
    - id: AC-1
      condition: A valid magic link creates a user session
      check: { kind: command, run: "npx vitest run tests/auth/valid-link.test.ts" }
    - id: AC-2
      condition: An expired magic link is rejected with 401
      check: { kind: command, run: "npx vitest run tests/auth/expired-link.test.ts" }
    - id: AC-3
      condition: A link cannot be reused after first successful use
      check: { kind: human_review }          # 人類在 TUI 標 pass / fail
    - id: AC-4
      condition: Changes stay within allowed scope
      check: { kind: diff_scope }            # 自動由 scope.allowed_paths 導出

  output:
    type: code_change
    evidence_required: [git_diff, changed_files, check_outputs]

  dependencies: [t-auth-schema]

  budget:
    max_repairs: 3
    stagnation_limit: 2            # 同一 AC 連續失敗 N 次且 diff 無變化 → 升級

  clarifications: []               # 由人類回答後附加，見 6.3
```

`check.kind` 列舉：

| kind | 執行者 | 說明 |
|---|---|---|
| `command` | relayd，在該 task 的 worktree | exit code 0 為 pass；stdout/stderr 尾段存為 evidence |
| `diff_scope` | relayd | 變更檔案 ⊆ `scope.allowed_paths` |
| `file_exists` | relayd | 指定路徑存在 |
| `human_review` | 人類，在 TUI | 可附 observed_failure；Demo 中用於可控地觸發 repair |
| `llm_judge` | relayd 呼叫 LLM（nice-to-have） | 以 criterion + diff 判斷，結果標示為 non-deterministic |

沒有 `check` 的 AC 會被 lint 標為 **unverifiable**（error 等級，阻止 spawn）。

### 6.3 Contract Response（recipient 開工前必回）

```yaml
contract_response:
  task_id: t-backend-auth
  contract_version: 2
  decision: accepted | needs_clarification | rejected
  interpretation:                  # accepted 時必填：用自己的話重述
    - Backend endpoints only; no UI
    - Reuse current session model
    - Done means AC-1..AC-4 pass
  assumptions:
    - Email provider credentials exist in dev env
  risks:
    - Current token schema may not support single-use
  verification_plan:               # accepted 時必填：每條 AC 對應打算怎麼證明
    AC-1: Add tests/auth/valid-link.test.ts
    AC-2: Add tests/auth/expired-link.test.ts with fake timers
  questions:                       # needs_clarification 時必填
    - id: Q1
      text: What is the required link expiration time?
      blocking: true
```

人類回答後，relayd 產生 **v(n+1)**：把答案附加進 `clarifications`（`{question_id, answer, answered_by, at}`），重新 lint，重新 propose。Planner-LLM 產生修訂版為 nice-to-have。

### 6.4 Evidence Submission

```yaml
evidence_submission:
  task_id: t-backend-auth
  contract_version: 2
  attempt: 1
  claimed:                         # agent 的自我宣稱
    AC-1: { status: passed, note: "test_valid_link passes" }
    AC-2: { status: passed, note: "test_expired_link passes" }
    AC-3: { status: passed, note: "token marked used after first login" }
  summary: Implemented /auth/request and /auth/verify
```

relayd 收到後自動補上：

```yaml
evidence_record:
  git_diff: .relay/evidence/t-backend-auth/a1.patch
  changed_files: [src/auth/token.ts, src/routes/auth.ts, tests/auth/...]
  checks:
    AC-1: { status: passed, output: .relay/evidence/.../AC-1.txt, duration_ms: 3120 }
    AC-2: { status: failed, output: ..., observed: "expected 401, received 200" }
    AC-3: { status: pending_human }
    AC-4: { status: passed }
  self_report_mismatch: [AC-2]     # agent 說 passed、系統測 failed
```

### 6.5 Repair Contract（delta，不是重派整份任務）

```yaml
repair_contract:
  id: t-backend-auth/r1
  parent_task: t-backend-auth
  parent_version: 2
  attempt: 2
  failed_criteria: [AC-2]
  observed_failure: "GET /auth/verify with expired token returned 200; expected 401"
  requested_correction: Reject expired tokens and make tests/auth/expired-link.test.ts pass
  unchanged_scope:
    - Do not modify frontend code
    - Do not change the session schema
  remaining_repairs: 2
```

### 6.6 Event（唯一的寫入原語）

```ts
type Event = {
  seq: number;          // 全域遞增
  ts: string;           // ISO 8601
  mission_id: string;
  task_id?: string;
  actor: 'human' | 'planner' | 'relayd' | `agent:${string}`;
  type: EventType;
  payload: unknown;     // 依 type 由 zod 驗證
};
```

`EventType` 清單：

```
mission_created · tasks_planned · lint_reported
task_proposed · clarification_requested · clarification_answered · contract_revised
task_accepted · task_rejected
worktree_created · agent_spawned · agent_exited
work_started · progress_reported · task_blocked · task_unblocked
evidence_submitted · checks_started · check_passed · check_failed · human_review_recorded
repair_requested · repair_accepted
task_verified · task_completed · task_failed_budget · task_escalated · task_canceled
integration_started · integration_conflict · mission_verified · mission_failed
```

State 完全由 `reduce(events)` 導出。UI 與 relayd 使用同一個 reducer（`packages/protocol`）。

---

## 7. 狀態機

### 7.1 三層狀態，各自回答一個問題

| 層 | 問題 | 值 | 來源 |
|---|---|---|---|
| Runtime | Agent process 現在在幹嘛？ | `idle` `working` `blocked` `done` `exited` `unknown` | termd 的 pane 存活與 readiness（screen tier）+ MCP 呼叫心跳 + `report_blocker` |
| Task | 工作進展到哪？ | `pending` `proposed` `accepted` `executing` `awaiting_verification` `repairing` `completed` `failed` `canceled` | reducer |
| Handoff | 雙方對交接有共識嗎？ | `draft` `proposed` `needs_clarification` `revised` `accepted` `rejected` `evidence_submitted` `retry_requested` `verified` | reducer |

三者獨立：agent `idle` 不代表完成；task `executing` 也可能在做錯誤理解的事；handoff `accepted` 才代表理解對齊。

### 7.2 Handoff lifecycle

```
draft
  ↓ task_proposed
proposed
  ├─ clarification_requested ─→ needs_clarification ─ clarification_answered ─→ revised ─→ proposed (v+1)
  ├─ task_rejected ─→ rejected (terminal)
  └─ task_accepted ─→ accepted
                        ↓ work_started
                     (task: executing; runtime 可在 working / blocked 間切換)
                        ↓ evidence_submitted
                     evidence_submitted
                        ├─ any check_failed ─→ retry_requested ─ repair_accepted ─→ (task: repairing) ─→ evidence_submitted
                        └─ all checks passed ─→ verified ─→ (task: completed)
Alternate terminal: canceled · failed_budget · escalated
```

### 7.3 Runtime 狀態判定（不抓 terminal 字）

| 訊號 | 推得 |
|---|---|
| 任一 MCP tool call（`relay_await_*` 除外） | `working`（更新 last_seen） |
| `report_blocker` | `blocked`，直到下一次 tool call 或 `task_unblocked` |
| `submit_evidence` 後 | `done`（等待 verdict；期間的 `relay_await_verdict` 輪詢不改變狀態） |
| 無 tool call > 90s 且 pane 存活 | `idle` |
| pane 不存在 / pid 結束 | `exited` |
| Nice-to-have：Claude Code hooks（`PreToolUse` → working、`Stop` → idle） | 更精確 |

---

## 8. Agent 協定（MCP）

relayd 在 `http://127.0.0.1:<port>/mcp` 提供 streamable HTTP MCP server。每個 agent 啟動時拿到一份專屬 `mcp-config`，header 帶 `Authorization: Bearer <task_token>`，relayd 由 token 識別呼叫者是哪個 task。Codex 若不支援 HTTP MCP，附一個 20 行的 stdio → HTTP shim。

### 8.1 Tools（給 recipient agents）

| Tool | 用途 | 回傳 |
|---|---|---|
| `relay_get_contract` | 取目前版本契約 | Task Contract |
| `relay_respond_to_contract` | accept / needs_clarification / rejected，含 interpretation、assumptions、risks、verification_plan、questions | 若 accepted：開工許可（`work_started` 事件）；若 needs_clarification：`{status: waiting}` |
| `relay_await_contract` | 等待新版本（clarification 回答後）；`timeout_s` 內無新版本回 `pending` | 新版契約或 pending |
| `relay_report_progress` | 進度訊息 | ok |
| `relay_report_blocker` | 說明卡在什麼、等誰 | ok |
| `relay_submit_evidence` | 提交 claimed 狀態與摘要；relayd 自動蒐集 diff 與執行 checks | `{attempt, checks_started: true}` |
| `relay_await_verdict` | 等待驗證結果；`timeout_s` 內未完成回 `pending` | `verified` 或 `repair_contract` 或 `pending` |

### 8.2 Tools（給 planner）

| Tool | 用途 |
|---|---|
| `relay_get_mission` | 取 mission 與 repo 摘要 |
| `relay_propose_task` | 提出一份 Task Contract（relayd 立即 lint；error 等級會回傳錯誤要求修正） |
| `relay_list_tasks` | 目前所有 task 與狀態 |
| `relay_revise_task` | 修改契約（v+1） |
| `relay_answer_clarification` | nice-to-have：planner 代替人回答 |

### 8.3 Agent 生命週期（recipient）

1. relayd 先建立 worktree `.relay/wt/<task-id>`（branch `relay/<task-id>`；base 為 repo HEAD 依序 merge 所有 `dependencies` 的 branch），發出 `worktree_created`，再透過 `TerminalHost`（預設 termd）開新 pane，以該 worktree 為 cwd 啟動 `claude --session-id <uuid> --mcp-config <file> --permission-mode acceptEdits "<bootstrap prompt>"`，發出 `agent_spawned`。
2. Bootstrap prompt 規定：先 `relay_get_contract`；若契約缺少會導致「實作方向實質不同」的資訊，**必須** `relay_respond_to_contract(needs_clarification)`，然後 `relay_await_contract` 輪詢；否則 `accepted` 並附 interpretation 與 verification_plan。
3. `accepted` 時 relayd 發出 `task_accepted` 與 `work_started`；agent 已在 worktree 內，直接開工。needs_clarification 期間 worktree 存在但為空 branch，agent 不得寫檔（bootstrap prompt 明訂）。
4. 完成後 `relay_submit_evidence`，再 `relay_await_verdict` 輪詢。
5. 收到 `repair_contract` 就在同一 session 修，再回到步驟 4；收到 `verified` 則結束。
6. Planner 同樣是一個 pane 中的 Claude Code session，用 8.2 的 tools 產生契約。保底：`relay plan --from plan.yaml` 直接載入手寫契約。

### 8.4 Spawn 條件

Agent 只在契約 **lint 無 error** 且所有 `dependencies` 進入 `completed` 後才被 spawn（因此 worktree 也在那時才建立，且已含依賴的產出）。依賴未完成的 task 在圖上顯示為 blocked-on-dependency。

---

## 9. 驗證引擎

1. `evidence_submitted` 觸發 `checks_started`。
2. relayd 在該 task 的 worktree：`git diff <base>..HEAD` 與 working tree 變更存成 patch；列出 changed files。
3. 依序執行每條 AC 的 check（`command` 有 120s timeout；`diff_scope` 純比對；`human_review` 發出 TUI 待辦）。
4. 每條 check 產生 `check_passed` / `check_failed` 事件，附 output 檔路徑與 `observed`（stderr 或 assertion 訊息尾段）。
5. 全部 pass → `task_verified`。任一 fail → 進入第 10 節的 repair policy。
6. `self_report_mismatch` 記錄 agent 說 passed 但系統測 failed 的 AC，是 demo 指標之一。

**Integration（fan-in）**：所有 task `completed` 後，relayd 建 `relay/integration` 分支，依 dependency 拓樸序 `git merge` 各 task branch，執行 mission 層 `integration_check`（預設 `npx vitest run`）。衝突 → `integration_conflict`，等待人類。通過 → `mission_verified`。

---

## 10. Repair 與升級梯子

```
check_failed
   ↓
Local repair（model-centric）：對同一 agent session 發 delta repair contract，只含失敗的 AC
   ↓ 若同一 AC 連續 stagnation_limit 次失敗，且 diff 無實質變化
Orchestration repair（orchestration-centric）：task_escalated；通知 planner（或人）重新拆解或修改契約
   ↓ 若 max_repairs 用盡，或 agent 回報無法在限制內完成，或需要 product decision
Human：task 停在 failed_budget / escalated，TUI 顯示完整失敗歷史，等人決定
```

**Loop 終止條件**（任一成立即停）：全部 AC pass；`max_repairs` 用盡；stagnation；agent 明確回報無法完成；需要 human approval 或 product decision。

MVP 實作 Local repair 與 Human；Orchestration repair 只做「發出 `task_escalated` 事件並在圖上標示」，不自動重新拆解。

---

## 11. Lint（Communication Debt）

Rule-based，執行時機：`task_proposed` 與每次 `contract_revised`。

| Rule | 等級 | 說明 |
|---|---|---|
| `missing_goal` | error | goal 空或少於 8 字 |
| `no_acceptance_criteria` | error | AC 為空 |
| `unverifiable_criterion` | error | AC 沒有 `check` |
| `unbounded_scope` | error | 沒有 `scope.allowed_paths` |
| `unbounded_retry` | error | 沒有 `budget.max_repairs` |
| `missing_input` | error | `inputs` 指向不存在的檔案 |
| `unknown_dependency` / `dependency_cycle` | error | 依賴不存在或成環 |
| `overlapping_scope` | warning | 與同 mission 其他 task 的 `allowed_paths` 重疊（衝突風險） |
| `no_non_goals` | warning | 沒寫 non_goals |
| `no_evidence_required` | warning | output 未指定 evidence |
| `stale_handoff` | warning（runtime） | proposed > 5 分鐘無回應 |
| `long_block` | warning（runtime） | blocked > 5 分鐘 |
| `interpretation_drift` | info（nice-to-have, LLM） | recipient 的 interpretation 與契約明顯不符 |

error 阻止 spawn；warning 顯示於圖與時間軸。Lint 結果本身是事件（`lint_reported`），因此可回放。

---

## 12. Relay Terminal 客戶端規格（`crates/relay-tui`；`apps/tui` 為 Ink 備援，同一物件模型）

本節的版面、物件與鍵盤在 relay-tui 與 Ink TUI 上一致；差別是 relay-tui 的右側是 termd 的真實 pane（WS `/pty/:id`），而 Ink 版只顯示狀態。

### 12.1 版面（左欄圖與樹約 35%，右欄真實 agent pane）

```
┌─ RelayGraph ─────────────────────────┐┌─ planner ─────────────────┐
│ MISSION  Add secure login   executing││ (claude)                  │
│ lint: 1 error · 2 warnings           │├─ backend ─────────────────┤
│ ▾ demo-repo                          ││ (claude)                  │
│   ▸ planner     ● done    completed  │├─ frontend ────────────────┤
│   ▸ backend     ● working executing  ││ (codex)                   │
│       wt .relay/wt/t-backend  v2 ✓   │└───────────────────────────┘
│   ▸ frontend    ○ idle    proposed   │
│       needs_clarification  ? 2       │
│   ▸ tests       ◐ blocked pending    │
│       waiting on backend             │
├─ HANDOFFS ───────────────────────────┤
│                                      │
│ planner ─v2✓─▶ backend ╌╌╌▶ verifier │
│    │             ▲dep                │
│    ├─ ? 2 ──▶ frontend               │
│    │                                 │
│    └─v1✓─▶ tests ◀── AC-2 ──┘        │
│                                      │
├─ TIMELINE ───────────────────────────┤
│ 10:03 planner revised backend → v2   │
│ 10:04 backend accepted v2            │
│ 10:12 backend submitted evidence #1  │
│ 10:13 AC-2 failed → repair r1        │
│ ▶ live                     [F1 help] │
└──────────────────────────────────────┘
```

右側每個 agent 是 termd 建立的真實 pane：聚焦的 pane 全尺寸並可輸入（`i` 進入、`Esc` 離開），其餘以縮圖（最後三行）呈現；標題列為 `role · task · status`。狀態列顯示連線、最後事件 seq、TUI frame p50/p95，以及聚焦 pane 的 readiness / prompt accept / render p95。

### 12.2 上區：Mission / worktree tree

- 節點：Mission（repo）→ 各 task。每行顯示 role、runtime 狀態符號（`●` working、`○` idle、`◐` blocked、`✓` done、`✗` exited）、task state、handoff state 與版本、worktree 路徑（spawn 後出現，`accepted` 前為暗色，`accepted` 後轉亮）。
- 顏色只跟 **handoff state** 走：琥珀 needs_clarification、綠 accepted/verified、紅 retry_requested、灰 proposed。
- 選取 task：圖上高亮其所有 edge；`f` 聚焦該 agent 的 pane，`Enter` 開 inspector（describe / story / actions）。

### 12.3 中區：Handoff graph（§1.5 的圖）

- 固定欄位佈局：Human / Planner ｜ agents（依 dependency 深度縱向堆疊，subtask 緊接其父）｜ Verifier ｜ Done。不用力導向，投影不抖。
- Edge 種類：contract（`v2 ✓`、`? 2`、`sub ⏳ v1`、`sub ✓ merged`、`sub ✗ conflict`）、evidence（`✓` / `AC-2`）、dependency、question / reply（`↩ 7`）。attention 的 edge 高亮。
- 現況：靜態圖、選取、inspector 已實作；下一步是動態（§22.4）。
- **Verifier 是虛擬節點**：代表 relayd 的驗證引擎與人類的 `human_review`，不是 LLM agent、沒有 pane。
- 字元畫布：二維 `{char, fg, bold}` 陣列，事件到達即更新，動畫以 8–10 fps 重繪。
- Edge 狀態與動畫：

| Handoff state | 外觀 | 動畫 |
|---|---|---|
| proposed | 灰虛線 `╌╌╌▶` 標 `v1` | 亮暗慢呼吸 |
| needs_clarification | 琥珀 `? n` 徽章 | 明顯脈動（demo 主角） |
| accepted | 綠實線 `───▶` 標 `v2 ✓` | 一次「鎖上」閃爍 |
| awaiting evidence | 到 verifier 的 `╌╌╌▶` | 每幀位移一格 |
| evidence_submitted | `●` 沿 edge 滑向 verifier | 一次性 |
| retry_requested | 紅色回流 edge 標 `AC-2` | 反向位移 |
| verified | 綠 `✓` | 定格 |

- Node：名稱 + runtime 符號 + attempt 次數 + 經過時間。Blocked 顯示 `◐` 與等待對象。`accepted` 時名稱由暗轉亮（契約確認、工作開始）。
- 選取 edge 後按 `Enter` 開 Contract overlay（12.5）。

### 12.4 下區：Event timeline

- 最近 N 筆事件，每筆一行；`t` 展開全高。
- 底列顯示模式：`▶ live` 或 `⏸ replay 42/118`。Replay 時 `←/→` 逐事件、`Space` 播放/暫停、`[`/`]` 調速。

### 12.5 Contract overlay（覆蓋圖區）

分頁：**Contract**（目前版本全文、與上一版 diff）｜**Response**（interpretation、assumptions、risks、verification_plan）｜**Questions**（待回答問題與輸入框）｜**Evidence**（每條 AC 的 check 結果、observed、output 尾段、changed files、self-report mismatch）｜**History**（所有版本與 repair）。

### 12.6 鍵盤

| 鍵 | 動作 |
|---|---|
| `j/k` `↑/↓` | 在樹或圖中移動 |
| `Tab` | 樹 ↔ 圖 ↔ 時間軸 |
| `Enter` | 樹：聚焦 agent pane；圖 edge：開 overlay |
| `a` | 回答選取 task 的 clarification（輸入框） |
| `p` / `f` | 對 `human_review` 的 AC 標 pass / fail（fail 需輸入 observed_failure） |
| `x` | 取消 task（確認） |
| `t` | 展開／收合時間軸 |
| `r` | 切換 replay 模式（載入 fixtures） |
| `?` | 說明 |

### 12.7 資料流

TUI 啟動時 `GET /state` 取快照，再 `GET /events?since=<seq>` 訂閱 SSE。所有畫面由 `packages/protocol` 的 reducer 導出。人類操作全部是 `POST` 命令：`/tasks/:id/clarify`、`/tasks/:id/review`、`/tasks/:id/cancel`。Replay 模式改讀本地 JSONL，不連 relayd。

---

## 13. 錄製與 Replay（demo 保底）

- **事件**：relayd 將每個 event append 到 `.relay/runs/<run-id>/events.jsonl`。
- **終端機**：termd 把每個 pane 錄成 asciinema v2 `.cast`（`.relay/runs/<run>/casts/<pane>.cast`），與事件共用時間軸；`screenAt(t)` 可把 cast seek 到任一時刻的畫面。
- **Replay**：`relay replay <run-id>` / `entente --replay <fixture dir>`：TUI 讀 JSONL 逐事件推進；pane 由 cast 同步重建。畫面與 live 完全相同。
- Demo 策略：**live 為主**。Day 3 上午錄一次完整成功 run 當保底；live 若在某一步卡住，立刻切 replay 到同一步繼續講。

---

## 14. Demo 腳本

前置：`entente --repo ~/entente-demo/app` 已把 relayd、termd 與 relay-tui 帶起來；字級 ≥ 18pt。整場 demo 不離開這個視窗。

| 步驟 | 操作 | 畫面上發生什麼 | 想證明 |
|---|---|---|---|
| 1 | `relay up "Add secure login to this application."` | Mission 節點出現；planner pane 啟動 | 進入點簡單 |
| 2 | Planner 呼叫 `relay_propose_task` ×3 | 三條灰 edge 出現；lint 立刻標一個 error（例如 frontend 契約 AC 無 check） | **寫 code 前攔截** |
| 3 | Backend agent 讀契約，`needs_clarification` | edge 轉琥珀脈動 `? 2`；agent 沒有動任何檔案 | Clarify before execution |
| 4 | 人按 `a`，回答：magic link、15 分鐘、單次使用、不含 OAuth | 契約 v2；edge 由琥珀轉灰再轉綠；overlay 顯示 backend 的 interpretation 與 verification_plan | 理解被說出來、被記錄 |
| 5 | Backend 與 frontend 開工；tests 等 backend | backend 節點轉亮、edge 流動；tests 顯示 `◐ blocked on backend`，runtime 尚未 spawn | 三層狀態分離、依賴可見 |
| 6 | Backend `submit_evidence` | `●` 滑向 verifier；checks 逐條亮綠；AC-2 亮紅（或人以 `f` 標 AC-3 fail 並輸入 observed） | Evidence over self-report |
| 7 | Repair r1 出現 | 紅色回流 edge 標 `AC-2`；其他 task 完全不動 | **Local repair** |
| 8 | 第二次 evidence 全 pass | 全圖轉綠；integration 跑完；mission verified | 終止條件明確 |
| 9 | 按 `r` 拖時間軸回到步驟 3 | 動畫重播 | Audit trail 可回放 |
| 10 | 顯示 metrics 列 | 見第 15 節 | 量化 |

第 6 步的兩條路：live 測試真的失敗最好；若 live 全過，人以 `human_review` 對 AC-3 標 fail（這是真實產品功能，不是假資料），repair loop 一樣成立。

---

## 15. Demo 指標（TUI 底部或 overlay 顯示）

| 指標 | 計算 |
|---|---|
| Contracts blocked before execution | lint error 數（阻止 spawn 的契約數） |
| Fields filled via clarification | clarifications 條數 |
| Criteria with machine check | 有 `check` 且非 human 的 AC / 全部 AC |
| Self-report mismatches | agent 說 passed 但系統 failed 的 AC 數 |
| Tasks NOT re-run on repair | repair 發生時仍 `completed` / `executing` 且未被重派的 task 數 |
| Blocker → visible latency | `task_blocked` 事件到 TUI 顯示的時間（近乎 0，對比人工翻 terminal） |
| Replayable events | 100%（所有 state 由 event 導出） |
| Pane efficiency（`relay pane metrics`） | 每個 pane 的 readiness、prompt write / accept、Enter retries、render p50/p95、output bytes；用來與純 claude / codex CLI 對比執行率 |

---

## 16. 範圍與現況（2026-09-05）

### 已實作並合併（main，CI 綠）

- `packages/protocol`：contract / events / state / lint（13 條）/ reducer / api / mcp / pty / graph object model；`docs/protocol.md` 與 JSON Schema 由 zod 產生。
- relayd：HTTP + SSE、MCP server（recipient 與 planner 兩組 tools，含 `propose_subtask` / `await_task`、`ask_human` / `await_answers`、`report_blocker` / `await_reply`）、worktree manager（整合分支、subtask merge 回父）、verification（`command` / `diff_scope` / `file_exists` / `human_review` / `llm_judge`，sandbox 隔離）、delta repair 與升級梯子、guards、session token、persist / resume、graph over HTTP。
- Relay Terminal：`crates/termd`（R1）、`crates/relay-tui`（R2）、relayd `relayterm` host + proxy、`entente` launcher、`PaneTimings` / `HostMetrics` 與 `relay pane metrics`。
- 備援：TypeScript `relay` host、Ink TUI、外部 terminal host adapter（選配）。
- demo-repo、`examples/plan-*.yaml`、`fixtures/events-live-1..7.jsonl`（七次真實 run）。
- 已驗證：secure-login mission 以 claude + codex 走 termd 跑完 clarification → v2 → checks → repair → human review → verified。

### 下一步（依序）

1. 用修好 sandbox 的 daemon 重跑完整 demo，錄 fixture 8 與 relay-tui 畫面。
2. Codex 大段 paste 的 Enter retry 由 5 s 等待改為偵測 `[Pasted Content` 即補送。
3. 「RelayGraph vs 純 claude / codex CLI」benchmark：同一 mission，比 wall-clock、prompt 送達、人工介入次數、返工次數。
4. R3 daemon / attach：termd 常駐、多 client attach、TUI 斷線重連。
5. R4 動態圖（§22.4）：handshake 動畫、迴圈狀態在 edge 上即時更新、每條 edge 的 metrics。

### Out of scope

見 2.3。

---

## 17. 里程碑與分工

| 里程碑 | 內容 | 狀態 |
|---|---|---|
| M1 協定與驗證層（MVP） | contract / handshake / evidence / delta repair / lint / TUI / replay | 完成（2026-09-04） |
| M2 Agent Networking | planner 先問人、blocker 回覆通道、subtask 委派與回程、graph object model、`relay inbox / explain / story` | 完成（2026-09-04） |
| M3 Relay Terminal R1–R2 | termd、relay-tui、relayterm host、launcher、metrics | 完成（2026-09-05） |
| M4 動態圖與 benchmark | §22.4、對比純 CLI 的執行率 | 進行中 |
| M5 R3 daemon / attach | termd 常駐、多 client、重連 | 規劃中 |

分工：Engine 負責 relayd、termd、launcher、驗證與協定；UI 負責 relay-tui 的版面與動態圖、`apps/web` 選配。兩人之間的整合契約是 `packages/protocol`（含 `pty.ts`、`graph/types.ts`）與 `docs/relay-term-spec.md`。

---

## 18. 風險與對策

| 風險 | 對策 |
|---|---|
| Live agent 不提問就直接寫 | Bootstrap prompt 強制規則；demo repo 與 mission 刻意不提 auth 方式；保底 replay |
| Live 測試全過，看不到 repair | `human_review` AC 由人標 fail（真實功能）；或切 replay |
| MCP long-poll 被 client timeout 切斷 | `await_*` 以 `timeout_s ≤ 60` 回 `pending`，agent 重呼叫 |
| Codex 不支援 HTTP MCP | stdio → HTTP shim；或 Codex 降為 nice-to-have |
| 兩個 agent 改同檔 | worktree 隔離 + `allowed_paths` + `overlapping_scope` lint |
| TUI 重繪效能 | relay-tui 量測 frame p50/p95 顯示在狀態列；動畫 ≤ 10 fps；只重繪變動區 |
| 就緒 / 送達誤判（screen tier 是啟發式） | 讀取尾端 8 行並過濾 chrome；`PaneTimings` 讓誤判可見；下一層 declared / hook tier 由 agent 自己宣告 |
| Codex 大段 paste 留在 composer | Enter retry（現 5 s）改為偵測即補送；prompt 失敗留 pane 供診斷 |
| 投影字太小 | ≥ 18pt；只留兩個 pane；配色高對比 |
| Verifier 誤判 | deterministic checks 為主；human override 永遠可用 |
| 契約填寫成本高 | planner 自動產生；人只回答問題與高風險欄位 |
| 範圍膨脹 | §16 的下一步依序做，每項獨立可 demo；備援（TS host、Ink TUI、replay）永遠可用 |

---

## 19. 開源與外部貢獻（加分項）

架構已經把「別人能接手的邊界」切出來了；這一節把它落實成 repo 內容，目標是評審或任何開發者打開 GitHub 後 10 分鐘內能提 issue、30 分鐘內能提第一個 PR。

| 項目 | 內容 | 時程 |
|---|---|---|
| 公開 repo | GitHub public，MIT license | Day 1 |
| README | 一句話定位、demo GIF（由 replay 錄）、`pnpm i && relay up` 三行上手、架構圖（第 5 節） | Day 3 |
| `docs/protocol.md` | MCP tools、Event 清單、Contract schema（由 zod 自動輸出 JSON Schema）、handoff state machine。這是「別人可以照著寫另一個 runtime adapter」的規格 | Day 2 |
| 兩個可擴充介面 | `TerminalHost`（relayterm / relay，外部 host 以 adapter 接入）與 `AgentRuntime`（claude-code / codex），各自一個資料夾、一個介面檔、一個現成實作 | 已完成 |
| Lint rules 插件化 | `packages/protocol/src/lint/rules/*.ts`，一條 rule 一個檔，附測試；新 rule 是最容易的 first PR | Day 1 |
| Fixtures 即測試 | `fixtures/*.jsonl` 同時是 UI 開發資料、replay 素材與 reducer 的測試輸入 | Day 1 |
| CI | GitHub Actions：`pnpm test`（vitest）+ typecheck | Day 2 |
| Issue templates | `bug`、`adapter request`（新 runtime / terminal host）、`lint rule proposal`、`demo scenario` | Day 3 |
| CONTRIBUTING.md | 開發環境、如何跑 replay 不用真 agent、如何加 adapter、如何加 lint rule | Day 3 |
| Good first issues | 例如「Gemini CLI runtime」、「新 lint rule：AC 與 non_goals 矛盾」、「declared readiness tier」、「relay-tui 主題」 | 持續 |

設計上刻意讓貢獻不需要碰核心：新 runtime 只實作 `AgentRuntime`，新 host 只實作 `TerminalHost`，新 lint 只加一個檔。Replay 模式讓貢獻者不需要任何 LLM API key 就能跑完整 UI 與測試。

---

## 20. 定位與 pitch lines

RelayGraph 不是 chat UI、agent launcher、workflow editor、autonomous coder。
RelayGraph 是 **coding-agent teams 的 semantic coordination and verification layer**。

- Agent frameworks manage execution. We manage understanding.
- GitHub made code collaboration explicit. RelayGraph makes agent collaboration explicit.
- Stop debugging what your agents built. Start debugging what they understood.
- Terminal multiplexers show you processes. RelayGraph shows you the handshake.
- Agent networking, not agent chatting: every call has a contract, evidence, and a way back.

---

## 21. 決策紀錄

| 日期 | 決策 | 原因 |
|---|---|---|
| 2026-09-04 | （已推翻）UI 只佔外部 multiplexer 的一個 pane、不自嵌 PTY | 當時為砍工作量；Phase 2 改為自建（見下） |
| 2026-09-04 | Engine 與 UI 皆 TypeScript | MCP SDK、Ink、共用 zod schema |
| 2026-09-04 | Claude Code 為主 runtime，Codex 為第二 | 同協定跨模型；OpenAI 為贊助商 |
| 2026-09-04 | Clarification 由人類回答 | demo 可控 |
| 2026-09-04 | AC 必須綁 `check`，否則 lint error | 讓 done 有機器意義 |
| 2026-09-04 | Repair 走同一 agent session | 保留 context，省 token |
| 2026-09-04 | Demo repo 為自備 Node + vitest app | evidence 來源清楚 |
| 2026-09-04 | Phase 2 自建 agent-based terminal（Relay Terminal） | 版面要由物件圖驅動並可客製；產品要有自己的畫面 |
| 2026-09-04 | Planner 對 mission 級歧義先問人；人可回覆 agent 的 blocker | 執行前決策應由人做；blocker 需有回覆通道 |
| 2026-09-04 | Agent networking：agent 可委派 subtask（`propose_subtask` / `await_task`），子任務 merge 回父 worktree | 主 agent 呼叫子 agent 要有回程與證據 |
| 2026-09-05 | Terminal base 以 Rust + Ratatui 重寫（termd + relay-tui）；relayd 的腦與協定留 TypeScript | 掌握 PTY 與 screen model 才能解 §1.4 痛點；協定已驗證不必重寫 |
| 2026-09-05 | 效率 metrics 從 R1 起埋在 termd socket API（`PaneTimings` / `HostMetrics`） | 之後要與純 claude / codex CLI 對比執行率 |
| 2026-09-05 | root bin `entente`：health check → detached relayd → TUI；預設用自建 terminal base | 一個指令進入產品 |
| 2026-09-05 | 外部 terminal host 降為選配 adapter 與對比基準；PRD 不再以任何外部工具為前提 | 產品是從零開發的 terminal base |

---

## 22. Phase 2：Relay Terminal（自建 agent-based terminal）

MVP 證明了協定與驗證層；Phase 2 把「畫面」也收進產品：一個由 RelayGraph 物件圖驅動、從零打造的終端機。

### 22.1 為什麼要自建

§1.4：現有工具都是「先有終端機、再猜 agent 在幹嘛」；RelayGraph 是「先知道 agent 在幹嘛（契約、狀態、問題、證據都由 agent 透過 MCP 自己宣告）」。由這份知識驅動的 host 可以做到它們做不到的事：pane 依圖擺放、契約畫在 pane 之間、人的動作放在需要它的 pane 旁邊、就緒與送達可量測、錄製與回放在同一視窗。這就是 §1.5 的 Agent Networking 在畫面上的樣子。

### 22.2 架構（hybrid）

- **termd（Rust，`crates/termd`）**：PTY host。每個 pane = portable-pty process + vt100 screen model（5000 行 scrollback）+ 256 KiB raw ring + asciinema v2 cast。HTTP/WS socket API 與 `packages/protocol/src/pty.ts` 一比一（`POST /panes`、`/screen`、`/readiness`、`/input`、`/wait-output`、`/kill`、`/focus`、`/resize`、`/cast`、`/metrics`、WS `/pty/:id`），bearer token 或 WS subprotocol `relay.<token>`。readiness（尾端 8 行、過濾 chrome、400 ms quiet）與 prompt 送達（等就緒 → bracketed paste → Enter → 偵測 composer 仍持有 paste 則重送，最多 3 次，30 s 逾時、pane 留存）逐行對照 TypeScript 參考實作。規格：`docs/relay-term-spec.md`。
- **relayd（TypeScript）**：`relayterm` TerminalHost 生 termd、解析 listening line、以 `POST /panes` 送 prompt；reverse proxy 讓所有 client 仍走 relayd 的 `/panes*`、`/pty/*`、`/metrics`（外層 session token，內層 termd token）。graph object model 以 `/graph`、`/graph/:kind/:id/{describe,story,actions}`、`/story` 提供給不跑 reducer 的 client。
- **relay-tui（Rust，`crates/relay-tui`）**：Ratatui 客戶端。左欄 tree + graph，右欄真實 pane grid（tui-term + vt100，聚焦 pane 全尺寸可輸入），底部 inbox，inspector overlay；`/events` SSE 觸發 `/graph` 重抓；`--replay <fixture dir>` 離線渲染；frame p50/p95 顯示於狀態列。
- **entente（`apps/launcher`）**：一個指令帶起整套；binary 未 build 時退回 TypeScript host 與 Ink TUI。
- **metrics**：`PaneTimings`（spawn / first output / readiness / prompt write / prompt accept / retries / render p50・p95 / throughput）與 `HostMetrics` 從 R1 起存在，`relay pane metrics` 與 relay-tui 狀態列都讀它。

凍結介面：`packages/protocol/src/pty.ts`、`packages/protocol/src/graph/types.ts`、`packages/protocol/src/api.ts`（graph routes）、`apps/relayd/src/ports.ts`、`docs/relay-term-spec.md`。

### 22.3 階段

| 階段 | 內容 | 狀態 |
|---|---|---|
| R1 `termd` | PTY host、socket API、readiness、prompt 送達、cast、metrics、CI rust job | 完成 |
| R2 `relay-tui` | Ratatui 客戶端、graph over HTTP、launcher 預設切換 | 完成 |
| R3 daemon / attach | termd 常駐、多 client attach、TUI 斷線重連、run 之間保留 pane | 規劃中 |
| R4 動態圖 | 見 22.4 | 規劃中 |
| 選配 `apps/web` | React + xterm.js 的瀏覽器版（同一 `/graph`、`/pty` 介面；`LayoutPreset` 為資料） | UI 夥伴 |

### 22.4 動態圖（下一步的 UI 重點）

現在左欄的圖是「正確但靜態」：節點、邊、狀態、可選取、可 inspect 都有。接下來讓它反映迴圈的動態：

- handshake 動畫：`proposed` 呼吸、`needs_clarification` 脈動、`accepted` 鎖上、evidence `●` 滑向 verifier、`retry_requested` 反向回流（§12.3 表的動畫欄）。
- subtask 委派邊即時顯示 `await_task` 的狀態（waiting → merged / conflict）。
- 每條 edge 可展開 metrics：從 propose 到 accept 的時間、repair 次數、prompt 送達延遲。
- 人的動作就在 edge 旁邊：inbox 項目與 edge 互相高亮。

### 22.5 完成定義

- §14 的 demo 全程在 Relay Terminal 內完成，不需任何外部 multiplexer 或另開 CLI（R2 已達成）。
- 錄製的 run 能在同一視窗回放，pane 輸出與事件對齊。
- `relay pane metrics` 能對同一 mission 給出「RelayGraph vs 純 CLI」的對照數字。
- 動態圖（22.4）在 demo 中可見。

---

## 23. 參考

- FUTUREMODE BUILDMODE Gen-AI Hackathon 2026：https://www.futuremode.xyz/hackathon
- Why Do Multi-Agent LLM Systems Fail?（MAST）：https://arxiv.org/abs/2503.13657
- EAGER: Efficient Failure Management for Multi-Agent Systems with Reasoning Trace Representation：https://arxiv.org/abs/2603.21522
- Agent Contracts: A Formal Framework for Resource-Bounded Autonomous AI Systems：https://arxiv.org/abs/2601.08815
- MultiAgentBench：https://arxiv.org/abs/2503.01935
- Model Context Protocol：https://modelcontextprotocol.io/
- Claude Code CLI reference（`--mcp-config`、`--session-id`、hooks）：https://docs.anthropic.com/en/docs/claude-code
- OpenAI Agents SDK — Handoffs：https://openai.github.io/openai-agents-js/guides/handoffs/
- LangGraph Persistence：https://docs.langchain.com/oss/python/langgraph/persistence
- Temporal Agentic AI：https://temporal.io/ai/agentic-ai
