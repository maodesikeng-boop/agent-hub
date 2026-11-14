// Router 工作台顶栏右侧模型选择入口（docs/ui-standard.md 第 21 条）：
// 桌面端弹出轻量 Popover，手机端弹出底部 Drawer；一键选 Auto 或已就绪厂商快模型预设，细节默认收起可展开切换模型与思考程度。
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { ChevronDown, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  AVAILABILITY_LABELS,
  bundledModelCatalog,
  effortsFor,
  isListed,
  isSelectable,
  modelShortLabel,
  resolveRouterModelPreview,
  resolveVendorRouterPreset,
  splitModelEffort,
  vendorLabel,
  vendorSpec,
  type AgentVendor,
  type ModelCatalog,
  type RouterSettings,
  type UpdateRouterSettingsRequest,
} from "../../shared/index.ts";
import { localClient } from "../client.ts";
import { errorText, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalogs, useRefreshModelCatalogs, useRevalidateModels } from "../models.tsx";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Drawer, DrawerContent, DrawerTitle } from "../ui/drawer.tsx";
import { Select } from "../ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { RadioMark } from "./ChoiceRows.tsx";
import { RowError } from "./SettingsList.tsx";

const AUTO_VALUE = "auto";

const ROW_INTERACTIVE_CLASS =
  "-mx-2.5 flex min-h-9 w-[calc(100%+1.25rem)] cursor-pointer items-center gap-3 rounded-xl px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-hover active:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11";

/** 乐观显示的设置：请求在途（confirmed 为 false）时一直用它；服务端确认后等权威快照的 updatedAt 追上再放手。 */
interface OptimisticSettings {
  settings: RouterSettings;
  confirmed: boolean;
}

function resolveExplicitVendorChoice(
  vendor: AgentVendor,
  settings: RouterSettings,
  catalog: ModelCatalog,
): { model: string; effort: string | null } {
  const rawModel = settings.model?.trim() || null;
  const rawEffort = settings.effort?.trim() || null;
  if (rawModel !== null) {
    const split = splitModelEffort(vendor, rawModel, rawEffort, catalog);
    const model = split.model ?? rawModel;
    const supported = effortsFor(catalog, model);
    const effort =
      split.effort !== null && (supported.length === 0 || supported.includes(split.effort))
        ? split.effort
        : (supported[0] ?? null);
    return { model, effort };
  }
  const preset = resolveVendorRouterPreset(vendor, catalog);
  return { model: preset.model, effort: rawEffort ?? preset.effort };
}

export const RouterModelPicker = memo(function RouterModelPicker({
  settings,
  mobile,
  onManageProviders,
}: {
  settings: RouterSettings;
  mobile: boolean;
  onManageProviders?: (() => void) | undefined;
}) {
  const catalogs = useModelCatalogs();
  const refreshCatalogs = useRefreshModelCatalogs();
  const revalidateModels = useRevalidateModels();

  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<OptimisticSettings | null>(null);
  const [saveError, setSaveError] = useState<ErrorLike | null>(null);

  const seqRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 在途的请求一直显示用户最后选的（连着改两次时，前一次的回声不会把界面闪回去）；
  // 服务端确认后，权威快照（WebSocket）的 updatedAt 追上这次写入就放手，之后别处的改动照常跟进
  const optimisticFresh =
    optimistic !== null && !(optimistic.confirmed && settings.updatedAt >= optimistic.settings.updatedAt);
  if (optimistic !== null && !optimisticFresh) {
    setOptimistic(null);
  }
  const effectiveSettings = optimisticFresh ? optimistic.settings : settings;

  const catalogMap = useMemo(() => {
    const map = new Map<AgentVendor, ModelCatalog>();
    for (const c of catalogs) map.set(c.vendor, c);
    return map;
  }, [catalogs]);

  const autoResolution = useMemo(
    () => resolveRouterModelPreview(null, catalogs),
    [catalogs],
  );
  const activeResolution = useMemo(
    () => resolveRouterModelPreview(effectiveSettings, catalogs),
    [effectiveSettings, catalogs],
  );

  const autoModelShort = useMemo(() => {
    if (!autoResolution.ok) return null;
    const cat = catalogMap.get(autoResolution.vendor) ?? bundledModelCatalog(autoResolution.vendor);
    return modelShortLabel(autoResolution.vendor, autoResolution.model, cat);
  }, [autoResolution, catalogMap]);

  const triggerDisplay = useMemo(() => {
    if (effectiveSettings.vendor === null) {
      if (activeResolution.ok) {
        const cat = catalogMap.get(activeResolution.vendor) ?? bundledModelCatalog(activeResolution.vendor);
        const shortModel = modelShortLabel(activeResolution.vendor, activeResolution.model, cat);
        const vLabel = vendorLabel(activeResolution.vendor);
        return {
          prefix: "Auto",
          prefixHideClass: "@max-[19rem]/chat:hidden",
          primary: shortModel,
          ariaLabel: `Router model: Auto ${shortModel}`,
          title: `Auto: ${vLabel} ${shortModel}, ${activeResolution.effort}`,
        };
      }
      return {
        prefix: null,
        prefixHideClass: "",
        primary: "Auto",
        ariaLabel: "Router model: Auto",
        title: "Auto",
      };
    }

    const prefVendor = effectiveSettings.vendor;
    if (activeResolution.ok) {
      const cat = catalogMap.get(activeResolution.vendor) ?? bundledModelCatalog(activeResolution.vendor);
      const shortModel = modelShortLabel(activeResolution.vendor, activeResolution.model, cat);
      const vLabel = vendorLabel(activeResolution.vendor);
      return {
        prefix: vLabel,
        prefixHideClass: "@max-[25rem]/chat:hidden",
        primary: shortModel,
        ariaLabel: `Router model: ${vLabel} ${shortModel}`,
        title: `${vLabel} ${shortModel}, ${activeResolution.effort}`,
      };
    }

    const prefCat = catalogMap.get(prefVendor) ?? bundledModelCatalog(prefVendor);
    const chosen = resolveExplicitVendorChoice(prefVendor, effectiveSettings, prefCat);
    const shortModel = modelShortLabel(prefVendor, chosen.model, prefCat);
    const vLabel = vendorLabel(prefVendor);
    return {
      prefix: vLabel,
      prefixHideClass: "@max-[25rem]/chat:hidden",
      primary: shortModel,
      ariaLabel: `Router model: ${vLabel} ${shortModel}`,
      title: chosen.effort === null ? `${vLabel} ${shortModel}` : `${vLabel} ${shortModel}, ${chosen.effort}`,
    };
  }, [effectiveSettings, activeResolution, catalogMap]);

  const listedCatalogs = useMemo(() => {
    const pref = effectiveSettings.vendor;
    const withCurrent =
      pref !== null && !catalogs.some((c) => c.vendor === pref)
        ? [...catalogs, bundledModelCatalog(pref)]
        : catalogs;
    return withCurrent.filter((c) => isListed(c.availability) || c.vendor === pref);
  }, [catalogs, effectiveSettings.vendor]);

  const showManageProviders =
    onManageProviders !== undefined && catalogs.some((c) => !isSelectable(c.availability));

  const applyUpdate = useCallback(
    async (next: UpdateRouterSettingsRequest) => {
      const mine = ++seqRef.current;
      setSaveError(null);
      setOptimistic({ settings: { ...next, updatedAt: settings.updatedAt }, confirmed: false });
      try {
        const res = await localClient.putRouterSettings(next);
        if (!aliveRef.current || mine !== seqRef.current) return;
        setOptimistic({ settings: res.settings, confirmed: true });
      } catch (err) {
        if (!aliveRef.current || mine !== seqRef.current) return;
        setOptimistic(null);
        setSaveError(errorText(err));
      }
    },
    [settings.updatedAt],
  );

  const handleRadioChange = useCallback(
    (value: string) => {
      if (value === AUTO_VALUE) {
        if (effectiveSettings.vendor === null) return;
        setDetailsOpen(false);
        void applyUpdate({ vendor: null, model: null, effort: null });
        return;
      }
      const target = listedCatalogs.find((c) => c.vendor === value);
      if (!target || !isSelectable(target.availability)) return;
      if (effectiveSettings.vendor === target.vendor) return;
      const preset = resolveVendorRouterPreset(target.vendor, target);
      setDetailsOpen(false);
      void applyUpdate({
        vendor: target.vendor,
        model: preset.model,
        effort: preset.effort,
      });
    },
    [effectiveSettings.vendor, listedCatalogs, applyUpdate],
  );

  const selectedVendor = effectiveSettings.vendor;
  const selectedCatalog =
    selectedVendor !== null ? (catalogMap.get(selectedVendor) ?? bundledModelCatalog(selectedVendor)) : null;
  const selectedChoice = useMemo(
    () =>
      selectedVendor !== null && selectedCatalog !== null
        ? resolveExplicitVendorChoice(selectedVendor, effectiveSettings, selectedCatalog)
        : null,
    [selectedVendor, selectedCatalog, effectiveSettings],
  );
  const supportedEfforts = useMemo(
    () =>
      selectedCatalog !== null && selectedChoice !== null
        ? effortsFor(selectedCatalog, selectedChoice.model)
        : [],
    [selectedCatalog, selectedChoice],
  );
  const showEffort = supportedEfforts.length > 1;

  const handleModelChange = useCallback(
    (nextModel: string) => {
      if (selectedVendor === null || selectedCatalog === null || selectedChoice === null) return;
      if (nextModel === selectedChoice.model) return;
      const nextSupported = effortsFor(selectedCatalog, nextModel);
      const routerPreset = vendorSpec(selectedVendor).models.routerDefault;
      let nextEffort: string | null = selectedChoice.effort;
      if (nextEffort === null || (nextSupported.length > 0 && !nextSupported.includes(nextEffort))) {
        nextEffort =
          nextModel === routerPreset.model && nextSupported.includes(routerPreset.effort)
            ? routerPreset.effort
            : (nextSupported[0] ?? null);
      }
      void applyUpdate({
        vendor: selectedVendor,
        model: nextModel,
        effort: nextEffort,
      });
    },
    [selectedVendor, selectedCatalog, selectedChoice, applyUpdate],
  );

  const handleEffortChange = useCallback(
    (nextEffort: string) => {
      if (selectedVendor === null || selectedChoice === null) return;
      if (nextEffort === selectedChoice.effort) return;
      void applyUpdate({
        vendor: selectedVendor,
        model: selectedChoice.model,
        effort: nextEffort,
      });
    },
    [selectedVendor, selectedChoice, applyUpdate],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        setDetailsOpen(false);
        setSaveError(null);
        refreshCatalogs();
      }
    },
    [refreshCatalogs],
  );

  const modelSelectId = useId();
  const effortSelectId = useId();
  const selectedRadioValue = effectiveSettings.vendor ?? AUTO_VALUE;
  const unlistedSelectedModel =
    selectedCatalog !== null &&
    selectedChoice !== null &&
    !selectedCatalog.models.some((m) => m.id === selectedChoice.model);

  const panelBody = (
    <div className="grid gap-2">
      <RadioGroupPrimitive.Root
        aria-label="Router provider"
        value={selectedRadioValue}
        onValueChange={handleRadioChange}
        className="grid gap-0.5"
      >
        <RadioGroupPrimitive.Item value={AUTO_VALUE} className={ROW_INTERACTIVE_CLASS}>
          <span className="shrink-0 text-body text-foreground">Auto</span>
          {autoModelShort !== null && (
            <span title={autoModelShort} className="ml-auto min-w-0 truncate text-minor text-muted-foreground">
              {autoModelShort}
            </span>
          )}
          <span className={cn("shrink-0", autoModelShort === null && "ml-auto")}>
            <RadioMark checked={selectedRadioValue === AUTO_VALUE} />
          </span>
        </RadioGroupPrimitive.Item>

        {listedCatalogs.map((cat) => {
          const selectable = isSelectable(cat.availability);
          const checked = effectiveSettings.vendor === cat.vendor;
          let secondary: string | null;
          if (!selectable) {
            secondary = AVAILABILITY_LABELS[cat.availability];
          } else if (checked && selectedChoice !== null) {
            secondary = modelShortLabel(cat.vendor, selectedChoice.model, cat);
          } else {
            const preset = resolveVendorRouterPreset(cat.vendor, cat);
            secondary = modelShortLabel(cat.vendor, preset.model, cat);
          }
          return (
            <RadioGroupPrimitive.Item
              key={cat.vendor}
              value={cat.vendor}
              disabled={!selectable}
              className={cn(
                ROW_INTERACTIVE_CLASS,
                !selectable && "cursor-default hover:bg-transparent active:bg-transparent",
              )}
            >
              <span className={cn("shrink-0 text-body", selectable ? "text-foreground" : "text-muted-foreground")}>
                {cat.label}
              </span>
              {secondary !== null && (
                <span title={secondary} className="ml-auto min-w-0 truncate text-minor text-muted-foreground">
                  {secondary}
                </span>
              )}
              {selectable && (
                <span className={cn("shrink-0", secondary === null && "ml-auto")}>
                  <RadioMark checked={checked} />
                </span>
              )}
            </RadioGroupPrimitive.Item>
          );
        })}
      </RadioGroupPrimitive.Root>

      {selectedVendor !== null &&
        selectedCatalog !== null &&
        selectedChoice !== null &&
        isSelectable(selectedCatalog.availability) && (
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="border-t border-border pt-2">
            <CollapsibleTrigger
              type="button"
              className={cn(
                ROW_INTERACTIVE_CLASS,
                "justify-between text-minor font-medium text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{showEffort ? "Model & effort" : "Model"}</span>
              <span className="flex items-center gap-1.5 font-normal">
                {!detailsOpen && showEffort && selectedChoice.effort !== null && <span>{selectedChoice.effort}</span>}
                <ChevronDown
                  className={cn(
                    "size-4 shrink-0 transition-transform motion-reduce:transition-none",
                    detailsOpen && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-1 pt-1">
              <div className="flex min-h-9 items-center justify-between gap-3 pointer-coarse:min-h-11">
                <label htmlFor={modelSelectId} className="shrink-0 text-body text-foreground">
                  Model
                </label>
                <Select
                  id={modelSelectId}
                  variant="plain"
                  value={selectedChoice.model}
                  onPointerDown={revalidateModels}
                  onFocus={revalidateModels}
                  onChange={(e) => handleModelChange(e.target.value)}
                >
                  {selectedCatalog.models.map((m) => (
                    <option key={m.id} value={m.id} title={m.description ?? undefined}>
                      {m.label}
                    </option>
                  ))}
                  {unlistedSelectedModel && (
                    <option value={selectedChoice.model}>
                      {modelShortLabel(selectedVendor, selectedChoice.model, selectedCatalog)}
                    </option>
                  )}
                </Select>
              </div>
              {showEffort && selectedChoice.effort !== null && (
                <div className="flex min-h-9 items-center justify-between gap-3 pointer-coarse:min-h-11">
                  <label htmlFor={effortSelectId} className="shrink-0 text-body text-foreground">
                    Effort
                  </label>
                  <Select
                    id={effortSelectId}
                    variant="plain"
                    value={selectedChoice.effort}
                    onChange={(e) => handleEffortChange(e.target.value)}
                  >
                    {supportedEfforts.map((eff) => (
                      <option key={eff} value={eff}>
                        {eff}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}

      {saveError !== null && <RowError error={saveError} />}

      {showManageProviders && (
        <div className="border-t border-border pt-2">
          <button
            type="button"
            onClick={() => {
              flushSync(() => setOpen(false));
              onManageProviders();
            }}
            className={cn(
              ROW_INTERACTIVE_CLASS,
              "justify-between text-minor font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            <span>Manage providers…</span>
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );

  const triggerButton = (
    <Button
      type="button"
      variant="ghost"
      aria-label={triggerDisplay.ariaLabel}
      title={triggerDisplay.title}
      {...(mobile ? { "aria-expanded": open, "aria-haspopup": "dialog" as const, onClick: () => handleOpenChange(!open) } : {})}
      className={cn("min-w-0 max-w-full gap-2 overflow-hidden px-3", open && "text-foreground")}
    >
      {triggerDisplay.prefix !== null && (
        <span className={cn("shrink-0 text-muted-foreground", triggerDisplay.prefixHideClass)}>
          {triggerDisplay.prefix}
        </span>
      )}
      <span className="min-w-0 truncate text-foreground">{triggerDisplay.primary}</span>
      <ChevronDown className={cn("size-4 shrink-0", !open && "text-muted-foreground")} aria-hidden="true" />
    </Button>
  );

  if (mobile) {
    return (
      <>
        {triggerButton}
        <Drawer open={open} onOpenChange={handleOpenChange} shouldScaleBackground={false}>
          <DrawerContent onCloseAutoFocus={(e) => e.preventDefault()}>
            <DrawerTitle className="sr-only">Router model</DrawerTitle>
            <div className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-y-contain px-5 pt-1 pb-4">
              {panelBody}
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      <PopoverContent align="end" aria-label="Router model">
        {panelBody}
      </PopoverContent>
    </Popover>
  );
});
