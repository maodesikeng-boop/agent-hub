import * as RadioGroup from "@radix-ui/react-radio-group";
import { useState } from "react";
import type { PmId } from "../../shared/index.ts";
import type { CapabilityProjectOption } from "../capabilities-model.ts";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { ChevronDown } from "../ui/icons.ts";
import { Avatar } from "./Avatar.tsx";
import { CustomBadge } from "./CapabilitiesPanel.tsx";
import { RadioMark } from "./ChoiceRows.tsx";

export type CapabilityScopeChoice = "default" | "router" | "pm";

const CHOICES: readonly { value: CapabilityScopeChoice; label: string }[] = [
  { value: "default", label: "Project defaults" },
  { value: "router", label: "Router" },
  { value: "pm", label: "Project" },
];

function ProjectPicker({
  projects,
  value,
  customized,
  onChange,
}: {
  projects: readonly CapabilityProjectOption[];
  value: CapabilityProjectOption;
  customized: readonly PmId[] | undefined;
  onChange: (pmId: PmId) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Project: ${value.label}`}
        title={value.label}
        className="touch-target flex h-9 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-full border border-border bg-background pr-3 pl-2 text-minor font-medium transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-active"
      >
        <Avatar look={value.look} size={20} />
        <span className="min-w-0 truncate">{value.label}</span>
        <ChevronDown className="size-pixel-sm shrink-0 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent aria-label="Projects" align="start" className="p-1.5">
        <RadioGroup.Root
          aria-label="Project"
          value={String(value.pmId)}
          onValueChange={(v) => {
            onChange(Number(v));
            setOpen(false);
          }}
          className="grid grid-cols-1 gap-0.5"
        >
          {projects.map((project) => (
            <RadioGroup.Item
              key={project.pmId}
              value={String(project.pmId)}
              title={project.label}
              className="flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
            >
              <Avatar look={project.look} size={20} />
              <span className="min-w-0 flex-1 truncate text-body">{project.label}</span>
              {customized?.includes(project.pmId) === true && <CustomBadge />}
              <RadioMark checked={project.pmId === value.pmId} />
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </PopoverContent>
    </Popover>
  );
}

export function CapabilityScopeSwitch({
  choice,
  project,
  projects,
  customized,
  onChoice,
  onProject,
}: {
  choice: CapabilityScopeChoice;
  project: CapabilityProjectOption | null;
  projects: readonly CapabilityProjectOption[];
  customized: readonly PmId[] | undefined;
  onChoice: (choice: CapabilityScopeChoice) => void;
  onProject: (pmId: PmId) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Segmented label="Scope" value={choice} options={project === null ? CHOICES.slice(0, 2) : CHOICES} onChange={onChoice} />
      {choice === "pm" && project !== null && <ProjectPicker projects={projects} value={project} customized={customized} onChange={onProject} />}
    </div>
  );
}
