// Invariant: isolated Bellwood instances never share ~/.agent-hub, developer CLI configs, or default ports, and leave zero live children after stop.
import type { AppVendorMode } from "./types.ts";

export type FolderPickerMode = "bridge_sample_project" | "disabled";

export interface IsolatedAppOptions {
  readonly tempRoot: string;
  readonly appVendorMode: AppVendorMode;
  readonly folderPickerMode?: FolderPickerMode;
  readonly repoRoot?: string;
  readonly buildWeb?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
}

export interface IsolatedBellwoodHandle {
  readonly homeDir: string;
  readonly userHomeDir: string;
  readonly sampleProjectDir: string;
  readonly origin: string;
  readonly loginUrl: string;
  readonly uiToken: string;
  readonly folderBridgeActive: boolean;
  readonly pid: number;
  isRunning(): boolean;
  readStderrTail(): string;
}

/**
 * Precondition: parentDir is inside an isolated temporary directory verified by assertIsolatedWorkspace.
 * Postcondition: creates a small realistic git repository containing a starter README and task file for a new user to import.
 */
export function createSampleUserProject(_parentDir: string): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: options.tempRoot passes assertIsolatedWorkspace.
 * Postcondition: starts a real Bellwood daemon on ephemeral ports with isolated AGENT_HUB_HOME and HOME, returning its handle once healthy.
 */
export async function launchIsolatedBellwood(_options: IsolatedAppOptions): Promise<IsolatedBellwoodHandle> {
  throw new Error("Not implemented");
}

/**
 * Precondition: handle was returned by launchIsolatedBellwood.
 * Postcondition: sends graceful shutdown, awaits process exit within BLIND_DAEMON_STOP_TIMEOUT_MS, verifies zero live children in the process ledger, and removes temp files when cleanup is true.
 */
export async function stopIsolatedBellwood(_handle: IsolatedBellwoodHandle, _cleanup?: boolean): Promise<void> {
  throw new Error("Not implemented");
}

/**
 * Precondition: homeDir is an isolated AGENT_HUB_HOME whose daemon was stopped.
 * Postcondition: returns cleanly when every recorded child process has exited; otherwise throws Error listing surviving PIDs.
 */
export function assertCleanTeardown(_homeDir: string): void {
  throw new Error("Not implemented");
}
