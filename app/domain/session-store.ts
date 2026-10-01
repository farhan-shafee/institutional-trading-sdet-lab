import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';
import { OrderBook } from './order-book.js';
import type { SessionResponse } from './schemas.js';

type Session = { user: SessionResponse['user']; book: OrderBook };

/** Synthetic authentication for local testing, intentionally not production auth. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  login(username: string, password: string): SessionResponse {
    if ((username !== 'qa.user' && username !== 'qa.viewer') || password !== 'Password123!') {
      throw new DomainError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    }
    const token = randomUUID();
    const user: SessionResponse['user'] = {
      username,
      role: username === 'qa.user' ? 'trader' : 'viewer',
    };
    this.sessions.set(token, { user, book: new OrderBook() });
    return { token, user: { ...user } };
  }

  authenticate(token: string | undefined): Session {
    const session = token ? this.sessions.get(token) : undefined;
    if (!session) {
      throw new DomainError(401, 'UNAUTHORIZED', 'A valid synthetic bearer token is required.');
    }
    return session;
  }

  delete(token: string): void {
    this.authenticate(token);
    this.sessions.delete(token);
  }
}
