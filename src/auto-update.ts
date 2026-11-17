/** Automatic distribution policy. Transport and installation keep using update.ts. */
export interface AutoUpdateConfig { enabled: boolean; role: 'hub' | 'client' }
export interface Candidate { head: string; published: boolean }
export interface AutoUpdateOperations {
  discover(): Promise<Candidate | null>;
  stage(candidate: Candidate): Promise<void>;
  publish(candidate: Candidate): Promise<void>;
  preflight(candidate: Candidate): Promise<void>;
  idle(): Promise<void>;
  apply(candidate: Candidate): Promise<void>;
}
export interface AutoUpdateResult {
  state: 'disabled' | 'current' | 'held' | 'published' | 'restarting';
  head?: string;
  detail: string;
}
export async function autoUpdatePass(config: AutoUpdateConfig, ops: AutoUpdateOperations): Promise<AutoUpdateResult> {
  if (!config.enabled) return { state: 'disabled', detail: 'Automatic updates are not enabled' };
  let candidate: Candidate | null = null;
  try {
    candidate = await ops.discover();
    if (!candidate) return { state: 'current', detail: 'No new published commit' };
    if (!/^[a-f0-9]{40}$/.test(candidate.head) || !candidate.published)
      throw Error('The source did not certify a full commit matching origin/main');
    if (config.role === 'client') await ops.preflight(candidate);
    await ops.stage(candidate);
    if (config.role === 'hub') {
      await ops.publish(candidate);
      return { state: 'published', head: candidate.head, detail: 'Validated release published; keeper was not updated' };
    }
    await ops.preflight(candidate);
    await ops.idle();
    await ops.apply(candidate);
    // Readiness belongs to the successor/watchdog, not to the process requesting its own restart.
    return { state: 'restarting', head: candidate.head, detail: 'Restart requested; readiness has not been established' };
  } catch (error) {
    return { state: 'held', head: candidate?.head, detail: error instanceof Error ? error.message : String(error) };
  }
}
