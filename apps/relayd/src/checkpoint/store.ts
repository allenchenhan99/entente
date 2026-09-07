/** Single-daemon synchronous transactions: facts and pending proposals commit in one atomic file. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CheckpointFact, CheckpointEntry, CheckpointPacket, CheckpointSelection } from '@relay/protocol';

export const sourceHash = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');
const Facts = z.array(CheckpointFact).max(512);
const Proposal = z.object({
  id: z.string(), author: z.string(), base_revision: z.number().int().nonnegative(),
  upsert: Facts, remove: z.array(z.string()).max(512),
  assignment_id: z.string().optional(),
});
const Ledger = z.object({
  owner: z.string(), revision: z.number().int().nonnegative(), entries: z.array(CheckpointEntry).max(512),
  proposals: z.array(Proposal).max(512),
  history_head: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
type Ledger = z.infer<typeof Ledger>;
const History = z.object({
  previous: z.string().optional(), operation: z.string(), actor: z.string(), at: z.string(),
  proposal_id: z.string().optional(), state: Ledger,
});

export class CheckpointStore {
  constructor(private readonly dir: string) {}

  /** Local service cost, not model tokens or whole-workflow elapsed time. Includes failed calls. */
  measure<T>(operation: string, owner: string, actor: string, input: unknown, fn: () => T): T {
    const started = performance.now();
    const at = new Date().toISOString();
    const inputJson = JSON.stringify(input) ?? 'null';
    let outputJson = 'null';
    let status = 'error';
    try {
      const result = fn();
      outputJson = JSON.stringify(result) ?? 'null';
      this.write(this.file('responses', sourceHash(outputJson)), result ?? null);
      status = 'ok';
      return result;
    } finally {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, 'operations.jsonl'), JSON.stringify({
        id: randomUUID(), at, operation, owner, actor, status,
        duration_ms: performance.now() - started,
        input_bytes: Buffer.byteLength(inputJson), output_bytes: Buffer.byteLength(outputJson),
        input_sha256: sourceHash(inputJson), output_sha256: sourceHash(outputJson),
      }) + '\n', { mode: 0o600 });
    }
  }

  private publish(value: Ledger, operation: string, actor: string, proposal_id?: string): void {
    const record = History.parse({ previous: value.history_head, operation, actor, at: new Date().toISOString(), proposal_id, state: value });
    const digest = sourceHash(JSON.stringify(record));
    // Publish immutable bytes first. A crash before the owner pointer update leaves only an orphan.
    this.write(this.file('history', digest), record);
    value.history_head = digest;
    this.write(this.file('owners', value.owner), value);
  }

  history(owner: string): z.infer<typeof History>[] {
    const out: z.infer<typeof History>[] = [];
    const seen = new Set<string>();
    let cursor = this.read(owner).history_head;
    while (cursor) {
      if (seen.has(cursor)) throw new Error('checkpoint history cycle');
      seen.add(cursor);
      const bytes = fs.readFileSync(this.file('history', cursor), 'utf8');
      if (sourceHash(bytes) !== cursor) throw new Error('checkpoint history digest mismatch');
      const record = History.parse(JSON.parse(bytes));
      if (record.state.owner !== owner) throw new Error('checkpoint history owner mismatch');
      out.push(record);
      cursor = record.previous;
    }
    return out.reverse();
  }

  private file(kind: string, key: string): string {
    return path.join(this.dir, kind, `${sourceHash(key)}.json`);
  }

  private write(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  read(owner: string): Ledger {
    if (!owner || owner.length > 256) throw new Error('invalid checkpoint owner');
    const file = this.file('owners', owner);
    if (!fs.existsSync(file)) return { owner, revision: 0, entries: [], proposals: [] };
    const value = Ledger.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (value.owner !== owner) throw new Error('checkpoint owner mismatch');
    return value;
  }

  private revise(ledger: Ledger, expected: number, upsert: CheckpointFact[], remove: string[], author: string): Ledger {
    if (ledger.revision !== expected) throw new Error(`checkpoint revision conflict: expected ${expected}, current ${ledger.revision}`);
    const parsed = Facts.parse(upsert);
    if (new Set(parsed.map(e => e.id)).size !== parsed.length) throw new Error('duplicate checkpoint fact id');
    if (remove.length > 512 || parsed.some(e => remove.includes(e.id))) throw new Error('ambiguous checkpoint removal');
    const entries = new Map(ledger.entries.map(e => [e.id, e]));
    for (const id of remove) entries.delete(id);
    for (const fact of parsed) entries.set(fact.id, { ...fact, revision: expected + 1, author });
    return Ledger.parse({ ...ledger, revision: expected + 1, entries: [...entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
  }

  update(owner: string, expected: number, upsert: CheckpointFact[], remove: string[], author: string): Ledger {
    const value = this.revise(this.read(owner), expected, upsert, remove, author);
    this.publish(value, 'update', author);
    return structuredClone(value);
  }

  private sourceStatus(entry: CheckpointFact, repo: string): CheckpointPacket['entries'][number]['source_status'] {
    if (!entry.sources.length) return 'unverified';
    let stale = false;
    for (const source of entry.sources) {
      try {
        const root = fs.realpathSync(repo);
        const file = fs.realpathSync(path.join(root, source.path));
        if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) return 'missing';
        if (sourceHash(fs.readFileSync(file)) !== source.sha256) stale = true;
      } catch { return 'missing'; }
    }
    return stale ? 'stale' : 'current';
  }

  validate(packet: CheckpointPacket, repo: string): Record<string, CheckpointPacket['entries'][number]['source_status']> {
    return Object.fromEntries(packet.entries.map(entry => [entry.id, this.sourceStatus(entry, repo)]));
  }

  select(owner: string, input: CheckpointSelection, repo: string): CheckpointPacket {
    const query = CheckpointSelection.parse(input);
    const ledger = this.read(owner);
    const selected = ledger.entries.filter(e => query.ids.includes(e.id) || e.tags.some(t => query.tags.includes(t)));
    const packet: CheckpointPacket = {
      owner, revision: ledger.revision, entries: [], omitted_count: selected.length,
      missing_ids: [...new Set(query.ids.filter(id => !ledger.entries.some(e => e.id === id)))].sort(),
    };
    if (Buffer.byteLength(JSON.stringify(packet)) > query.max_bytes) throw new Error('selection metadata exceeds byte budget');
    for (const entry of selected) {
      const candidate = { ...packet, entries: [...packet.entries, { ...entry, source_status: this.sourceStatus(entry, repo) }], omitted_count: packet.omitted_count - 1 };
      if (Buffer.byteLength(JSON.stringify(candidate)) <= query.max_bytes) Object.assign(packet, candidate);
    }
    return packet;
  }

  bind(task: string, version: number, packet: CheckpointPacket): void {
    const file = this.file('packets', `${task}:${version}`);
    if (fs.existsSync(file)) throw new Error('checkpoint packet already bound');
    this.write(file, CheckpointPacket.parse(packet));
  }

  packet(task: string, version: number): CheckpointPacket | undefined {
    const file = this.file('packets', `${task}:${version}`);
    return fs.existsSync(file) ? CheckpointPacket.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : undefined;
  }

  propose(owner: string, author: string, base_revision: number, upsert: CheckpointFact[], remove: string[], assignment_id?: string): z.infer<typeof Proposal> {
    const ledger = this.read(owner);
    if (base_revision !== ledger.revision) throw new Error('checkpoint proposal base revision conflict');
    const proposal = Proposal.parse({ id: randomUUID(), author, base_revision, upsert, remove, assignment_id });
    // Apply validation without accepting the proposed facts.
    this.revise(ledger, base_revision, upsert, remove, author);
    this.publish(Ledger.parse({ ...ledger, proposals: [...ledger.proposals, proposal] }), 'propose', author, proposal.id);
    return proposal;
  }

  pending(owner: string): z.infer<typeof Proposal>[] { return this.read(owner).proposals; }

  review(owner: string, id: string, expected: number, decision: 'accept' | 'reject', author: string): Ledger {
    const ledger = this.read(owner);
    if (ledger.revision !== expected) throw new Error('checkpoint revision conflict');
    const proposal = ledger.proposals.find(p => p.id === id);
    if (!proposal) throw new Error('checkpoint proposal not found');
    if (decision === 'accept' && proposal.base_revision !== expected) throw new Error('checkpoint proposal base changed; reject and request a fresh proposal');
    const value = decision === 'accept' ? this.revise(ledger, expected, proposal.upsert, proposal.remove, author) : ledger;
    value.proposals = value.proposals.filter(p => p.id !== id);
    this.publish(value, decision, author, proposal.id);
    return value;
  }
}
