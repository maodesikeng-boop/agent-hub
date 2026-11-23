// Runners for mesh flows. They reach the remote computer only through the local instance's /d/<deviceId>/ proxy.
import type { FlowContext, FlowObservation, FlowRunner } from "../types.ts";

async function coldDial(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function routerSeesOnline(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function crossDeviceChat(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

export const meshRunners: Readonly<Record<string, FlowRunner>> = {
  "mesh.cold-dial": coldDial,
  "mesh.router-sees-online": routerSeesOnline,
  "mesh.cross-device-chat": crossDeviceChat,
};
