"use client";

import { Pause, Play, RotateCcw, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStoryPlayback } from "@/lib/use-story-playback";

type Playback = ReturnType<typeof useStoryPlayback>;
const repo = "https://github.com/allenchenhan99/entente";

function StoryControls({ story, count }: { story: Playback; count: number }) {
  return <div className="story-controls"><span className="autoplay-state">{story.reduced ? "靜態總覽" : story.complete ? "播放完成" : story.paused ? "已暫停" : "自動演示"}</span><span className="beat-count">{String(story.beat + 1).padStart(2, "0")} / {String(count).padStart(2, "0")}</span><div className="story-progress"><i style={{ transform: `scaleX(${story.progress})` }} /></div><Button variant="ghost" size="icon" aria-label={story.paused ? "繼續動畫" : "暫停動畫"} onClick={story.toggle} disabled={story.complete || story.reduced}>{story.paused ? <Play /> : <Pause />}</Button><Button variant="ghost" size="icon" aria-label="重播動畫" onClick={story.replay} disabled={story.reduced}><RotateCcw /></Button></div>;
}
function StoryCaption({ eyebrow, text, story, count }: { eyebrow: string; text: string; story: Playback; count: number }) {
  return <div className="story-caption"><div className="caption-copy"><span>{eyebrow}</span><p>{text}</p></div><StoryControls story={story} count={count} /></div>;
}
function Definitions({ prefix }: { prefix: string }) {
  return <defs><filter id={`${prefix}-glow`} x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter><marker id={`${prefix}-arrow`} markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0 0 8 4.5 0 9" fill="none" stroke="currentColor" strokeWidth="1.4" /></marker><pattern id={`${prefix}-grid`} width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#7b7991" opacity=".22" /></pattern></defs>;
}
function Wire({ id, path, active, reached = false, tone = "violet", prefix, label, x, y }: { id: string; path: string; active: boolean; reached?: boolean; tone?: string; prefix: string; label?: string; x?: number; y?: number }) {
  return <g data-edge-id={id} data-active={active} className={`story-wire tone-${tone} ${active ? "is-active" : reached ? "is-past" : "is-pending"}`}><path d={path} className="wire-base" markerEnd={`url(#${prefix}-arrow)`} />{active && <><path d={path} className="wire-glow" filter={`url(#${prefix}-glow)`} /><path d={path} className="wire-trace" pathLength="100" /></>}{label && <text className="wire-label" x={x} y={y} textAnchor="middle">{label}</text>}</g>;
}
function DiagramNode({ id, x, y, title, detail, tag, active, past, tone = "violet", width = 224, children }: { id: string; x: number; y: number; title: string; detail?: string; tag?: string; active?: boolean; past?: boolean; tone?: string; width?: number; children?: React.ReactNode }) {
  return <g data-node-id={id} data-active={!!active} className={`story-node tone-${tone} ${active ? "is-active" : past ? "is-past" : "is-pending"}`} transform={`translate(${x} ${y})`}><rect width={width} height="110" rx="13" className="node-surface" />{active && <rect width={width} height="110" rx="13" className="node-outline" pathLength="100" />}<text x="20" y="27" className="node-tag">{tag}</text><text x="20" y="58" className="node-title">{title}</text>{detail && <text x="20" y="86" className="node-detail">{detail}</text>}{children}</g>;
}

const scopeBeats = [2500, 2500, 2000, 2000, 2000, 3000] as const;
const scopeLayers = [
  ["Prompt", "單次指令", "先把一個指令說清楚。"],
  ["Context", "任務資訊", "再給 Agent 這次任務需要的資訊。"],
  ["Harness", "工具與環境", "工具、權限與環境，支撐一個 Agent。"],
  ["Loop", "執行與修復", "讓任務能接收回饋、修復，也知道何時停止。"],
  ["Graph", "團隊與相依關係", "把多個 Agent、任務與交接連成協作圖。"],
  ["Provenance", "整條交付鏈的來源與依據", "Entente 的最外層定位：每次交付，都能追問來源、版本與驗證依據。"],
] as const;
export function Positioning() {
  const story = useStoryPlayback(scopeBeats);
  return <div className="animated-slide scope-story" data-story="scope" data-beat={story.beat} data-playing={story.playing} data-settled={story.complete}><div className="story-heading"><div><p className="kicker">01 / 我們的定位</p><h1>從一個指令，擴大到<span>整條交付鏈。</span></h1></div><span className="scope-signature">ENTENTE<br /><b>Provenance Engineering</b></span></div><div className="scope-stage"><div className="scope-context"><span>SCOPE</span><strong>由內向外<br />逐層擴大</strong><p>各層累積，<br />不互相取代。</p><div className="shared-requirement">加入登入<br /><b>不增加付費服務</b></div><div className={`scope-answer ${story.beat === 5 ? "revealed" : ""}`}><b>我們提出的<br />最外層定位</b><span>來源 · 版本 · 驗證</span></div></div><svg viewBox="0 0 970 505" className="scope-svg" role="img" aria-label="Prompt、Context、Harness、Loop、Graph，最外層為 Entente 提出的 Provenance Engineering"><Definitions prefix="scope" />{[...scopeLayers].reverse().map(([name, short], i) => { const n = 5 - i; const active = story.beat === n; const reached = story.beat >= n; return <g key={name} data-scope={name} data-active={active} className={`animated-scope ${active ? "is-active" : reached ? "is-past" : "is-pending"} ${i === 0 ? "outer-scope" : ""}`}><rect x={18 + i * 24} y={14 + i * 66} width={930 - i * 48} height={475 - i * 81} rx="14" className="scope-surface" />{active && <rect x={18 + i * 24} y={14 + i * 66} width={930 - i * 48} height={475 - i * 81} rx="14" className="scope-scan" pathLength="100" />}<text x={42 + i * 24} y={54 + i * 66} className="scope-step-number">0{n + 1}</text><text x={85 + i * 24} y={54 + i * 66} className="scope-step-title">{name} Engineering</text><text x={918 - i * 24} y={54 + i * 66} className="scope-step-detail" textAnchor="end">{short}</text></g>; })}</svg></div><StoryCaption eyebrow={scopeLayers[story.beat][0].toUpperCase() + " ENGINEERING"} text={scopeLayers[story.beat][2]} story={story} count={scopeBeats.length} /></div>;
}

const problemBeats = [4000, 4000, 4000, 2000] as const;
const problemCaptions = [
  ["一個關鍵限制", "假設任務要求：「加入登入，但不增加付費服務。」"],
  ["跨過一次交接", "下一個 Agent 接到的，可能只剩「把登入做好」。"],
  ["問題出在依據", "程式完成了，卻無法回答：原始限制是否仍被遵守？"],
  ["保留下來的原則", "交接應保留任務相關的要求、固定版本與來源，再用結果驗證。"],
] as const;
export function Decisions() {
  const story = useStoryPlayback(problemBeats);
  const b = story.beat;
  return <div className="animated-slide problem-story" data-story="problem" data-beat={b} data-playing={story.playing} data-settled={story.complete}><div className="story-heading"><div><p className="kicker">02 / 問題與取捨</p><h2>交接傳走了任務，<span>卻可能丟了依據。</span></h2></div><span className="concept-tag">設計情境示意<br />非實測結果</span></div><div className="problem-stage"><svg viewBox="0 0 1140 300" className="problem-svg" role="img" aria-label="原始限制在 Agent 交接時可能被摘要遺漏；三個未採用方法的設計風險"><Definitions prefix="problem" /><rect width="1140" height="300" fill="url(#problem-grid)" /><Wire prefix="problem" id="handoff-first" path="M282 111H446" active={b === 1} reached={b >= 1} label="委派" x={365} y={87} /><Wire prefix="problem" id="handoff-second" path="M670 111H834" active={b === 2} reached={b >= 2} tone="amber" label="提交結果" x={752} y={87} /><DiagramNode id="original-goal" x={58} y={56} tag="ORIGINAL REQUIREMENT" title="加入登入功能" detail="不增加付費服務" active={b === 0} past={b >= 1} /><DiagramNode id="next-agent" x={446} y={56} tag="AGENT HANDOFF" title="把登入做好" detail={b === 0 ? "等待任務" : "原始限制未附上"} active={b === 1} past={b >= 2} tone={b >= 1 ? "amber" : "violet"} /><DiagramNode id="result-claim" x={834} y={56} tag="DELIVERY" title="「完成了」" detail="符合哪一版要求？" active={b === 2} past={b >= 3} tone="amber" /><g className={`lost-requirement ${b >= 1 ? "revealed" : ""}`}><path d="M170 181V215H560" stroke="#dfad72" strokeWidth="1.5" strokeDasharray="5 7" fill="none" /><text x="583" y="221" fill="#e9b27c" fontSize="20">？  「不增加付費服務」的依據在哪裡</text></g></svg><div className="decision-strips">{[["每次重讀完整歷史", "重複成本與延遲"], ["共用可變摘要", "並行覆蓋與資訊混入"], ["entropy 優先選材", "資訊量不能代表重要性"]].map(([title, reason], i) => <div key={title} className="decision-strip is-reviewed"><span>0{i + 1}</span><div><strong>{title}</strong><p>{reason}</p></div><b>未採用</b></div>)}</div></div><StoryCaption eyebrow={problemCaptions[b][0]} text={problemCaptions[b][1]} story={story} count={problemBeats.length} /><div className="story-footnote">設計討論：<a href={`${repo}/issues/4`} target="_blank" rel="noreferrer">#4</a> · <a href={`${repo}/issues/7`} target="_blank" rel="noreferrer">#7</a><span>固定版本的 context checkpoint 仍是下一步提案。</span></div></div>;
}

const deliveryBeats = [2500, 2500, 2500, 2000, 3000, 2500, 2500, 2500] as const;
const deliverySteps = [
  ["01 / CONTRACT", "把範圍、驗收條件與修復預算寫進 Task Contract。", "task_proposed"],
  ["02 / ACCEPT", "接收者先接受契約；有關鍵疑問，先澄清再工作。", "task_accepted"],
  ["03 / CHECK", "Agent 提交 evidence，relayd 在任務 worktree 執行檢查。", "checks_started"],
  ["04 / FAILURE", "檢查失敗：記下是哪個條件，以及實際觀察到的結果。", "check_failed"],
  ["05 / REPAIR", "把失敗條件交回同一 Agent，以明確預算修復同一任務。", "repair_requested"],
  ["06 / RECHECK", "修復後再次提交 evidence，由 relayd 判定檢查結果。", "evidence_submitted"],
  ["07 / VERIFIED", "檢查通過，交付才獲得 Verified 狀態。", "task_verified"],
  ["每一步，都留下依據", "契約、檢查與修復都成為事件；狀態、圖與重播共用同一份歷史。", "JSONL → State · Graph · Replay"],
] as const;
export function Mechanism() {
  const story = useStoryPlayback(deliveryBeats);
  const b = story.beat;
  const full = b === 7;
  return <div className="animated-slide delivery-story" data-story="delivery" data-beat={b} data-playing={story.playing} data-settled={story.complete}><div className="story-heading"><div><p className="kicker">03 / 已實作的交付流程</p><h2>先約定，再檢查。<span>失敗就局部修復。</span></h2></div><span className="implementation-tag">RelayGraph<br />Claude Code / Codex 之上的協調層</span></div><div className="delivery-stage"><div className="contract-example">同一個要求 → Task Contract：<b>加入登入，不增加付費服務</b><span className="proposed-inline">Context checkpoint / Passport：提案，未實作</span></div><svg viewBox="0 0 1140 315" className="delivery-svg" role="img" aria-label="Task Contract 到 Agent 執行、relayd 檢查、失敗修復、重新驗證和 Verified。下方同步保留 JSONL 事件。"><Definitions prefix="delivery" /><rect width="1140" height="315" fill="url(#delivery-grid)" /><Wire prefix="delivery" id="accept" path="M264 90H324" active={b === 1} reached={b >= 1} /><Wire prefix="delivery" id="submit" path="M548 90H608" active={b === 2 || b === 5} reached={b >= 2} /><Wire prefix="delivery" id="pass" path="M832 90H892" active={b === 6} reached={b >= 6} tone="green" /><Wire prefix="delivery" id="fail" path="M720 146V234H548" active={b === 3} reached={b >= 3} tone="amber" label="失敗條件 + 檢查結果" x={850} y={209} /><Wire prefix="delivery" id="repair" path="M436 179V146" active={b === 4} reached={b >= 4} tone="amber" /><DiagramNode id="contract" x={40} y={35} tag="TASK CONTRACT" title="定義交付" detail="範圍 · 驗收 · 預算" active={b === 0} past={b > 0} /><DiagramNode id="agent" x={324} y={35} tag="CODING AGENT" title={b === 4 ? "修復同一任務" : "接受後執行"} detail="先接受，或提出澄清" active={b === 1 || b === 4} past={b > 1} /><DiagramNode id="verifier" x={608} y={35} tag="RELAYD CHECKS" title={b === 5 ? "重新檢查" : "執行宣告的檢查"} detail="在任務 worktree 驗證" active={b === 2 || b === 5} past={b > 2} /><DiagramNode id="verified" x={892} y={35} tag="VERIFIED" title="驗證通過" detail="結果有檢查依據" active={b === 6} past={full} tone="green" /><DiagramNode id="repair" x={324} y={179} tag="BOUNDED REPAIR" title="局部修復要求" detail="只針對失敗條件修正" active={b === 3} past={b >= 4} tone="amber" /><g className="repair-budget"><text x="610" y="284">超過修復預算 → 停止並升級處理</text></g><g className="scope-boundary-note"><text x="40" y="225">程式與證據留在</text><text x="40" y="253">各自的 task worktree</text></g></svg><div className={`event-ledger ${full ? "is-active" : ""}`}><span className="ledger-label">JSONL<br /><strong>每一步同步記錄</strong></span><div className="event-receipts">{deliverySteps.slice(0, 7).map((step, i) => <span key={step[2]} data-event={step[2]} className={b === i ? "is-active" : b > i ? "is-recorded" : ""}>{step[2]}</span>)}</div></div></div><StoryCaption eyebrow={deliverySteps[b][0]} text={deliverySteps[b][1]} story={story} count={deliveryBeats.length} /><div className="story-footnote"><span>relayd 執行檢查；檢查由誰設計，仍是另一個信任條件。</span><a href="./diagrams/delivery.html?theme=dark&present=1&play=1#view=delivery" target="_blank" rel="noreferrer">Archify 完整圖 <ArrowUpRight size={13} /></a></div></div>;
}
