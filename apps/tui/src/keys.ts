import type { Graph, GraphObjectRef, ObjectAction, State } from '@relay/protocol';
import { useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';

import {
  postCancel,
  postClarification,
  postMissionClarification,
  postReply,
  postReview,
  type FocusCommand,
} from './commands.js';
import { useDependencies } from './context.js';

export type FocusRegion = 'tree' | 'graph' | 'inbox' | 'timeline';
export type OverlayTab = 'Story' | 'Contract' | 'Response' | 'Questions' | 'Evidence' | 'History';
export type InputMode = 'answer' | 'reply' | 'review-failure' | 'cancel-confirm';

export interface AppKeyOptions {
  state: State;
  graph: Graph;
  selectedRef?: GraphObjectRef;
  actions: ObjectAction[];
  region: FocusRegion;
  url: string;
  focusCmd: FocusCommand;
  replayAvailable: boolean;
  initialOverlayOpen?: boolean;
  onSelect?: (ref: GraphObjectRef) => void;
  onMove?: (delta: 1 | -1) => void;
  onCycleRegion?: () => void;
  onToggleTimeline?: () => void;
  onToggleReplay?: () => void;
  onReplayStep?: (delta: 1 | -1) => void;
  onTogglePlaying?: () => void;
  onHalveSpeed?: () => void;
  onDoubleSpeed?: () => void;
}

export interface AppKeyState {
  overlayOpen: boolean;
  overlayTab: OverlayTab;
  inputMode?: InputMode;
  inputValue: string;
  helpOpen: boolean;
  error?: string;
  closeOverlay: () => void;
}

export function useAppKeys(options: AppKeyOptions): AppKeyState {
  const dependencies = useDependencies();
  const [overlayOpen, setOverlayOpen] = useState(Boolean(options.initialOverlayOpen));
  const [overlayTab, setOverlayTab] = useState<OverlayTab>('Story');
  const [inputMode, setInputMode] = useState<InputMode>();
  const [inputValue, setInputValue] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef('');
  const actionRef = useRef<ObjectAction | undefined>(undefined);

  useEffect(() => {
    if (!options.initialOverlayOpen) return;
    setOverlayTab('Story');
    setOverlayOpen(true);
  }, [options.initialOverlayOpen]);

  const resetInput = () => {
    inputRef.current = '';
    actionRef.current = undefined;
    setInputValue('');
    setInputMode(undefined);
  };
  const beginInput = (action: ObjectAction, mode: InputMode, tab: OverlayTab) => {
    inputRef.current = '';
    actionRef.current = action;
    setInputValue('');
    setInputMode(mode);
    setOverlayTab(tab);
    setOverlayOpen(true);
  };
  const perform = (operation: Promise<void>) => {
    setError(undefined);
    void operation.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const openStory = (ref = options.selectedRef) => {
    if (!ref) return;
    setOverlayTab('Story');
    setOverlayOpen(true);
  };

  useInput((input, key) => {
    if (inputMode === 'cancel-confirm') {
      const action = actionRef.current;
      if (input.toLowerCase() === 'y' && action?.kind === 'cancel' && action.target.task_id) {
        perform(postCancel({ fetch: dependencies.fetch, url: options.url, taskId: action.target.task_id }));
      }
      if (input.toLowerCase() === 'y' || input.toLowerCase() === 'n' || key.escape) resetInput();
      return;
    }

    if (inputMode === 'answer' || inputMode === 'reply' || inputMode === 'review-failure') {
      if (key.escape) {
        resetInput();
        return;
      }
      if (key.return) {
        const value = inputRef.current.trim();
        const action = actionRef.current;
        if (value === '' || !action) return;
        const questionId = action.target.question_ids?.[0];
        if (action.kind === 'clarify' && action.target.task_id && questionId) {
          perform(postClarification({
            fetch: dependencies.fetch,
            url: options.url,
            taskId: action.target.task_id,
            questionId,
            answer: value,
          }));
        } else if (action.kind === 'mission_clarify' && action.target.mission_id && questionId) {
          perform(postMissionClarification({
            fetch: dependencies.fetch,
            url: options.url,
            missionId: action.target.mission_id,
            questionId,
            answer: value,
          }));
        } else if (action.kind === 'reply' && action.target.task_id) {
          perform(postReply({
            fetch: dependencies.fetch,
            url: options.url,
            taskId: action.target.task_id,
            message: value,
          }));
        } else if (action.kind === 'review' && action.target.task_id && action.target.criterion_id) {
          perform(postReview({
            fetch: dependencies.fetch,
            url: options.url,
            taskId: action.target.task_id,
            criterionId: action.target.criterion_id,
            status: 'failed',
            observedFailure: value,
          }));
        }
        resetInput();
        return;
      }
      if (key.backspace || key.delete) inputRef.current = [...inputRef.current].slice(0, -1).join('');
      else if (input !== '') inputRef.current += input;
      setInputValue(inputRef.current);
      return;
    }

    if (key.escape && overlayOpen) {
      setOverlayOpen(false);
      return;
    }

    const action = options.actions.find((candidate) => candidate.key === input);
    if (action?.kind === 'clarify' || action?.kind === 'mission_clarify') {
      beginInput(action, 'answer', 'Questions');
      return;
    }
    if (action?.kind === 'reply') {
      beginInput(action, 'reply', 'Story');
      return;
    }
    if (action?.kind === 'review' && input === 'f') {
      beginInput(action, 'review-failure', 'Evidence');
      return;
    }
    if (action?.kind === 'review' && input === 'p' && action.target.task_id && action.target.criterion_id) {
      perform(postReview({
        fetch: dependencies.fetch,
        url: options.url,
        taskId: action.target.task_id,
        criterionId: action.target.criterion_id,
        status: 'passed',
      }));
      return;
    }
    if (action?.kind === 'cancel' && input === 'x') {
      beginInput(action, 'cancel-confirm', 'Contract');
      return;
    }
    if (key.return || input === 'i') {
      if (!options.selectedRef) return;
      if (options.selectedRef.kind === 'inbox') {
        const item = options.graph.inbox.find((candidate) => candidate.id === options.selectedRef!.id);
        if (item) options.onSelect?.(item.ref);
        openStory(item?.ref);
      } else {
        openStory();
      }
      return;
    }
    if (key.tab) {
      options.onCycleRegion?.();
      return;
    }
    if (input === 'j' || key.downArrow) options.onMove?.(1);
    else if (input === 'k' || key.upArrow) options.onMove?.(-1);
    else if (input === 't') options.onToggleTimeline?.();
    else if (input === 'r' && !options.selectedRef && options.replayAvailable) options.onToggleReplay?.();
    else if (key.leftArrow && options.replayAvailable) options.onReplayStep?.(-1);
    else if (key.rightArrow && options.replayAvailable) options.onReplayStep?.(1);
    else if (input === ' ' && options.replayAvailable) options.onTogglePlaying?.();
    else if (input === '[' && options.replayAvailable) options.onHalveSpeed?.();
    else if (input === ']' && options.replayAvailable) options.onDoubleSpeed?.();
    else if (input === '?') setHelpOpen((current) => !current);
    else if (overlayOpen && ['1', '2', '3', '4', '5', '6'].includes(input)) {
      const tabs: OverlayTab[] = ['Story', 'Contract', 'Response', 'Questions', 'Evidence', 'History'];
      setOverlayTab(tabs[Number(input) - 1]!);
    }
  });

  return {
    overlayOpen,
    overlayTab,
    inputMode,
    inputValue,
    helpOpen,
    error,
    closeOverlay: () => setOverlayOpen(false),
  };
}
