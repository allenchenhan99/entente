import type { Event, Graph as ObjectGraph, GraphObjectRef, ObjectAction, State } from '@relay/protocol';
import { Box, Text, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

import type { FocusCommand } from './commands.js';
import { useDependencies } from './context.js';
import { useLiveState } from './data/live.js';
import { type ReplayView, useReplay } from './data/replay.js';
import { Graph } from './graph/Graph.js';
import { type FocusRegion, useAppKeys } from './keys.js';
import { Inbox } from './panels/Inbox.js';
import { Overlay } from './panels/Overlay.js';
import { Timeline } from './panels/Timeline.js';
import { Tree } from './panels/Tree.js';
import { useAnimationTick } from './tick.js';

export interface PanelHeights {
  tree: number;
  graph: number;
  inbox: number;
  timeline: number;
}

export function panelHeights(totalHeight: number, timelineExpanded: boolean): PanelHeights {
  const available = Math.max(0, totalHeight - 1);
  if (timelineExpanded) return { tree: 0, graph: 0, inbox: 0, timeline: available };
  const tree = Math.floor(available * 0.3);
  const graph = Math.floor(available * 0.32);
  const inbox = Math.floor(available * 0.18);
  return { tree, graph, inbox, timeline: available - tree - graph - inbox };
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
  initialSelectedRef?: GraphObjectRef;
  inspectSelected?: boolean;
}

const REGIONS: FocusRegion[] = ['tree', 'graph', 'inbox', 'timeline'];

function sameRef(left: GraphObjectRef | undefined, right: GraphObjectRef | undefined): boolean {
  return left?.kind === right?.kind && left?.id === right?.id;
}

function refExists(graph: ObjectGraph, ref: GraphObjectRef | undefined): boolean {
  if (!ref) return false;
  if (ref.kind === 'node') return graph.nodes.some((node) => node.id === ref.id);
  if (ref.kind === 'edge') return graph.edges.some((edge) => edge.id === ref.id);
  return graph.inbox.some((item) => item.id === ref.id);
}

export function refsForRegion(graph: ObjectGraph, region: FocusRegion): GraphObjectRef[] {
  if (region === 'tree') {
    return graph.nodes.filter((node) => node.kind === 'agent').map((node) => ({ kind: 'node', id: node.id }));
  }
  if (region === 'graph') {
    return [
      ...graph.nodes.map((node) => ({ kind: 'node' as const, id: node.id })),
      ...graph.edges.map((edge) => ({ kind: 'edge' as const, id: edge.id })),
    ];
  }
  if (region === 'inbox') return graph.inbox.map((item) => ({ kind: 'inbox', id: item.id }));
  return [];
}

function regionForRef(graph: ObjectGraph, ref: GraphObjectRef | undefined): FocusRegion {
  if (ref?.kind === 'inbox') return 'inbox';
  if (ref?.kind === 'edge') return 'graph';
  if (ref?.kind === 'node' && graph.nodes.find((node) => node.id === ref.id)?.kind !== 'agent') return 'graph';
  return 'tree';
}

function initialRef(graph: ObjectGraph, requested: GraphObjectRef | undefined): GraphObjectRef | undefined {
  if (refExists(graph, requested)) return requested;
  return refsForRegion(graph, 'tree')[0] ?? refsForRegion(graph, 'graph')[0] ?? refsForRegion(graph, 'inbox')[0];
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

const ACTION_LABELS: Readonly<Record<string, string>> = {
  a: 'answer',
  r: 'reply',
  p: 'pass',
  f: 'fail',
  x: 'cancel',
};

export function formatActions(actions: ObjectAction[]): string {
  return actions
    .filter((action) => ACTION_LABELS[action.key] !== undefined)
    .map((action) => `${action.key} ${ACTION_LABELS[action.key]}`)
    .join(' · ');
}

const HELP = 'j/k move · Tab region · Enter/i inspect · a answer · r reply · p/f review · x cancel · t timeline · ←/→ replay · ? help';

export function App(props: AppProps) {
  const { width, height } = useTerminalDimensions(props.width, props.height);
  const dependencies = useDependencies();
  const graph = useMemo(() => dependencies.graphApi.buildGraph(props.state), [dependencies.graphApi, props.state]);
  const requestedRef = initialRef(graph, props.initialSelectedRef);
  const [region, setRegion] = useState<FocusRegion>(() => regionForRef(graph, requestedRef));
  const [selectedRef, setSelectedRef] = useState<GraphObjectRef | undefined>(requestedRef);
  const [timelineIndex, setTimelineIndex] = useState(Math.max(0, props.events.length - 1));
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const tick = useAnimationTick(true);
  const sizes = panelHeights(height, timelineExpanded);
  const replayAvailable = props.replayAvailable ?? props.mode === 'replay';
  const actions = selectedRef && refExists(graph, selectedRef)
    ? dependencies.graphApi.actionsFor(selectedRef, graph, props.state)
    : [];

  useEffect(() => {
    if (refExists(graph, selectedRef)) return;
    setSelectedRef(initialRef(graph, props.initialSelectedRef));
  }, [graph, props.initialSelectedRef, selectedRef]);

  const move = (delta: 1 | -1) => {
    if (region === 'timeline') {
      setTimelineIndex((current) => Math.max(0, Math.min(props.events.length - 1, current + delta)));
      return;
    }
    const refs = refsForRegion(graph, region);
    if (refs.length === 0) return;
    const current = refs.findIndex((ref) => sameRef(ref, selectedRef));
    const next = current < 0 ? 0 : Math.max(0, Math.min(refs.length - 1, current + delta));
    setSelectedRef(refs[next]);
  };
  const cycleRegion = () => {
    const next = REGIONS[(REGIONS.indexOf(region) + 1) % REGIONS.length]!;
    setRegion(next);
    const refs = refsForRegion(graph, next);
    if (refs[0]) setSelectedRef(refs[0]);
  };

  const keys = useAppKeys({
    state: props.state,
    graph,
    selectedRef,
    actions,
    region,
    url: props.url,
    focusCmd: props.focusCmd,
    replayAvailable,
    initialOverlayOpen: Boolean(props.inspectSelected && refExists(graph, props.initialSelectedRef)),
    onSelect: setSelectedRef,
    onMove: move,
    onCycleRegion: cycleRegion,
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
  const actionFooter = formatActions(actions);
  const countFooter = graph.inbox.length > 0 ? `inbox:${graph.inbox.length}` : metricFooter(props.state);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Panel title="MISSION / WORKTREES" active={region === 'tree'} height={sizes.tree}>
        <Tree state={props.state} graph={graph} height={Math.max(0, sizes.tree - 1)} selected={selectedRef} />
      </Panel>
      <Panel title="HANDOFFS" active={region === 'graph'} height={sizes.graph}>
        {keys.overlayOpen && selectedRef && refExists(graph, selectedRef)
          ? <Overlay
              objectRef={selectedRef}
              graph={graph}
              state={props.state}
              events={props.events}
              api={dependencies.graphApi}
              tab={keys.overlayTab}
              inputMode={keys.inputMode}
              inputValue={keys.inputValue}
              error={keys.error}
              height={Math.max(0, sizes.graph - 1)}
            />
          : keys.helpOpen
            ? <Text>{HELP}</Text>
            : <Graph graph={graph} width={width} height={Math.max(0, sizes.graph - 1)} tick={tick} selected={selectedRef} />}
      </Panel>
      <Panel title="INBOX" active={region === 'inbox'} height={sizes.inbox}>
        <Inbox items={graph.inbox} height={Math.max(0, sizes.inbox - 1)} selected={selectedRef} />
      </Panel>
      <Panel title="TIMELINE" active={region === 'timeline'} height={sizes.timeline}>
        <Timeline events={props.events} height={Math.max(0, sizes.timeline - 1)} selectedIndex={timelineIndex} />
      </Panel>
      <Text inverse>
        {modeFooter(props)}  {countFooter}{actionFooter ? `  ${actionFooter}` : ''}  ? help{props.dataError ? `  ERROR ${props.dataError}` : ''}
      </Text>
    </Box>
  );
}

export interface ConnectedAppProps {
  url: string;
  replayFile?: string;
  speed: number;
  focusCmd: FocusCommand;
  startInReplay?: boolean;
  initialSelectedRef?: GraphObjectRef;
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
      initialSelectedRef={props.initialSelectedRef}
      inspectSelected={props.initialSelectedRef !== undefined}
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
      initialSelectedRef={props.initialSelectedRef}
      inspectSelected={props.initialSelectedRef !== undefined}
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
