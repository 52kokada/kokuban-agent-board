import { ChatError } from './contracts.js';

/** Covers asynchronous admission as well as provider work submitted by the in-process chief. */
export class MaintenanceBarrier {
  private held = false;
  private active = 0;
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.held) throw new ChatError('The board is preparing an update; retry shortly', 503);
    this.active++;
    try { return await work(); } finally { this.active--; }
  }
  hold(): () => void {
    if (this.held || this.active) throw new ChatError('Update held: conversation requests are still in flight', 503);
    this.held = true;
    return () => { this.held = false; };
  }
}
