import type { Event, State } from '@relay/protocol';
import { Box, Text, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

import type { FocusCommand } from './commands.js';
import { useDependencies } from './context.js';
import { useLiveState } from './data/live.js';
import { type ReplayView, useReplay } from './data/replay.js';
import { Graph } from './graph/Graph.js';
import { type FocusRegion, useAppKeys } from './keys.js';
import { Overlay } from './panels/Overlay.js';
import { Timeline } from './panels/Timeline.js';
import { Tree } from './panels/Tree.js';
import { useAnimationTick } from './tick.js';

export interface PanelHeights {
  tree: number;
  graph: number;
  timeline: number;
}

export function panelHeights(totalHeight: number, timelineExpanded: boolean): PanelHeights {
  const available = Math.max(0, totalHeight - 1);
  if (timelineExpanded) return { tree: 0, graph: 0, timeline: available };
  const tree = Math.floor(available * 0.4);
  const graph = Math.floor(available * 0.35);
  return { tree, graph, timeline: available - tree - graph };
}

export interface ReplayControls {
  toggle: () => void;
  step: (delta: 1 | -1) => void;
  halveSpeed: () => void;
  doubleSpeed: () => void;
}

export interface AppProps {
  state: State;
  events: Event[];
  mode: 'live' | 'replay';
  url: string;
  focusCmd: FocusCommand;
  width?: number;
  height?: number;
  cursor?: number;
  total?: number;
  playing?: boolean;
  speed?: number;
  replayAvailable?: boolean;
  replayControls?: ReplayControls;
  onToggleSource?: () => void;
  dataError?: string;
}

function useTerminalDimensions(widthOverride?: number, heightOverride?: number): { width: number; height: number } {
  const { stdout } = useStdout();
  const read = () => ({
    width: widthOverride ?? stdout.columns ?? 80,
    height: heightOverride ?? stdout.rows ?? 30,
  });
  const [dimensions, setDimensions] = useState(read);

  useEffect(() => {
    const update = () => setDimensions(read());
    update();
    stdout.on('resize', update);
    return () => { stdout.off('resize', update); };
  }, [heightOverride, stdout, widthOverride]);
  return dimensions;
}

function Panel({ title, active, height, children }: {
  title: string;
  active: boolean;
  height: number;
  children: React.ReactNode;
}) {
  if (height <= 0) return null;
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text bold color={active ? 'cyan' : 'gray'}>{active ? '▶ ' : '  '}{title}</Text>
      {children}
    </Box>
  );
}

function metricFooter(state: State): string {
  return `blocked:${state.metrics.contracts_blocked_before_execution} clarif:${state.metrics.fields_filled_via_clarification} mismatch:${state.metrics.self_report_mismatches} repairs:${state.metrics.repairs_total}`;
}

function modeFooter(props: AppProps): string {
  if (props.mode === 'live') return '▶ live';
  const marker = props.playing ? '▶' : '⏸';
  return `${marker} replay ${props.cursor ?? 0}/${props.total ?? 0} ×${props.speed ?? 1}`;
}

const HELP = 'j/k move · Tab region · Enter open/focus · a answer · p/f review · x cancel · t timeline · r replay · ←/→ step · Space play · [/ ] speed · Esc close';

export function App(props: AppProps) {
  const { width, height } = useTerminalDimensions(props.width, props.height);
  const [region, setRegion] = useState<FocusRegion>('tree');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const tick = useAnimationTick(true);
  const mission = Object.values(props.state.missions)[0];
  const taskIds = useMemo(
    () => mission?.task_ids.filter((taskId) => props.state.tasks[taskId] !== undefined) ?? Object.keys(props.state.tasks).sort(),
    [mission, props.state.tasks],
  );
  const selectedTaskId = taskIds[Math.min(selectedIndex, Math.max(0, taskIds.length - 1))];
  const selectedTask = selectedTaskId === undefined ? undefined : props.state.tasks[selectedTaskId];
  const sizes = panelHeights(height, timelineExpanded);
  const replayAvailable = props.replayAvailable ?? props.mode === 'replay';
  const keys = useAppKeys({
    state: props.state,
    selectedTaskId,
    region,
    url: props.url,
    focusCmd: props.focusCmd,
    replayAvailable,
    onMove: (delta) => setSelectedIndex((current) => Math.max(0, Math.min(taskIds.length - 1, current + delta))),
    onCycleRegion: () => setRegion((current) => current === 'tree' ? 'graph' : current === 'graph' ? 'timeline' : 'tree'),
    onToggleTimeline: () => setTimelineExpanded((current) => {
      if (!current) setRegion('timeline');
      return !current;
    }),
    onToggleReplay: props.onToggleSource,
    onReplayStep: props.replayControls?.step,
    onTogglePlaying: props.replayControls?.toggle,
    onHalveSpeed: props.replayControls?.halveSpeed,
    onDoubleSpeed: props.replayControls?.doubleSpeed,
  });

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Panel title="MISSION / WORKTREES" active={region === 'tree'} height={sizes.tree}>
        <Tree state={props.state} height={Math.max(0, sizes.tree - 1)} selectedTaskId={selectedTaskId} />
      </Panel>
      <Panel title="HANDOFFS" active={region === 'graph'} height={sizes.graph}>
        {keys.overlayOpen && selectedTask
          ? <Overlay task={selectedTask} tab={keys.overlayTab} inputMode={keys.inputMode} inputValue={keys.inputValue} error={keys.error} height={Math.max(0, sizes.graph - 1)} />
          : keys.helpOpen
            ? <Text>{HELP}</Text>
            : <Graph state={props.state} width={width} height={Math.max(0, sizes.graph - 1)} tick={tick} selectedTaskId={selectedTaskId} />}
      </Panel>
      <Panel title="TIMELINE" active={region === 'timeline'} height={sizes.timeline}>
        <Timeline events={props.events} height={Math.max(0, sizes.timeline - 1)} />
      </Panel>
      <Text inverse>{modeFooter(props)}  {metricFooter(props.state)}  ? help{props.dataError ? `  ERROR ${props.dataError}` : ''}</Text>
    </Box>
  );
}

export interface ConnectedAppProps {
  url: string;
  replayFile?: string;
  speed: number;
  focusCmd: FocusCommand;
  startInReplay?: boolean;
}

function LiveConnectedApp({ onToggle, ...props }: ConnectedAppProps & { onToggle: () => void }) {
  const dependencies = useDependencies();
  const live = useLiveState(props.url, { fetch: dependencies.fetch });
  return (
    <App
      state={live.state}
      events={live.events}
      mode="live"
      url={props.url}
      focusCmd={props.focusCmd}
      replayAvailable={props.replayFile !== undefined}
      onToggleSource={onToggle}
      dataError={live.error?.message}
    />
  );
}

function ReplayConnectedApp({ onToggle, replayFile, ...props }: ConnectedAppProps & { replayFile: string; onToggle: () => void }) {
  const replayView: ReplayView = useReplay(replayFile, props.speed);
  return (
    <App
      state={replayView.state}
      events={replayView.events}
      mode="replay"
      cursor={replayView.cursor}
      total={replayView.total}
      playing={replayView.playing}
      speed={replayView.speed}
      replayControls={replayView}
      replayAvailable
      onToggleSource={onToggle}
      url={props.url}
      focusCmd={props.focusCmd}
    />
  );
}

export function RelayGraphApp(props: ConnectedAppProps) {
  const [inReplay, setInReplay] = useState(Boolean(props.startInReplay && props.replayFile));
  const toggle = () => setInReplay((current) => props.replayFile === undefined ? current : !current);
  return inReplay && props.replayFile
    ? <ReplayConnectedApp {...props} replayFile={props.replayFile} onToggle={toggle} />
    : <LiveConnectedApp {...props} onToggle={toggle} />;
}
