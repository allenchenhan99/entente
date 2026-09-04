import type { GraphObjectRef, InboxItem, InboxKind } from '@relay/protocol';
import { Box, Text } from 'ink';
import React from 'react';

export interface InboxProps {
  items: InboxItem[];
  height: number;
  selected?: GraphObjectRef;
}

export function inboxIcon(kind: InboxKind): string {
  switch (kind) {
    case 'task_question':
    case 'mission_question': return '?';
    case 'human_review': return '◆';
    case 'blocker': return '◐';
    case 'escalation': return '!';
    case 'lint_error': return '✗';
  }
}

export function Inbox({ items, height, selected }: InboxProps) {
  if (items.length === 0) return <Text dimColor>&lt;inbox empty&gt;</Text>;
  const maxItems = Math.max(0, Math.floor(height / 2));
  const selectedIndex = selected?.kind === 'inbox' ? items.findIndex((item) => item.id === selected.id) : -1;
  const start = selectedIndex < maxItems
    ? 0
    : Math.min(selectedIndex - maxItems + 1, Math.max(0, items.length - maxItems));
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {items.slice(start, start + maxItems).map((item) => {
        const active = selected?.kind === 'inbox' && selected.id === item.id;
        return (
          <Box key={item.id} flexDirection="column">
            <Text bold={active} inverse={active} wrap="truncate">
              {inboxIcon(item.kind)} {item.title}
            </Text>
            <Text dimColor wrap="truncate">  {item.detail.join(' · ') || '-'}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
