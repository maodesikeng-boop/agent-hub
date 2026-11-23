# External capabilities for the Router, PMs, and Workers

> Snapshot: 2026-11-20 (commit `6b74d9e2`)

Every agent session keeps its built-in hands: file reads and writes, the terminal, and the `hub` CLI. `--readonly` and the OS sandbox govern those, and nothing in this document widens them. The capability model covers only the external extras that cost context on every turn: skills, MCP servers, and vendor account connectors.

One model serves every scope. Project defaults and the Router own a stored policy. Each project (PM) inherits Project defaults and stores only its own choices on top. A Worker owns no policy of its own; it picks one of three modes that narrow its project's effective policy.

## Inventory, keys, and policy

`src/daemon/pm-capabilities/inventory.ts` scans every vendor's global and project-level config into a `CapabilityInventory`. Each item has a stable key:

- `skill:<name>`
- `mcp:<name>`
- `connector:<vendor>:<id>`

A `CapabilityPolicy` (`src/shared/pm-capabilities.ts`) has a per-kind `base` (`all` or `none`) and per-key `overrides`. `capabilityEnabled` reads an override first and falls back to the base of the key's kind. `applyCapabilitiesPatch` drops overrides that equal the base, so a stored policy never carries redundant rows.

`resolveSessionCapabilities(policy, inventory, vendor)` turns a policy into the `SessionCapabilities` deny and allow lists for one vendor. It returns `null` only when everything is on, so an all-open project launches with exactly the arguments it had before capabilities existed.

## Scopes and defaults

| Scope | Default | Storage |
| --- | --- | --- |
| Project defaults | every kind `all` | `default_capability_policies`, `default_capability_overrides` |
| Router | every kind `none` | `router_capability_policies`, `router_capability_overrides` |
| PM (project) | inherit Project defaults | `pm_capability_policies`, `pm_capability_overrides` (the project's own choices) |
| Worker | `inherit` | `worker_capabilities` (row only when not `inherit`) |
| Task Graph step | `inherit` | `task_graph_step_capabilities` (row only when not `inherit`) |

`defaultCapabilityPolicy(scope)` holds the built-in policies. Project defaults and Router tables store only what differs from them, so a fresh install has no rows and needs no backfill. The Router keeps its own policy and starts with nothing because a dispatch turn reads the fleet digest and calls `hub dispatch`; extra tools only slow it down and spend tokens.

Project defaults and the Router read the global inventory (`projectDir: null`). A project and its Workers read the inventory of the project's main folder, which adds the skills in its `.agents/skills`.

## Two-layer inheritance

A project's own choices are a `CapabilityLayer`: pinned per-kind bases and pinned per-key values. `layerCapabilityPolicy(defaults, layer)` builds the effective policy:

- A pinned key wins over everything.
- A pinned kind base replaces the defaults for that kind, including the defaults' per-key values of that kind.
- Anything else follows Project defaults, so a change there reaches every project that has not pinned the item.

`applyCapabilityLayerPatch` pins a key only when the new value differs from what the project would inherit, and drops the pin when the user flips it back, so the item follows Project defaults again. A pin survives later changes to Project defaults. **Reset** (`DELETE /api/pms/:id/capabilities`) clears the whole layer.

The PM tables keep their old shape. A missing PM base row now means "inherit" instead of "all", and Project defaults start with every kind `all`, so every project keeps the exact policy it had before Project defaults existed. Legacy base rows load as pinned kinds.

New projects start with an empty layer. `CreatePmRequest.capabilities` accepts `{ from: "default" }` (inherit, no rows) or `{ from: "pm", pmId }`, which copies that project's own choices.

`getPmCapabilityPolicy(pmId)` returns the effective policy. PM launches, Worker `inherit`, and the `custom` intersection in `hub worker start` all read it, so the sandboxed session gets exactly what the project page shows.

## Worker modes

`WorkerCapabilities` is one of:

- `{ mode: "inherit" }`: use the project's effective policy unchanged.
- `{ mode: "none" }`: no skills, no MCP servers, no connectors.
- `{ mode: "custom", allow: [keys] }`: only the named keys, and only those the project's effective policy also enables.

`workerCapabilityPolicy(project, worker)` builds the effective policy at launch. `custom` never crosses the project boundary: a key the project turned off (itself or through Project defaults) stays off, and `hub worker start` names the blocked keys in its receipt so the PM can ask the user to enable them on the project's `Capabilities` page. The intersection runs at every launch, so a later change to the project's choices or to Project defaults narrows running Workers on their next restart.

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

Each vendor declares `capabilities.isolation` in its `spec.ts` to record what a toggle really controls for its sessions.

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
| `GET /api/defaults/capabilities[?refresh=1]` | none | `CapabilitiesView` with `scope: { kind: "default" }` |
| `PATCH /api/defaults/capabilities` | `CapabilitiesPatch` | `CapabilitiesView` |
| `GET /api/router/capabilities[?refresh=1]` | none | `CapabilitiesView` with `scope: { kind: "router" }` |
| `PATCH /api/router/capabilities` | `CapabilitiesPatch` | `CapabilitiesView` |
| `GET /api/pms/:id/capabilities[?refresh=1]` | none | `CapabilitiesView` with `scope: { kind: "pm", pmId }` |
| `PATCH /api/pms/:id/capabilities` | `CapabilitiesPatch` | `CapabilitiesView` |
| `DELETE /api/pms/:id/capabilities` | none | `CapabilitiesView` after Reset |
| `GET /api/capabilities/customized` | none | `{ pmIds }`: projects with their own choices |
| `PUT /api/projects/:id/setup-command` | `{ command: string \| null }` | `{ project }` |

`CapabilitiesPatch` is `{ set: { [key]: boolean | null } }` with at most `PM_CAPABILITY_PATCH_MAX_KEYS` keys; `null` drops the key's own value. `?refresh=1` invalidates the inventory cache before the scan. `CapabilitiesView` carries the inventory, the effective `policy`, and `inheritance`: `{ defaults, layer }` for a project and `null` for Project defaults and the Router.

## Where the user manages it

The project is the unit of management. A project's profile opens its own page at `#/pm/<id>/capabilities`; **Settings → Capabilities** switches between Project defaults, the Router, and any one project. Both group items by who can load them rather than by protocol:

- `This project`: skills from the project's main folder.
- `Shared`: items that two or more providers load, such as `~/.agents/skills` and synced global MCP servers.
- One section per provider for items only it loads: its plugins (MCP servers and skills of one plugin share one row), built-in skills, and account connectors (`Apps`).

The [UI standard](ui-standard.md#23-capabilities-and-worktree-setup) specifies the layout.

## Project setup command

`Project.setupCommand` is the shell command that runs in each new Worker worktree before the Worker starts. The PM sets it with `hub project setup`, and the user edits it in the profile page's `Worktree setup` group, which calls `PUT /api/projects/:id/setup-command`. Both paths share one validator: the command must be non-blank, contain no NUL byte, and fit in `MAX_SETUP_COMMAND_BYTES`. `null` clears it. Every change emits a `project.updated` change, so open workbench tabs refresh. Workers that already have a worktree are not affected.
