import { randomUUID } from 'node:crypto';
import { AdmissionWindow } from './admission.js';
import { DomainError } from './errors.js';
import { OrderBook } from './order-book.js';
import type { SessionResponse } from './schemas.js';

export type SessionLimits = {
  ttlMs: number;
  maxSessions: number;
  maxOrdersPerSession: number;
  mutationsPerMinute: number;
};

type Session = {
  user: SessionResponse['user'];
  book: OrderBook;
  expiresAt: number;
  mutations: AdmissionWindow | undefined;
};

/** Synthetic authentication for local testing, intentionally not production auth. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly limits: SessionLimits | undefined;
  private readonly now: () => number;

  constructor(options: { limits?: SessionLimits; now?: () => number } = {}) {
    if (options.limits) {
      const limits = options.limits;
      if (
        !Number.isFinite(limits.ttlMs) ||
        limits.ttlMs <= 0 ||
        !Number.isSafeInteger(limits.maxSessions) ||
        limits.maxSessions < 1 ||
        !Number.isSafeInteger(limits.maxOrdersPerSession) ||
        limits.maxOrdersPerSession < 5 ||
        !Number.isSafeInteger(limits.mutationsPerMinute) ||
        limits.mutationsPerMinute < 1
      ) {
        throw new RangeError(
          'Hosted session bounds must use positive finite capacities and duration.',
        );
      }
      this.limits = { ...limits };
    }
    this.now = options.now ?? (() => performance.now());
  }

  pruneExpired(): void {
    if (!this.limits) return;
    const time = this.now();
    for (const [token, session] of this.sessions) {
      if (time >= session.expiresAt) this.sessions.delete(token);
    }
  }

  login(username: string, password: string): SessionResponse {
    this.pruneExpired();
    if ((username !== 'qa.user' && username !== 'qa.viewer') || password !== 'Password123!') {
      throw new DomainError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    }
    if (this.limits && this.sessions.size >= this.limits.maxSessions) {
      throw new DomainError(
        503,
        'SESSION_CAPACITY_REACHED',
        'The synthetic demo has reached its active session capacity. Try again later.',
      );
    }
    const token = randomUUID();
    const user: SessionResponse['user'] = {
      username,
      role: username === 'qa.user' ? 'trader' : 'viewer',
    };
    this.sessions.set(token, {
      user,
      book: new OrderBook(this.limits?.maxOrdersPerSession),
      expiresAt: this.limits ? this.now() + this.limits.ttlMs : Infinity,
      mutations: this.limits
        ? new AdmissionWindow(this.limits.mutationsPerMinute, 60_000, this.now)
        : undefined,
    });
    return { token, user: { ...user } };
  }

  authenticate(token: string | undefined): Session {
    this.pruneExpired();
    const session = token ? this.sessions.get(token) : undefined;
    if (!session) {
      throw new DomainError(401, 'UNAUTHORIZED', 'A valid synthetic bearer token is required.');
    }
    return session;
  }

  admitMutation(token: string | undefined): void {
    this.authenticate(token).mutations?.take();
  }

  delete(token: string): void {
    this.authenticate(token);
    this.sessions.delete(token);
  }

  clear(): void {
    this.sessions.clear();
  }
}
