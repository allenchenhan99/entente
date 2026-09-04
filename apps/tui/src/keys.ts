import type { State, TaskView } from '@relay/protocol';
import { useInput } from 'ink';
import { useRef, useState } from 'react';

import { focusPane, postCancel, postClarification, postReview, type FocusCommand } from './commands.js';
import { useDependencies } from './context.js';

export type FocusRegion = 'tree' | 'graph' | 'timeline';
export type OverlayTab = 'Contract' | 'Response' | 'Questions' | 'Evidence' | 'History';
export type InputMode = 'answer' | 'review-failure' | 'cancel-confirm';

export interface AppKeyOptions {
  state: State;
  selectedTaskId?: string;
  selectedCriterionId?: string;
  region: FocusRegion;
  url: string;
  focusCmd: FocusCommand;
  replayAvailable: boolean;
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

function humanReviewCriterion(task: TaskView | undefined, selectedCriterionId: string | undefined): string | undefined {
  if (!task) return undefined;
  const selected = task.contract.acceptance_criteria.find((criterion) => criterion.id === selectedCriterionId);
  if (selected?.check?.kind === 'human_review') return selected.id;
  return task.contract.acceptance_criteria.find((criterion) => criterion.check?.kind === 'human_review')?.id;
}

export function useAppKeys(options: AppKeyOptions): AppKeyState {
  const dependencies = useDependencies();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayTab, setOverlayTab] = useState<OverlayTab>('Contract');
  const [inputMode, setInputMode] = useState<InputMode>();
  const [inputValue, setInputValue] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef('');
  const task = options.selectedTaskId === undefined ? undefined : options.state.tasks[options.selectedTaskId];

  const resetInput = () => {
    inputRef.current = '';
    setInputValue('');
    setInputMode(undefined);
  };
  const beginInput = (mode: InputMode, tab: OverlayTab) => {
    inputRef.current = '';
    setInputValue('');
    setInputMode(mode);
    setOverlayTab(tab);
    setOverlayOpen(true);
  };
  const perform = (operation: Promise<void>) => {
    setError(undefined);
    void operation.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  useInput((input, key) => {
    if (inputMode === 'cancel-confirm') {
      if (input.toLowerCase() === 'y' && task) perform(postCancel({ fetch: dependencies.fetch, url: options.url, taskId: task.id }));
      if (input.toLowerCase() === 'y' || input.toLowerCase() === 'n' || key.escape) resetInput();
      return;
    }

    if (inputMode === 'answer' || inputMode === 'review-failure') {
      if (key.escape) {
        resetInput();
        return;
      }
      if (key.return) {
        const value = inputRef.current.trim();
        if (value === '' || !task) return;
        if (inputMode === 'answer') {
          const question = task.open_questions[0];
          if (question) perform(postClarification({
            fetch: dependencies.fetch,
            url: options.url,
            taskId: task.id,
            questionId: question.id,
            answer: value,
          }));
        } else {
          const criterionId = humanReviewCriterion(task, options.selectedCriterionId);
          if (criterionId) perform(postReview({
            fetch: dependencies.fetch,
            url: options.url,
            taskId: task.id,
            criterionId,
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
    if (input === 'a') {
      if (task?.open_questions[0]) beginInput('answer', 'Questions');
      else {
        setOverlayTab('Questions');
        setOverlayOpen(true);
      }
      return;
    }
    if (input === 'f') {
      if (humanReviewCriterion(task, options.selectedCriterionId)) beginInput('review-failure', 'Evidence');
      return;
    }
    if (input === 'p') {
      const criterionId = humanReviewCriterion(task, options.selectedCriterionId);
      if (task && criterionId) perform(postReview({
        fetch: dependencies.fetch,
        url: options.url,
        taskId: task.id,
        criterionId,
        status: 'passed',
      }));
      return;
    }
    if (input === 'x' && task) {
      beginInput('cancel-confirm', 'Contract');
      return;
    }
    if (key.return) {
      if (options.region === 'tree' && task?.agent) perform(focusPane(dependencies.execute, options.focusCmd, task.agent.pane_id));
      if (options.region === 'graph' && task) {
        setOverlayTab('Contract');
        setOverlayOpen(true);
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
    else if (input === 'r' && options.replayAvailable) options.onToggleReplay?.();
    else if (key.leftArrow && options.replayAvailable) options.onReplayStep?.(-1);
    else if (key.rightArrow && options.replayAvailable) options.onReplayStep?.(1);
    else if (input === ' ' && options.replayAvailable) options.onTogglePlaying?.();
    else if (input === '[' && options.replayAvailable) options.onHalveSpeed?.();
    else if (input === ']' && options.replayAvailable) options.onDoubleSpeed?.();
    else if (input === '?') setHelpOpen((current) => !current);
    else if (overlayOpen && ['1', '2', '3', '4', '5'].includes(input)) {
      const tabs: OverlayTab[] = ['Contract', 'Response', 'Questions', 'Evidence', 'History'];
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
