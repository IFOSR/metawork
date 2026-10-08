import type { DesktopActivation, DesktopActivationRecord } from './desktop-activation.js';

/** Release the helper before reopening a client that checks the helper lock. */
export async function runDesktopUpdateTransaction(input: {
  activation: Pick<DesktopActivation, 'read' | 'apply' | 'recover'>;
  record: Omit<DesktopActivationRecord, 'schemaVersion' | 'phase'>;
  recoverOnly: boolean;
  candidateRunning(): boolean;
  releaseLock(): Promise<void>;
  relaunch(): void;
}): Promise<void> {
  let relaunch = false;
  try {
    const prior = await input.activation.read();
    const unfinished = prior && !['committed', 'rolled-back'].includes(prior.phase);
    if (unfinished) {
      for (const key of ['applicationPath', 'stagedApplicationPath', 'backupApplicationPath',
        'previousReleaseId', 'candidateReleaseId'] as const) {
        if (prior[key] !== input.record[key]) throw new Error('Recovery request does not match activation journal');
      }
    }
    if (input.recoverOnly || unfinished) {
      await input.activation.recover();
      relaunch = true;
    } else {
      try { await input.activation.apply(input.record); }
      catch (error) {
        relaunch = (await input.activation.read())?.phase === 'rolled-back';
        throw error;
      }
      relaunch = !input.candidateRunning();
    }
  } finally {
    await input.releaseLock();
    if (relaunch) input.relaunch();
  }
}
