import { z } from 'zod';

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const RelativePath = z.string().min(1).max(1024).refine(
  value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && !value.split('/').some(part => part === '..' || part === '.' || part === ''),
  'source must be a repository-relative path without traversal',
);
export const CheckpointFact = z.object({
  id: Id,
  text: z.string().min(1).max(8192),
  tags: z.array(z.string().min(1).max(128)).max(32).default([]),
  sources: z.array(z.object({ path: RelativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(32).default([]),
});
export type CheckpointFact = z.infer<typeof CheckpointFact>;
export const CheckpointEntry = CheckpointFact.extend({ author: z.string(), revision: z.number().int().positive() });
export const CheckpointSelection = z.object({
  ids: z.array(Id).max(128).default([]),
  tags: z.array(z.string().min(1).max(128)).max(32).default([]),
  max_bytes: z.number().int().min(512).max(65536).default(16384),
});
export type CheckpointSelection = z.input<typeof CheckpointSelection>;
export const CheckpointPacket = z.object({
  owner: z.string(),
  revision: z.number().int().nonnegative(),
  entries: z.array(CheckpointEntry.extend({ source_status: z.enum(['current', 'stale', 'missing', 'unverified']) })),
  missing_ids: z.array(Id),
  omitted_count: z.number().int().nonnegative(),
});
export type CheckpointPacket = z.infer<typeof CheckpointPacket>;

export const CHECKPOINT_TOOLS = { checkpoint: 'relay_checkpoint', get_context: 'relay_get_context', propose_delta: 'relay_propose_context_delta' } as const;
export const CheckpointDelta = z.object({ contract_version: z.number().int().positive(), base_revision: z.number().int().nonnegative(), upsert: z.array(CheckpointFact).max(512), remove: z.array(Id).max(512).default([]) }).strict();
export const CheckpointOperation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read') }).strict(),
  z.object({ operation: z.literal('pending') }).strict(),
  z.object({ operation: z.literal('update'), expected_revision: z.number().int().nonnegative(), upsert: z.array(CheckpointFact).max(512), remove: z.array(Id).max(512).default([]) }).strict(),
  z.object({ operation: z.literal('review'), proposal_id: z.string(), expected_revision: z.number().int().nonnegative(), decision: z.enum(['accept', 'reject']) }).strict(),
]);
export type CheckpointOperation = z.infer<typeof CheckpointOperation>;
