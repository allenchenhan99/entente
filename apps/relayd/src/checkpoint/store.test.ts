import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore, sourceHash } from './store.js';

const dirs: string[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-'));
  dirs.push(root);
  return { root, store: new CheckpointStore(path.join(root, 'state')) };
}
afterEach(() => dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const fact = (id: string, text = 'A grounded finding') => ({ id, text, tags: ['network'], sources: [] });

describe('reusable checkpoint ledger', () => {
  it('retains the author, owner decision and replaced facts across restart', () => {
    const { root, store } = setup();
    store.update('task:t-main', 0, [fact('a', 'original')], [], 't-main');
    const proposal = store.propose('task:t-main', 't-child', 1, [fact('a', 'new observation')], []);
    store.review('task:t-main', proposal.id, 1, 'accept', 't-main');
    const history = new CheckpointStore(path.join(root, 'state')).history('task:t-main');
    expect(history.map(e => [e.operation, e.actor])).toEqual([['update', 't-main'], ['propose', 't-child'], ['accept', 't-main']]);
    expect(history[0]!.state.entries[0]!.text).toBe('original');
    expect(history[1]!.state.proposals[0]!.author).toBe('t-child');
    expect(history[2]!.proposal_id).toBe(proposal.id);
    expect(history[2]!.state.entries[0]!.text).toBe('new observation');
  });

  it('records successful and failed operation costs without fact content in receipts', () => {
    const { root, store } = setup();
    store.measure('update', 'task:t-main', 't-main', { text: 'private knowledge' }, () => store.update('task:t-main', 0, [fact('a', 'private knowledge')], [], 't-main'));
    expect(() => store.measure('update', 'task:t-main', 't-main', {}, () => store.update('task:t-main', 0, [], [], 't-main'))).toThrow(/revision conflict/);
    const lines = fs.readFileSync(path.join(root, 'state', 'operations.jsonl'), 'utf8');
    expect(lines).not.toContain('private knowledge');
    const receipts = lines.trim().split('\n').map(line => JSON.parse(line));
    expect(receipts.map(e => e.status)).toEqual(['ok', 'error']);
    expect(receipts[0].input_bytes).toBeGreaterThan(0);
    expect(receipts[0].output_bytes).toBeGreaterThan(0);
    expect(receipts[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(receipts[0].output_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists incremental facts and rejects stale writers without losing newer understanding', () => {
    const { root, store } = setup();
    const first = store.update('mission:m-one', 0, [fact('routing')], [], 'planner');
    expect(first.revision).toBe(1);
    store.update('mission:m-one', 1, [fact('auth')], [], 'planner');
    expect(() => store.update('mission:m-one', 1, [fact('routing', 'old replacement')], [], 'planner')).toThrow(/revision conflict/);
    const restored = new CheckpointStore(path.join(root, 'state')).read('mission:m-one');
    expect(restored.entries.map(e => e.id)).toEqual(['auth', 'routing']);
    expect(restored.revision).toBe(2);
    first.entries[0]!.text = 'caller mutation';
    expect(store.read('mission:m-one').entries.find(e => e.id === 'routing')!.text).toBe('A grounded finding');
  });

  it('selects deterministically within the complete serialized byte budget and exposes omissions', () => {
    const { root, store } = setup();
    store.update('task:t-main', 0, [fact('b', '中'.repeat(150)), fact('a', '中'.repeat(150)), { ...fact('other'), tags: ['ui'] }], [], 't-main');
    const packet = store.select('task:t-main', { tags: ['network'], max_bytes: 900 }, root);
    expect(packet.entries.map(e => e.id)).toEqual(['a']);
    expect(packet.omitted_count).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(900);
    expect(store.select('task:t-main', { tags: ['network'], max_bytes: 900 }, root)).toEqual(packet);
    expect(store.select('task:t-main', { ids: ['unknown'], max_bytes: 900 }, root).missing_ids).toEqual(['unknown']);
  });

  it('labels stale, missing and unsafe sources instead of presenting them as verified current facts', () => {
    const { root, store } = setup();
    fs.writeFileSync(path.join(root, 'module.ts'), 'version one');
    const entry = { ...fact('module'), sources: [{ path: 'module.ts', sha256: sourceHash('version one') }] };
    store.update('task:t-main', 0, [entry], [], 't-main');
    expect(store.select('task:t-main', { ids: ['module'] }, root).entries[0]!.source_status).toBe('current');
    const frozen = store.select('task:t-main', { ids: ['module'] }, root);
    fs.writeFileSync(path.join(root, 'module.ts'), 'version two');
    expect(store.validate(frozen, root)).toEqual({ module: 'stale' });
    expect(frozen.entries[0]!.source_status).toBe('current');
    expect(store.select('task:t-main', { ids: ['module'] }, root).entries[0]!.source_status).toBe('stale');
    fs.unlinkSync(path.join(root, 'module.ts'));
    expect(store.select('task:t-main', { ids: ['module'] }, root).entries[0]!.source_status).toBe('missing');
    expect(() => store.update('task:t-main', 1, [{ ...entry, sources: [{ path: '../secret', sha256: sourceHash('x') }] }], [], 't-main')).toThrow();
  });

  it('freezes assignment packets and preserves pending child deltas until explicit owner review', () => {
    const { root, store } = setup();
    store.update('task:t-main', 0, [fact('routing')], [], 't-main');
    const packet = store.select('task:t-main', { ids: ['routing'] }, root);
    store.bind('t-child', 1, packet);
    const proposal = store.propose('task:t-main', 't-child', 1, [fact('routing', 'new finding')], []);
    expect(store.read('task:t-main').entries[0]!.text).toBe('A grounded finding');
    const reopened = new CheckpointStore(path.join(root, 'state'));
    expect(reopened.pending('task:t-main')).toEqual([proposal]);
    reopened.review('task:t-main', proposal.id, 1, 'accept', 't-main');
    expect(reopened.read('task:t-main').entries[0]!.text).toBe('new finding');
    expect(reopened.packet('t-child', 1)).toEqual(packet);
    expect(reopened.pending('task:t-main')).toEqual([]);
    expect(() => reopened.bind('t-child', 1, reopened.select('task:t-main', { ids: ['routing'] }, root))).toThrow(/already bound/);
  });

  it('requires a fresh proposal after its base changes and isolates owner namespaces', () => {
    const { store } = setup();
    store.update('task:t-main', 0, [fact('a')], [], 't-main');
    const proposal = store.propose('task:t-main', 't-child', 1, [fact('a', 'stale proposal')], []);
    store.update('task:t-main', 1, [fact('b')], [], 't-main');
    expect(() => store.review('task:t-main', proposal.id, 2, 'accept', 't-main')).toThrow(/proposal base/);
    expect(() => store.review('task:t-other', proposal.id, 0, 'accept', 't-other')).toThrow(/not found/);
    store.review('task:t-main', proposal.id, 2, 'reject', 't-main');
    expect(store.pending('task:t-main')).toEqual([]);
  });
});
