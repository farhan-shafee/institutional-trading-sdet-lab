import { DomainError } from './errors.js';

/** One fixed-size counter bounds admission without retaining caller identities. */
export class AdmissionWindow {
  private count = 0;
  private startedAt: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(
        'Admission limits must use a positive integer count and finite duration.',
      );
    }
    this.startedAt = now();
  }

  take(): void {
    const time = this.now();
    if (time - this.startedAt >= this.windowMs) {
      this.startedAt = time;
      this.count = 0;
    }
    if (this.count >= this.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((this.startedAt + this.windowMs - time) / 1_000),
      );
      throw new DomainError(
        429,
        'RATE_LIMITED',
        'The synthetic demo request limit was reached. Try again later.',
        retryAfterSeconds,
      );
    }
    this.count += 1;
  }
}
