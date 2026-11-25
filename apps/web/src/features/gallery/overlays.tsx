/**
 * Overlay examples: each renders closed with its trigger; `?open=<id>` opens
 * exactly that one (bound to the URL, so reloads and screenshots are
 * deterministic). Gallery copy is dev-only English (spec 01 §9.3).
 */
import {
  createContext,
  use,
  useState,
  useEffect,
  type ReactElement,
} from "react";

import { FileTreeView } from "#renderer/components/file-tree";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "#renderer/ui/combobox";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "#renderer/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "#renderer/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#renderer/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "#renderer/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "#renderer/ui/hover-card";
import { Input } from "#renderer/ui/input";
import { InputGroupAddon } from "#renderer/ui/input-group";
import { Item, ItemGroup, ItemContent, ItemTitle } from "#renderer/ui/item";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "#renderer/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#renderer/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "#renderer/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import type { GalleryOverlayId } from "./search";

export interface OverlayControl {
  open: GalleryOverlayId | undefined;
  stress?: string;
  setOpen(id: GalleryOverlayId | undefined): void;
}

export const OverlayContext = createContext<OverlayControl>({
  open: undefined,
  setOpen: () => undefined,
});

const useOverlay = (id: GalleryOverlayId) => {
  const control = use(OverlayContext);
  return {
    open: control.open === id,
    onOpenChange: (open: boolean) => control.setOpen(open ? id : undefined),
  };
};

const FRUITS = ["Apple", "Banana", "Cherry", "Grape", "Mango"];
const SESSION_MENU_LABELS = [
  "Rename session",
  "Pin",
  "Mark as unread",
  "Open beside this chat",
  "New worktree from here",
  "Copy session ID",
  "Delete session",
];
const POPUP_STRESS_LABELS = Array.from(
  { length: 50 },
  (_, index) =>
    `Connection ${index + 1}: a very long workspace and branch label that needs to fit inside a narrow window`
);
/**
 * `?stress=content`: what people put in overlays. A name with no spaces to
 * break at, a long path, a row that must truncate, and three actions with
 * long labels.
 */
const UNBROKEN_NAME =
  "Quarterly_planning_workspace_for_the_north_america_sales_team_final_v3";
const LONG_PATH =
  "C:\\Users\\someone\\Documents\\Projects\\invoice-app\\src\\components\\InvoiceTableWithFilters.tsx";
const LONG_ROW =
  "Build a modern, full-stack web application called TaskFlow Pro with a dashboard";
const CONTENT_STRESS_LABELS = [UNBROKEN_NAME, LONG_PATH, LONG_ROW, ...FRUITS];
const useContentStress = () => use(OverlayContext).stress === "content";
const useLabels = () => {
  const { stress } = use(OverlayContext);
  return stress === "content"
    ? CONTENT_STRESS_LABELS
    : stress
      ? POPUP_STRESS_LABELS
      : FRUITS;
};

/** A row the way overlays list running work or files: an icon and a truncated name. */
const TruncatedRow = ({ label }: { label: string }) => (
  <div className="bg-muted/50 flex min-w-0 items-center gap-2 rounded-md px-3 py-2">
    <span aria-hidden className="bg-primary size-2 shrink-0 rounded-full" />
    <span className="truncate font-medium" title={label}>
      {label}
    </span>
  </div>
);

export const OverlayExample = ({ id }: { id: GalleryOverlayId }) => {
  const { stress } = use(OverlayContext);
  const Example = OVERLAY_EXAMPLES[id];
  return (
    <div
      data-popup-fixture={id}
      style={
        stress && stress !== "content"
          ? {
              position: "fixed",
              zIndex: 1,
              ...(stress === "sidebar"
                ? { left: "min(240px, calc(100vw - 48px))", top: "45vh" }
                : {
                    [stress.startsWith("top") ? "top" : "bottom"]: 8,
                    [stress.endsWith("left") ? "left" : "right"]: 8,
                  }),
            }
          : undefined
      }
    >
      <Example />
    </div>
  );
};

export const RowStatesExample = () => {
  const { stress } = use(OverlayContext);
  if (!stress) return null;
  return (
    <div className="flex flex-col gap-4" data-row-states>
      <ItemGroup>
        {[
          "Selected connection",
          "Hovered connection",
          "Keyboard focused connection",
        ].map((label, index) => (
          <Item
            key={label}
            data-selected={index === 0 || undefined}
            render={<button type="button" />}
          >
            <ItemContent>
              <ItemTitle>{label}</ItemTitle>
            </ItemContent>
            <span className="shrink-0" aria-hidden>
              ⋯
            </span>
          </Item>
        ))}
      </ItemGroup>
      <div className="h-40">
        <FileTreeView
          paths={["notes.md", "plan.md", "report.md"]}
          onSelect={() => {}}
          onOpen={() => {}}
          onRename={() => {}}
        />
      </div>
    </div>
  );
};

const DialogExample = () => {
  const state = useOverlay("dialog");
  const content = useContentStress();
  const [name, setName] = useState("Morning brief");
  return (
    <Dialog {...state}>
      <DialogTrigger render={<Button variant="outline" />}>
        Open dialog
      </DialogTrigger>
      <DialogContent data-example="dialog">
        <DialogHeader>
          <DialogTitle>
            {content ? `Rename ${UNBROKEN_NAME}` : "Rename session"}
          </DialogTitle>
          <DialogDescription>
            {content
              ? `It lives in ${LONG_PATH}.`
              : "Give the session a name you will recognise."}
          </DialogDescription>
        </DialogHeader>
        {content && <TruncatedRow label={LONG_ROW} />}
        <label className="grid gap-2 text-sm">
          Session name
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => state.onOpenChange(false)}>
            Cancel
          </Button>
          {content && (
            <Button variant="secondary">Save as a new session instead</Button>
          )}
          <Button onClick={() => state.onOpenChange(false)}>
            {content ? "Save and keep the old name as an alias" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const AlertDialogExample = () => {
  const state = useOverlay("alert-dialog");
  const content = useContentStress();
  return (
    <AlertDialog {...state}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>
        Delete bot
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {content ? `Delete ${UNBROKEN_NAME}?` : "Delete Morning Brief?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {content
              ? `Its chat, its memory and ${LONG_PATH} go with it.`
              : "Its chat and memory go with it."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {content && (
          <div className="flex flex-col gap-1">
            <TruncatedRow label={LONG_ROW} />
            <TruncatedRow label={LONG_PATH} />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {content && (
            <AlertDialogAction variant="destructive">
              Delete anyway
            </AlertDialogAction>
          )}
          <AlertDialogAction variant={content ? "default" : "destructive"}>
            {content ? "Wait for it to finish" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const SheetExample = () => {
  const state = useOverlay("sheet");
  const content = useContentStress();
  return (
    <Sheet {...state}>
      <SheetTrigger render={<Button variant="outline" />}>
        Open sheet
      </SheetTrigger>
      <SheetContent
        side="right"
        className="bg-popover shadow-xl"
        style={{
          top: "var(--toolbar-h)",
          height: "calc(100dvh - var(--toolbar-h))",
        }}
      >
        <SheetHeader>
          <SheetTitle>{content ? UNBROKEN_NAME : "Bot details"}</SheetTitle>
          <SheetDescription>
            {content ? LONG_PATH : "Mission, persona and model."}
          </SheetDescription>
        </SheetHeader>
        {content && (
          <>
            <div className="px-6">
              <TruncatedRow label={LONG_ROW} />
            </div>
            <SheetFooter>
              <Button variant="outline">Cancel</Button>
              <Button variant="secondary">Duplicate this bot</Button>
              <Button>Save the bot and restart it</Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
};

const DrawerExample = () => {
  const state = useOverlay("drawer");
  const content = useContentStress();
  return (
    <Drawer {...state} swipeDirection="right" modal={false}>
      <DrawerTrigger render={<Button variant="outline" />}>
        Open drawer
      </DrawerTrigger>
      <DrawerContent data-side-panel="">
        <DrawerHeader>
          <DrawerTitle>{content ? UNBROKEN_NAME : "Side panel"}</DrawerTitle>
          <DrawerDescription>
            {content ? LONG_PATH : "The drawer the shell uses below 1100 px."}
          </DrawerDescription>
        </DrawerHeader>
        {content && (
          <DrawerFooter>
            <Button variant="outline">Cancel</Button>
            <Button variant="secondary">Open in a new window</Button>
            <Button>Keep the panel open beside the chat</Button>
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  );
};

const DropdownMenuExample = () => {
  const state = useOverlay("dropdown-menu");
  const { stress } = use(OverlayContext);
  return (
    <DropdownMenu {...state}>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        Actions
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {stress && stress !== "sidebar" && stress !== "content" && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              More actions with a very long submenu label
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {POPUP_STRESS_LABELS.map((label) => (
                <DropdownMenuItem key={label}>{label}</DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuGroup>
          {(stress === "sidebar"
            ? SESSION_MENU_LABELS
            : stress === "content"
              ? CONTENT_STRESS_LABELS
              : stress
                ? POPUP_STRESS_LABELS
                : ["Rename", "Pin", "Delete"]
          ).map((label) => (
            <DropdownMenuItem key={label}>{label}</DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ContextMenuExample = () => {
  const state = useOverlay("context-menu");
  const labels = useLabels();
  useEffect(() => {
    if (!state.open) return;
    const trigger = document.querySelector(
      '[data-slot="context-menu-trigger"]'
    );
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    trigger.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: Math.min(
          innerWidth - 8,
          Math.max(8, rect.left + rect.width / 2)
        ),
        clientY: Math.min(
          innerHeight - 8,
          Math.max(8, rect.top + rect.height / 2)
        ),
      })
    );
  }, [state.open]);
  return (
    <ContextMenu {...state}>
      <ContextMenuTrigger className="text-muted-foreground flex h-20 w-48 items-center justify-center rounded-md border border-dashed text-xs">
        Right-click here
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            More actions with a very long submenu label
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {labels.map((label) => (
              <ContextMenuItem key={label}>{label}</ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {labels.map((label) => (
          <ContextMenuItem key={label}>{label}</ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
};

const PopoverExample = () => {
  const state = useOverlay("popover");
  const labels = useLabels();
  const content = useContentStress();
  return (
    <Popover {...state}>
      <PopoverTrigger render={<Button variant="outline" />}>
        Open popover
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>{content ? UNBROKEN_NAME : "Model"}</PopoverTitle>
          <PopoverDescription>Pick the model this bot uses.</PopoverDescription>
        </PopoverHeader>
        {content && <TruncatedRow label={LONG_ROW} />}
        {labels.map((label) => (
          <p key={label}>{label}</p>
        ))}
      </PopoverContent>
    </Popover>
  );
};

const TooltipExample = () => {
  const state = useOverlay("tooltip");
  const { stress } = use(OverlayContext);
  return (
    <Tooltip {...state}>
      <TooltipTrigger render={<Button variant="outline" />}>
        Hover me
      </TooltipTrigger>
      <TooltipContent>
        {stress === "content"
          ? LONG_PATH
          : stress
            ? POPUP_STRESS_LABELS[0]
            : "New session"}
      </TooltipContent>
    </Tooltip>
  );
};

const HoverCardExample = () => {
  const state = useOverlay("hover-card");
  const labels = useLabels();
  return (
    <HoverCard {...state}>
      <HoverCardTrigger render={<Button variant="link" />}>
        @morning-brief
      </HoverCardTrigger>
      <HoverCardContent>
        {labels.map((label) => (
          <p key={label}>{label}</p>
        ))}
      </HoverCardContent>
    </HoverCard>
  );
};

const ComboboxExample = () => {
  const state = useOverlay("combobox");
  const labels = useLabels();
  return (
    <Combobox items={labels} {...state}>
      {/* The registry trigger has no accessible name; ours does. */}
      <ComboboxInput
        placeholder="Pick a fruit"
        aria-label="Fruit"
        showTrigger={false}
      >
        <InputGroupAddon align="inline-end">
          <ComboboxTrigger aria-label="Show fruits" />
        </InputGroupAddon>
      </ComboboxInput>
      <ComboboxContent>
        <ComboboxEmpty>Nothing found.</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
};

const CommandExample = () => {
  const state = useOverlay("command");
  const labels = useLabels();
  return (
    <>
      <Button variant="outline" onClick={() => state.onOpenChange(true)}>
        Open command menu
      </Button>
      <CommandDialog {...state} title="Command menu" description="Search">
        <Command>
          <CommandInput placeholder="Type a command" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup heading="Areas">
              {labels.map((label) => (
                <CommandItem key={label}>
                  {label}
                  <CommandShortcut>⌘1</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
};

const SelectExample = () => {
  const state = useOverlay("select");
  const labels = useLabels();
  return (
    <Select
      items={labels.map((value) => ({ value, label: value }))}
      defaultValue="Apple"
      {...state}
    >
      <SelectTrigger aria-label="Fruit" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {labels.map((fruit) => (
          <SelectItem key={fruit} value={fruit}>
            {fruit}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export const OVERLAY_EXAMPLES: Record<GalleryOverlayId, () => ReactElement> = {
  dialog: DialogExample,
  "alert-dialog": AlertDialogExample,
  sheet: SheetExample,
  drawer: DrawerExample,
  "dropdown-menu": DropdownMenuExample,
  "context-menu": ContextMenuExample,
  popover: PopoverExample,
  tooltip: TooltipExample,
  "hover-card": HoverCardExample,
  combobox: ComboboxExample,
  command: CommandExample,
  select: SelectExample,
};
