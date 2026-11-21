import type {
  AgentVendor,
  AuthStatusResponse,
  Ledger,
  ModelCatalog,
  QuotaResponse,
  SelfReloadResponse,
  SelfReloadStatus,
  ServerInfo,
} from "../../shared/index.ts";
import type { ComposerService } from "../composer.ts";
import type { FeishuSetupService } from "../feishu/setup.ts";
import type { Mesh } from "../mesh/index.ts";
import type { RunOpen } from "../open-file.ts";
import type { PeerRoutesOptions, Peers } from "../peers/index.ts";
import type { FolderPicker } from "../pick-folder.ts";
import type { CapabilityInventoryService } from "../pm-capabilities/inventory.ts";
import type { ProviderManager } from "../provider-manager/index.ts";
import type { PresenceBoard } from "../push/presence.ts";
import type { PushSubscriptionRecord } from "../push/subscriptions.ts";
import type { ResourceInspector } from "../resources/index.ts";
import type { RouterDispatcher, RouterTargetPort } from "../router/index.ts";
import type { Db } from "../store/index.ts";
import type { UpdateChecker } from "../update-checker.ts";
import type { VendorSyncService } from "../vendor-sync/index.ts";

export interface UiServerOptions {
  ledger: Ledger;
  token: string;
  db?: Db;
  rotateToken?: () => string;
  now?: () => number;
  uploadsDir: string;
  sentFilesDir: string;
  staticDir: string;
  /** DNS rebinding protection compares the Host port; before listen (inject in tests) this value is used. */
  port?: number;
  logger?: boolean;
  models?: { list(options?: { refresh?: boolean | "unusable"; vendor?: AgentVendor }): Promise<ModelCatalog[]> };
  quota?: { get(): Promise<QuotaResponse> };
  composer?: ComposerService;
  vendorSync?: VendorSyncService;
  capabilityInventory?: CapabilityInventoryService;
  providers?: ProviderManager;
  folderPicker?: FolderPicker;
  runOpen?: RunOpen;
  serverInfo?: ServerInfo;
  push?: {
    publicKey: string;
    subscribe(subscription: PushSubscriptionRecord): void;
    unsubscribe(endpoint: string): void;
    presence: PresenceBoard;
  };
  feishu?: FeishuSetupService;
  peers?: Peers;
  mesh?: NonNullable<PeerRoutesOptions["mesh"]> & Pick<Mesh, "onChange" | "trust">;
  feishuPeer?: PeerRoutesOptions["feishuPeer"];
  peerProxy?: PeerRoutesOptions["proxy"];
  wsHeartbeatMs?: number;
  routerDispatcher?: RouterDispatcher;
  routerLocalPort?: RouterTargetPort;
  selfReload?: {
    request(input: { build: boolean; by: string }): SelfReloadResponse;
    status(): SelfReloadStatus;
  };
  update?: UpdateChecker;
  resources?: ResourceInspector;
}

export const DESKTOP_PRODUCT = "fusa" as const;
export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export interface DesktopAuthStatusResponse extends AuthStatusResponse {
  product: typeof DESKTOP_PRODUCT;
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  instanceId: string;
}

export interface DesktopHealthResponse {
  ok: true;
  product: typeof DESKTOP_PRODUCT;
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  instanceId: string;
}
