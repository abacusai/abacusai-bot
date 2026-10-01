/**
 * Overlay examples: each renders closed with its trigger; `?open=<id>` opens
 * exactly that one (bound to the URL, so reloads and screenshots are
 * deterministic). Gallery copy is dev-only English (spec 01 §9.3).
 */
import { createContext, use, type ReactElement } from "react";

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
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "#renderer/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "#renderer/ui/hover-card";
import { InputGroupAddon } from "#renderer/ui/input-group";
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
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "#renderer/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import type { GalleryOverlayId } from "./search";

export interface OverlayControl {
  open: GalleryOverlayId | undefined;
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

const DialogExample = () => {
  const state = useOverlay("dialog");
  return (
    <Dialog {...state}>
      <DialogTrigger render={<Button variant="outline" />}>
        Open dialog
      </DialogTrigger>
      <DialogContent data-example="dialog">
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>
            Give the session a name you will recognise.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => state.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => state.onOpenChange(false)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const AlertDialogExample = () => {
  const state = useOverlay("alert-dialog");
  return (
    <AlertDialog {...state}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>
        Delete bot
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Morning Brief?</AlertDialogTitle>
          <AlertDialogDescription>
            Its chat and memory go with it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const SheetExample = () => {
  const state = useOverlay("sheet");
  return (
    <Sheet {...state}>
      <SheetTrigger render={<Button variant="outline" />}>
        Open sheet
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Bot details</SheetTitle>
          <SheetDescription>Mission, persona and model.</SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  );
};

const DrawerExample = () => {
  const state = useOverlay("drawer");
  return (
    <Drawer {...state} swipeDirection="right" modal={false}>
      <DrawerTrigger render={<Button variant="outline" />}>
        Open drawer
      </DrawerTrigger>
      <DrawerContent data-side-panel="">
        <DrawerHeader>
          <DrawerTitle>Side panel</DrawerTitle>
          <DrawerDescription>
            The drawer the shell uses below 1100 px.
          </DrawerDescription>
        </DrawerHeader>
      </DrawerContent>
    </Drawer>
  );
};

const DropdownMenuExample = () => {
  const state = useOverlay("dropdown-menu");
  return (
    <DropdownMenu {...state}>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        Actions
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Session</DropdownMenuLabel>
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuItem>Pin</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ContextMenuExample = () => {
  const state = useOverlay("context-menu");
  return (
    <ContextMenu {...state}>
      <ContextMenuTrigger className="text-muted-foreground flex h-20 w-48 items-center justify-center rounded-md border border-dashed text-xs">
        Right-click here
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Open</ContextMenuItem>
        <ContextMenuItem>Reveal in folder</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

const PopoverExample = () => {
  const state = useOverlay("popover");
  return (
    <Popover {...state}>
      <PopoverTrigger render={<Button variant="outline" />}>
        Open popover
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>Model</PopoverTitle>
          <PopoverDescription>Pick the model this bot uses.</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
};

const TooltipExample = () => {
  const state = useOverlay("tooltip");
  return (
    <Tooltip {...state}>
      <TooltipTrigger render={<Button variant="outline" />}>
        Hover me
      </TooltipTrigger>
      <TooltipContent>New session</TooltipContent>
    </Tooltip>
  );
};

const HoverCardExample = () => {
  const state = useOverlay("hover-card");
  return (
    <HoverCard {...state}>
      <HoverCardTrigger render={<Button variant="link" />}>
        @morning-brief
      </HoverCardTrigger>
      <HoverCardContent>
        Three meetings and one deadline today.
      </HoverCardContent>
    </HoverCard>
  );
};

const ComboboxExample = () => {
  const state = useOverlay("combobox");
  return (
    <Combobox items={FRUITS} {...state}>
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
              <CommandItem>
                Bots <CommandShortcut>⌘1</CommandShortcut>
              </CommandItem>
              <CommandItem>Sessions</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
};

const SelectExample = () => {
  const state = useOverlay("select");
  return (
    <Select
      items={FRUITS.map((value) => ({ value, label: value }))}
      defaultValue="Apple"
      {...state}
    >
      <SelectTrigger aria-label="Fruit" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FRUITS.map((fruit) => (
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
