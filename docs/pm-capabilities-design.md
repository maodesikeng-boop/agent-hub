# External capabilities for the Router, PMs, and Workers

Every agent session keeps its built-in hands: file reads and writes, the terminal, and the `hub` CLI. `--readonly` and the OS sandbox govern those, and nothing in this document widens them. The capability model covers only the external extras that cost context on every turn: skills, MCP servers, and vendor account connectors.

One model serves three scopes. The Router and each PM own a stored policy. A Worker owns no policy of its own; it picks one of three modes that narrow its PM's policy.

## Inventory, keys, and policy

`src/daemon/pm-capabilities/inventory.ts` scans every vendor's global and project-level config into a `CapabilityInventory`. Each item has a stable key:

- `skill:<name>`
- `mcp:<name>`
- `connector:<vendor>:<id>`

A `CapabilityPolicy` (`src/shared/pm-capabilities.ts`) has a per-kind `base` (`all` or `none`) and per-key `overrides`. `capabilityEnabled` reads an override first and falls back to the base of the key's kind. `applyCapabilitiesPatch` drops overrides that equal the base, so a stored policy never carries redundant rows.

`resolveSessionCapabilities(policy, inventory, vendor)` turns a policy into the `SessionCapabilities` deny and allow lists for one vendor. It returns `null` only when everything is on, so an all-open PM launches with exactly the arguments it had before capabilities existed.

## Scopes and defaults

| Scope | Default | Storage |
| --- | --- | --- |
| Router | every kind `none` | `router_capability_policies`, `router_capability_overrides` |
| PM (project) | every kind `all` | `pm_capability_policies`, `pm_capability_overrides` |
| Worker | `inherit` | `worker_capabilities` (row only when not `inherit`) |
| Task Graph step | `inherit` | `task_graph_step_capabilities` (row only when not `inherit`) |

`defaultCapabilityPolicy(scope)` holds the defaults. Policy tables store only what differs from the scope default, so a fresh install has no rows and needs no backfill. The Router starts with nothing because a dispatch turn reads the fleet digest and calls `hub dispatch`; extra tools only slow it down and spend tokens. The user can open specific items in **Settings → Capabilities**.

The Router reads the global inventory (`projectDir: null`). A PM and its Workers read the inventory of the project's main folder.

## Worker modes

`WorkerCapabilities` is one of:

- `{ mode: "inherit" }`: use the PM's policy unchanged.
- `{ mode: "none" }`: no skills, no MCP servers, no connectors.
- `{ mode: "custom", allow: [keys] }`: only the named keys, and only those the PM's policy also enables.

`workerCapabilityPolicy(project, worker)` builds the effective policy at launch. `custom` never crosses the project boundary: a key the PM turned off stays off, and `hub worker start` names the blocked keys in its receipt so the PM can ask the user to enable them. The intersection runs at every launch, so a later change to the PM's policy narrows running Workers on their next restart.

`parseWorkerCapabilitiesJson` reads a stored row. A row it cannot parse loads as `none`, never as `inherit`, so corruption cannot widen a Worker's reach.

### Set the mode

From the CLI:

```sh
hub worker start --title <title> --caps none --stdin
hub worker start --title <title> --caps custom --allow mcp:playwright --allow skill:frontend-rules --stdin
```

`--allow` requires `--caps custom`, and `custom` requires at least one `--allow`.

In a Task Graph spec, a step takes `caps` and `allow`:

```json
{ "key": "e2e", "title": "Browser check", "caps": "custom", "allow": ["mcp:playwright"] }
```

`graph patch` replaces a step's mode with `updateSteps: [{ "key": "e2e", "caps": "none" }]`, and `"caps": null` restores `inherit`. An explicit `--caps` on `hub worker start --node` overrides the step's mode for that Worker.

## Read-only stays independent

`readonly` and capabilities are separate inputs to `createLaunchPreparer` (`src/daemon/launch.ts`). A read-only Worker that mounts an MCP server still gets the same `ReadonlyPolicy`, write scope, and OS sandbox as one that mounts nothing. MCP tools that lack `readOnlyHint` remain filtered as described in [Read-only Worker design](readonly-worker-design.md).

## Vendor granularity

Each vendor declares `capabilities.isolation` in its `spec.ts`. The UI shows it next to each kind so the user knows what a toggle really controls.

| Value | Meaning |
| --- | --- |
| `session` | Launch arguments or session settings hide the item from this session only. |
| `tool_deny` | The item still loads, but its tools are denied in this session. |
| `shared` | The vendor reads one global config. A toggle cannot isolate one session. |

`pluginIsolation` overrides the value for items that come from a vendor plugin, such as Claude plugin skills, which need `Skill(<name>)` deny rules.

## Launch and restart

`prepareRouterLaunch` and `createLaunchPreparer` resolve capabilities, pass them to the vendor's `launchFiles` and `capabilityLaunch`, and include the vendor-specific result in the launch fingerprint. Changing a policy changes the fingerprint, and the driver restarts the session before its next message. A change in inventory restarts only vendors whose launch output depends on it, such as allow-list vendors.

## HTTP API

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /api/router/capabilities[?refresh=1]` | none | `CapabilitiesView` with `scope: { kind: "router" }` |
| `PATCH /api/router/capabilities` | `CapabilitiesPatch` | `CapabilitiesView` |
| `GET /api/pms/:id/capabilities[?refresh=1]` | none | `CapabilitiesView` with `scope: { kind: "pm", pmId }` |
| `PATCH /api/pms/:id/capabilities` | `CapabilitiesPatch` | `CapabilitiesView` |
| `PUT /api/projects/:id/setup-command` | `{ command: string \| null }` | `{ project }` |

`?refresh=1` invalidates the inventory cache before the scan. `CapabilitiesView` carries the inventory, the policy, and both isolation maps.

## Project setup command

`Project.setupCommand` is the shell command that runs in each new Worker worktree before the Worker starts. The PM sets it with `hub project setup`, and the user sets it through `PUT /api/projects/:id/setup-command`. Both paths share one validator: the command must be non-blank, contain no NUL byte, and fit in `MAX_SETUP_COMMAND_BYTES`. `null` clears it. Every change emits a `project.updated` change, so open workbench tabs refresh. Workers that already have a worktree are not affected.
