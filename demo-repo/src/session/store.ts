import { randomUUID } from 'node:crypto';

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

const cloneSession = (session: Session): Session => ({ ...session });

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  create(userId: string, ttlMs: number): Session {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('ttlMs must be a finite positive number');
    }

    const session: Session = {
      id: randomUUID(),
      userId,
      expiresAt: this.now() + ttlMs,
    };

    this.sessions.set(session.id, session);
    return cloneSession(session);
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return undefined;
    }

    if (session.expiresAt < this.now()) {
      this.sessions.delete(id);
      return undefined;
    }

    return cloneSession(session);
  }

  revoke(id: string): boolean {
    return this.sessions.delete(id);
  }
}
