/**
 * What relayd knows about a pane that the terminal host does not.
 *
 * A host names a pane when it spawns it, so a pane relayd started for a task carries its role and
 * runtime from birth. A pane the human opened is a shell, and stays a shell in the host's eyes even
 * after they run `claude` inside it — the host sees one long-lived process and has no idea what it
 * became. relayd does, because the agent asked to be adopted, so it keeps that here and merges it
 * over what the host reports.
 *
 * This is a view, not state: it is derived from the adoption the event log already records, and a
 * daemon restart rebuilds it from those events rather than persisting it separately.
 */
import type { PaneInfo } from '@relay/protocol';

/** The fields relayd may override on a host's `PaneInfo`. */
export type PaneAnnotation = Partial<Pick<PaneInfo, 'role' | 'runtime' | 'task_id'>>;

export interface PaneAnnotations {
  set(paneId: string, annotation: PaneAnnotation): void;
  get(paneId: string): PaneAnnotation | undefined;
  clear(paneId: string): void;
  /** `info` with anything relayd knows about that pane laid over it. */
  apply<T extends { pane_id: string }>(info: T): T;
  /** The same, for a list. */
  applyAll<T extends { pane_id: string }>(infos: T[]): T[];
}

export function createPaneAnnotations(): PaneAnnotations {
  const byPane = new Map<string, PaneAnnotation>();
  const apply = <T extends { pane_id: string }>(info: T): T => {
    const annotation = byPane.get(info.pane_id);
    return annotation ? { ...info, ...annotation } : info;
  };
  return {
    set: (paneId, annotation) => {
      byPane.set(paneId, { ...byPane.get(paneId), ...annotation });
    },
    get: (paneId) => byPane.get(paneId),
    clear: (paneId) => {
      byPane.delete(paneId);
    },
    apply,
    applyAll: (infos) => infos.map(apply),
  };
}
