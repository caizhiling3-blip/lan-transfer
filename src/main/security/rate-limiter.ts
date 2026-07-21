import { MAX_RATE_LIMIT_IDENTITIES } from '@shared/constants'

interface RateWindow {
  count: number
  startedAt: number
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, RateWindow>()

  public constructor(
    private readonly maximumRequests: number,
    private readonly windowMs: number,
    private readonly maximumIdentities = MAX_RATE_LIMIT_IDENTITIES,
  ) {}

  public allow(identity: string, now = Date.now()): boolean {
    this.prune(now)
    const current = this.windows.get(identity)
    if (current === undefined || now - current.startedAt >= this.windowMs) {
      this.windows.set(identity, { count: 1, startedAt: now })
      this.enforceIdentityLimit()
      return true
    }
    current.count += 1
    return current.count <= this.maximumRequests
  }

  public clear(): void {
    this.windows.clear()
  }

  private prune(now: number): void {
    for (const [identity, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(identity)
    }
  }

  private enforceIdentityLimit(): void {
    while (this.windows.size > this.maximumIdentities) {
      const oldestIdentity = this.windows.keys().next().value
      if (oldestIdentity === undefined) return
      this.windows.delete(oldestIdentity)
    }
  }
}
