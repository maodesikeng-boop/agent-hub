// 多厂商驱动分发器：按会话行（store.get(sessionId)?.vendor）将调用转发给对应厂商的 Driver。
import {
  DriverError,
  DriverSessionError,
  type AgentVendor,
  type ComposerCommand,
  type Driver,
  type DriverEventListener,
  type DriverSendInput,
  type DriverSendResult,
  type SessionId,
  type SessionStore,
  type Unsubscribe,
} from "../../shared/index.ts";

export { DriverSessionError } from "../../shared/index.ts";

export interface MultiVendorDriverOptions {
  store: SessionStore;
  drivers: Partial<Record<AgentVendor, Driver>>;
}

export function createMultiVendorDriver(options: MultiVendorDriverOptions): Driver {
  const { store, drivers } = options;
  const registeredDrivers = (): Driver[] => [...new Set(Object.values(drivers).filter((d): d is Driver => d !== undefined))];

  const requireDriverForSession = (sessionId: SessionId): Driver => {
    const row = store.get(sessionId);
    if (!row) throw new DriverSessionError("session_not_found", sessionId);
    const driver = drivers[row.vendor as AgentVendor];
    if (!driver) throw new DriverError("spawn_failed", `vendor driver not configured for "${row.vendor}" (session ${sessionId})`);
    return driver;
  };

  return {
    async start(sessionId: SessionId): Promise<void> {
      const driver = requireDriverForSession(sessionId);
      return driver.start(sessionId);
    },

    async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
      const driver = requireDriverForSession(sessionId);
      return driver.send(sessionId, input);
    },

    async interrupt(sessionId: SessionId): Promise<void> {
      const row = store.get(sessionId);
      if (row) {
        const driver = drivers[row.vendor as AgentVendor];
        if (driver) await driver.interrupt(sessionId);
        return;
      }
      await Promise.all(registeredDrivers().map((d) => d.interrupt(sessionId).catch(() => {})));
    },

    async end(sessionId: SessionId): Promise<void> {
      const row = store.get(sessionId);
      if (row) {
        const driver = drivers[row.vendor as AgentVendor];
        if (driver) {
          await driver.end(sessionId);
          return;
        }
        store.update(sessionId, { status: "ended", pid: null });
        return;
      }
      await Promise.all(registeredDrivers().map((d) => d.end(sessionId).catch(() => {})));
    },

    isRunning(sessionId: SessionId): boolean {
      const row = store.get(sessionId);
      if (row) {
        const driver = drivers[row.vendor as AgentVendor];
        return driver?.isRunning?.(sessionId) ?? false;
      }
      return registeredDrivers().some((d) => d.isRunning?.(sessionId) === true);
    },

    async queryCommands(sessionId: SessionId): Promise<ComposerCommand[] | null> {
      const row = store.get(sessionId);
      if (!row) return null;
      const driver = drivers[row.vendor as AgentVendor];
      if (!driver) return null;
      return driver.queryCommands(sessionId);
    },

    async cleanupStale(): Promise<void> {
      for (const driver of registeredDrivers()) {
        await driver.cleanupStale();
      }
    },

    async shutdown(): Promise<void> {
      await Promise.all(registeredDrivers().map((d) => d.shutdown()));
    },

    onEvent(listener: DriverEventListener): Unsubscribe {
      const unsubs = registeredDrivers().map((d) => d.onEvent(listener));
      return () => {
        for (const off of unsubs) off();
      };
    },
  };
}
