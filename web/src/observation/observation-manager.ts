import type { ConversationObservationFrame } from '../../../src/gateway/conversation-observation-contract';
import type { ConversationReadBaseline } from '../../../src/session/conversation-read-types';
import { ConversationEntityStore } from './conversation-store';

interface Observation {
  id: string;
  conversationId: string;
  release: () => void;
  tail: Promise<void>;
  queuedBytes: number;
  references: number;
  resetAttempts: number;
  lastReset: number;
  retry?: ReturnType<typeof setTimeout>;
  timeout?: ReturnType<typeof setTimeout>;
  transfer?: { id: string; count: number; hash: string; byteLength: number; parts: Map<number, string>; bytes: number };
}

/** Multiplexes explicit targets. Navigation never changes a command's destination. */
export class ObservationManager {
  private readonly observations = new Map<string, Observation>();
  private online = false;
  constructor(readonly store: ConversationEntityStore, private readonly send: (message: unknown) => boolean) {}

  follow(conversationId: string): () => void {
    const existing = this.observations.get(conversationId);
    if (existing) { existing.references++; return this.release(existing); }
    if (this.observations.size >= 8) throw new Error('observation_limit');
    const observation: Observation = { id: crypto.randomUUID(), conversationId,
      release: this.store.retain(conversationId), tail: Promise.resolve(), queuedBytes: 0, references: 1, resetAttempts: 0, lastReset: 0 };
    this.observations.set(conversationId, observation);
    if (this.online) this.observe(observation);
    return this.release(observation);
  }

  private release(observation: Observation): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const conversationId = observation.conversationId;
      if (this.observations.get(conversationId) !== observation || --observation.references > 0) return;
      this.send({ type: 'unobserve', observationId: observation.id });
      if (observation.retry) clearTimeout(observation.retry);
      if (observation.timeout) clearTimeout(observation.timeout);
      this.observations.delete(conversationId); observation.release();
    };
  }

  connection(online: boolean): void {
    this.online = online;
    if (!online) {
      for (const observation of this.observations.values()) {
        if (observation.retry) clearTimeout(observation.retry);
        if (observation.timeout) clearTimeout(observation.timeout);
        observation.id = crypto.randomUUID(); observation.transfer = undefined; observation.queuedBytes = 0;
      }
      this.store.disconnected(); return;
    }
    for (const observation of this.observations.values()) {
      if (observation.retry) clearTimeout(observation.retry);
      if (observation.timeout) clearTimeout(observation.timeout);
      observation.id = crypto.randomUUID(); observation.transfer = undefined;
      observation.queuedBytes = 0; observation.tail = Promise.resolve();
      this.observe(observation);
    }
  }

  consume(frame: ConversationObservationFrame): Promise<void> {
    const observation = this.observations.get(frame.conversationId);
    if (!observation || observation.id !== frame.observationId) return Promise.resolve();
    const bytes = new TextEncoder().encode(JSON.stringify(frame)).length;
    const connectionBytes = [...this.observations.values()].reduce((sum, value) => sum + value.queuedBytes + (value.transfer?.bytes ?? 0), 0);
    if (bytes > 64 * 1024 || observation.queuedBytes + bytes > 512 * 1024 || connectionBytes + bytes > 2 * 1024 * 1024) {
      this.reset(observation); return Promise.resolve();
    }
    const id = observation.id;
    observation.queuedBytes += bytes;
    observation.tail = observation.tail.then(async () => {
      if (observation.id !== id || this.observations.get(frame.conversationId) !== observation) return;
      if (frame.kind !== 'baseline') {
        if (frame.kind === 'reset') { observation.transfer = undefined; this.expectBaseline(observation); return; }
        if (frame.kind === 'closed' && frame.reason !== 'authorization_revoked') { this.reset(observation); return; }
        if (this.store.apply(frame) === 'reset') this.reset(observation);
        if (frame.kind === 'closed') {
          if (observation.timeout) clearTimeout(observation.timeout);
          if (observation.retry) clearTimeout(observation.retry);
          this.observations.delete(frame.conversationId); observation.release();
        }
        return;
      }
      if (!Number.isSafeInteger(frame.count) || frame.count < 1 || frame.count > 8
        || !Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index >= frame.count
        || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 0 || frame.byteLength > 256 * 1024
        || typeof frame.data !== 'string' || !/^[a-f0-9]{64}$/.test(frame.hash)) throw new Error('invalid_baseline_frame');
      if (!observation.transfer || observation.transfer.id !== frame.transferId) {
        this.expectBaseline(observation);
        observation.transfer = { id: frame.transferId, count: frame.count, hash: frame.hash,
          byteLength: frame.byteLength, parts: new Map(), bytes: 0 };
      }
      const transfer = observation.transfer;
      if (transfer.count !== frame.count || transfer.hash !== frame.hash || transfer.byteLength !== frame.byteLength) throw new Error('baseline_frame_mismatch');
      const previous = transfer.parts.get(frame.index);
      if (previous !== undefined && previous !== frame.data) throw new Error('baseline_duplicate_mismatch');
      if (previous === undefined) { transfer.parts.set(frame.index, frame.data); transfer.bytes += frame.data.length; }
      if (transfer.bytes > 350 * 1024) throw new Error('baseline_transfer_budget');
      if (transfer.parts.size !== transfer.count) return;
      const encoded = Array.from({ length: transfer.count }, (_, index) => transfer.parts.get(index)!).join('');
      const body = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
      if (body.byteLength !== transfer.byteLength) throw new Error('baseline_length_mismatch');
      const digest = await crypto.subtle.digest('SHA-256', body);
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== transfer.hash) throw new Error('baseline_hash_mismatch');
      if (observation.id !== id || this.observations.get(frame.conversationId) !== observation) return;
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as ConversationReadBaseline;
      if (!Array.isArray(value.turns) || value.turns.length > 50
        || (value.head !== null && (!value.head || typeof value.head.epoch !== 'string' || !Number.isSafeInteger(value.head.revision)))
        || value.turns.some(turn => !turn || turn.conversationId !== frame.conversationId || typeof turn.id !== 'string'
          || typeof turn.answer !== 'string' || typeof turn.userInput !== 'string' || !Number.isSafeInteger(turn.revision)
          || new TextEncoder().encode(JSON.stringify(turn)).length > 16 * 1024)) throw new Error('baseline_scope_mismatch');
      if (observation.timeout) clearTimeout(observation.timeout);
      this.store.baseline(frame.conversationId, value); observation.transfer = undefined;
    }).catch(() => {
      if (observation.id === id) this.reset(observation);
    }).finally(() => {
      if (observation.id === id) observation.queuedBytes -= bytes;
    });
    return observation.tail;
  }

  close(): void {
    for (const observation of this.observations.values()) {
      this.send({ type: 'unobserve', observationId: observation.id }); observation.release();
      if (observation.retry) clearTimeout(observation.retry);
      if (observation.timeout) clearTimeout(observation.timeout);
    }
    this.observations.clear(); this.online = false; this.store.purge();
  }

  latest(conversationId: string): void {
    const observation = this.observations.get(conversationId);
    if (observation) this.reset(observation, true);
  }

  private observe(observation: Observation, reset = false): void {
    const cursor = reset ? null : this.store.window(observation.conversationId).cursor;
    this.send({ type: 'observe', observationId: observation.id, conversationId: observation.conversationId,
      ...(cursor ? { cursor } : {}) });
    if (!cursor) this.expectBaseline(observation);
  }
  private expectBaseline(observation: Observation): void {
    if (observation.timeout) clearTimeout(observation.timeout);
    observation.timeout = setTimeout(() => {
      if (this.observations.get(observation.conversationId) === observation) this.reset(observation);
    }, 10_000);
  }
  private reset(observation: Observation, immediate = false): void {
    if (observation.retry) clearTimeout(observation.retry);
    if (observation.timeout) clearTimeout(observation.timeout);
    this.send({ type: 'unobserve', observationId: observation.id });
    observation.id = crypto.randomUUID(); observation.transfer = undefined;
    observation.queuedBytes = 0;
    if (Date.now() - observation.lastReset > 60_000) observation.resetAttempts = 0;
    observation.lastReset = Date.now();
    const delay = immediate ? 0 : Math.min(30_000, 250 * 2 ** Math.min(observation.resetAttempts++, 7));
    observation.retry = setTimeout(() => {
      observation.retry = undefined;
      if (this.online && this.observations.get(observation.conversationId) === observation) this.observe(observation, true);
    }, delay);
  }
}
