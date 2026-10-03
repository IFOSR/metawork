import { describe, expect, it } from 'vitest';
import { permissionFixture as fixture } from '../helpers/permission-runtime.js';

describe('Account permission crash continuation', () => {
  it('recovers an admitted decision after restart and atomically hands resume to the execution inbox', async () => {
    const { db, store, event, createService } = fixture();
    try {
      store.admitPermissionResolution(event);
      await createService().recoverPending(true);
      expect(store.isDecisionApplied(`decision_${event.id}`)).toBe(true);
      expect(store.findEvent('permission_resume_request')).toMatchObject({
        type: 'task_resume_requested', taskId: 'task', sessionId: 'session', causationId: `decision_${event.id}`,
      });
      expect(store.listPendingTaskIds('task_resume_requested')).toEqual(['task']);
      await createService().recoverPending(true);
      expect(db.prepare('SELECT COUNT(*) AS n FROM user_authorizations').get()).toEqual({ n: 1 });
      expect(store.listPermissionWork()).toEqual([]);
    } finally { db.close(); }
  });

  it('retries the same continuation when its atomic inbox handoff fails, without duplicating authorization', async () => {
    const { db, store, event, createService } = fixture();
    try {
      store.admitPermissionResolution(event);
      db.exec(`CREATE TRIGGER interrupt_resume BEFORE INSERT ON kernel_events
        WHEN NEW.event_type = 'task_resume_requested'
        BEGIN SELECT RAISE(ABORT, 'injected_crash'); END`);
      await createService().recoverPending(true);
      expect(store.isDecisionApplied(`decision_${event.id}`)).toBe(false);
      expect(store.findEvent('permission_resume_request')).toBeNull();
      db.exec('DROP TRIGGER interrupt_resume');
      await createService().recoverPending(true);
      expect(store.isDecisionApplied(`decision_${event.id}`)).toBe(true);
      expect(store.findEvent('permission_resume_request')).not.toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS n FROM user_authorizations').get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});
