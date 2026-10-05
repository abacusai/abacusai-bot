/**
 * One section per registry atom (spec 01 §10.1): every variant × size and
 * the prop-driven states (disabled, aria-invalid, loading, empty, long text).
 * Dev-only English copy.
 */
import { ChevronRight, File, Info, Plus, Search } from "lucide-react";
import type { ReactNode } from "react";

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "#renderer/ui/attachment";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
} from "#renderer/ui/avatar";
import { Badge } from "#renderer/ui/badge";
import { Bubble, BubbleContent, BubbleGroup } from "#renderer/ui/bubble";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#renderer/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "#renderer/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "#renderer/ui/item";
import { Kbd, KbdGroup } from "#renderer/ui/kbd";
import { Label } from "#renderer/ui/label";
import { Marker, MarkerContent, MarkerIcon } from "#renderer/ui/marker";
import {
  Message,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from "#renderer/ui/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "#renderer/ui/message-scroller";
import { NativeSelect, NativeSelectOption } from "#renderer/ui/native-select";
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireItem,
  QuestionnaireTitle,
} from "#renderer/ui/questionnaire";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#renderer/ui/resizable";
import { ScrollArea } from "#renderer/ui/scroll-area";
import { Separator } from "#renderer/ui/separator";
import { Skeleton } from "#renderer/ui/skeleton";
import { Spinner } from "#renderer/ui/spinner";
import { Switch } from "#renderer/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#renderer/ui/tabs";
import { Textarea } from "#renderer/ui/textarea";
import { toast } from "#renderer/ui/toast";
import { Toggle } from "#renderer/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "#renderer/ui/toggle-group";

export const Row = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-2">
    <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
      {label}
    </span>
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  </div>
);

const LONG =
  "A very long label that keeps going to show how the atom truncates or wraps when it runs out of room in a narrow column";

const BUTTON_VARIANTS = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "link",
] as const;
const BUTTON_SIZES = ["xs", "sm", "default", "lg"] as const;

export const ButtonSection = () => (
  <>
    {BUTTON_VARIANTS.map((variant) => (
      <Row key={variant} label={`variant ${variant}`}>
        {BUTTON_SIZES.map((size) => (
          <Button key={size} variant={variant} size={size}>
            {size}
          </Button>
        ))}
        <Button variant={variant} size="icon" aria-label="Add">
          <Plus />
        </Button>
        <Button variant={variant} disabled>
          disabled
        </Button>
        <Button variant={variant} aria-invalid>
          invalid
        </Button>
      </Row>
    ))}
    <Row label="loading">
      <Button disabled>
        <Spinner /> Saving
      </Button>
    </Row>
  </>
);

export const BadgeSection = () => (
  <Row label="variants">
    {(
      [
        "default",
        "secondary",
        "destructive",
        "outline",
        "ghost",
        "link",
      ] as const
    ).map((variant) => (
      <Badge key={variant} variant={variant}>
        {variant}
      </Badge>
    ))}
  </Row>
);

export const TabsSection = () => (
  <Tabs defaultValue="changes" className="w-96">
    <TabsList>
      <TabsTrigger value="changes">Changes</TabsTrigger>
      <TabsTrigger value="terminal">Terminal</TabsTrigger>
      <TabsTrigger value="files" disabled>
        Files
      </TabsTrigger>
    </TabsList>
    <TabsContent value="changes">No changes yet.</TabsContent>
    <TabsContent value="terminal">No terminal output.</TabsContent>
  </Tabs>
);

export const ResizableSection = () => (
  <div className="h-40 w-full max-w-xl rounded-md border">
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel minSize={120}>
        <div className="p-3 text-xs">Pane</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel minSize={120}>
        <div className="p-3 text-xs">Panel</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>
);

export const ScrollAreaSection = () => (
  <ScrollArea className="h-32 w-64 rounded-md border">
    <div className="flex flex-col gap-1 p-3 text-xs">
      {Array.from({ length: 30 }, (_, index) => (
        <span key={index}>Row {index + 1}</span>
      ))}
    </div>
  </ScrollArea>
);

export const KbdSection = () => (
  <Row label="keys">
    <Kbd>⌘</Kbd>
    <KbdGroup>
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
    <KbdGroup>
      <Kbd>Ctrl</Kbd>
      <Kbd>B</Kbd>
    </KbdGroup>
  </Row>
);

export const FieldSection = () => (
  <FieldGroup className="max-w-sm">
    <Field>
      <FieldLabel htmlFor="gallery-name">Name</FieldLabel>
      <Input id="gallery-name" placeholder="Morning Brief" />
      <FieldDescription>What the bot answers to.</FieldDescription>
    </Field>
    <Field data-invalid>
      <FieldLabel htmlFor="gallery-mission">Mission</FieldLabel>
      <Input id="gallery-mission" aria-invalid />
      <FieldError>A mission is required.</FieldError>
    </Field>
  </FieldGroup>
);

export const LabelSection = () => (
  <Row label="label">
    <Label htmlFor="gallery-label-input">Folder</Label>
    <Input id="gallery-label-input" className="w-48" />
  </Row>
);

export const InputSection = () => (
  <div className="flex max-w-sm flex-col gap-2">
    <Input aria-label="Default" placeholder="Default" />
    <Input aria-label="Disabled" placeholder="Disabled" disabled />
    <Input aria-label="Invalid" placeholder="Invalid" aria-invalid />
    <Input aria-label="Long" defaultValue={LONG} />
  </div>
);

export const InputGroupSection = () => (
  <InputGroup className="max-w-sm">
    <InputGroupAddon>
      <Search />
    </InputGroupAddon>
    <InputGroupInput aria-label="Search" placeholder="Search sessions" />
    <InputGroupAddon align="inline-end">
      <InputGroupButton aria-label="Go">
        <ChevronRight />
      </InputGroupButton>
    </InputGroupAddon>
  </InputGroup>
);

export const TextareaSection = () => (
  <div className="flex max-w-sm flex-col gap-2">
    <Textarea aria-label="Prompt" placeholder="Ask anything" />
    <Textarea aria-label="Disabled prompt" disabled placeholder="Disabled" />
    <Textarea aria-label="Invalid prompt" aria-invalid placeholder="Invalid" />
  </div>
);

export const ItemSection = () => (
  <div className="flex max-w-md flex-col gap-2">
    {(["default", "outline", "muted"] as const).map((variant) => (
      <Item key={variant} variant={variant}>
        <ItemMedia variant="icon">
          <Info />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{variant} item</ItemTitle>
          <ItemDescription>{LONG}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button size="sm" variant="outline">
            Open
          </Button>
        </ItemActions>
      </Item>
    ))}
  </div>
);

export const EmptySection = () => (
  <Empty className="max-w-md border">
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <File />
      </EmptyMedia>
      <EmptyTitle>Nothing made yet</EmptyTitle>
      <EmptyDescription>Files the agent writes show up here.</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <Button size="sm">Start a session</Button>
    </EmptyContent>
  </Empty>
);

export const SpinnerSection = () => (
  <Row label="sizes">
    <Spinner />
    <Spinner className="size-6" />
  </Row>
);

export const SkeletonSection = () => (
  <div className="flex max-w-sm flex-col gap-2">
    {Array.from({ length: 4 }, (_, index) => (
      <Skeleton key={index} className="h-8" />
    ))}
  </div>
);

export const SeparatorSection = () => (
  <div className="flex h-10 items-center gap-3 text-xs">
    <span>Left</span>
    <Separator orientation="vertical" />
    <span>Right</span>
    <Separator className="w-24" />
  </div>
);

export const AvatarSection = () => (
  <Row label="sizes">
    {(["sm", "default", "lg"] as const).map((size) => (
      <Avatar key={size} size={size}>
        <AvatarFallback>RR</AvatarFallback>
      </Avatar>
    ))}
    <Avatar>
      <AvatarFallback>AB</AvatarFallback>
      <AvatarBadge />
    </Avatar>
    <AvatarGroup>
      <Avatar>
        <AvatarFallback>A</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>B</AvatarFallback>
      </Avatar>
    </AvatarGroup>
  </Row>
);

export const ToggleSection = () => (
  <Row label="variants">
    <Toggle aria-label="Bold">B</Toggle>
    <Toggle variant="outline" aria-label="Italic">
      I
    </Toggle>
    <Toggle aria-label="Pressed" defaultPressed>
      On
    </Toggle>
    <Toggle aria-label="Disabled" disabled>
      Off
    </Toggle>
  </Row>
);

export const ToggleGroupSection = () => (
  <ToggleGroup defaultValue={["split"]} variant="outline" aria-label="View">
    <ToggleGroupItem value="split">Split</ToggleGroupItem>
    <ToggleGroupItem value="full">Full</ToggleGroupItem>
  </ToggleGroup>
);

export const SwitchSection = () => (
  <Row label="states">
    <Switch aria-label="Off" />
    <Switch aria-label="On" defaultChecked />
    <Switch aria-label="Disabled" disabled />
    <Switch aria-label="Small" size="sm" />
  </Row>
);

export const NativeSelectSection = () => (
  <NativeSelect aria-label="Language" defaultValue="system">
    <NativeSelectOption value="system">System</NativeSelectOption>
    <NativeSelectOption value="en-US">English</NativeSelectOption>
    <NativeSelectOption value="de-DE">Deutsch</NativeSelectOption>
  </NativeSelect>
);

export const ToastSection = () => (
  <Button
    variant="outline"
    data-testid="gallery-toasts"
    onClick={() => {
      toast.add({
        title: "Saved",
        description: "Your changes are saved.",
        type: "success",
      });
      toast.add({
        title: "Heads up",
        description: "The model changed.",
        type: "info",
      });
      toast.add({
        title: "Couldn't send",
        description: "Try again.",
        type: "error",
      });
    }}
  >
    Add three toasts
  </Button>
);

export const MessageScrollerSection = () => (
  <div className="h-48 w-full max-w-md rounded-md border">
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {[
              "Hi",
              "Summarise my inbox",
              "Three meetings and one deadline today.",
            ].map((text) => (
              <MessageScrollerItem key={text}>
                <div className="p-2 text-xs">{text}</div>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  </div>
);

export const MessageSection = () => (
  <MessageGroup className="max-w-md">
    <Message>
      <MessageContent>
        <MessageHeader>Agent</MessageHeader>
        <p>I read the three files and found the bug in the resize handler.</p>
      </MessageContent>
    </Message>
    <Message align="end">
      <MessageContent>
        <p>Fix it and run the tests.</p>
      </MessageContent>
    </Message>
  </MessageGroup>
);

export const BubbleSection = () => (
  <BubbleGroup className="max-w-md">
    <Bubble>
      <BubbleContent>Three meetings and one deadline today.</BubbleContent>
    </Bubble>
    <Bubble align="end">
      <BubbleContent>Move the design review to 3pm.</BubbleContent>
    </Bubble>
  </BubbleGroup>
);

export const AttachmentSection = () => (
  <AttachmentGroup>
    {(["idle", "uploading", "error", "done"] as const).map((state) => (
      <Attachment key={state} state={state}>
        <AttachmentMedia>
          <File />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>report-{state}.pdf</AttachmentTitle>
          <AttachmentDescription>{state}</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
    ))}
  </AttachmentGroup>
);

export const MarkerSection = () => (
  <div className="flex max-w-md flex-col gap-2">
    <Marker>
      <MarkerIcon>
        <Info />
      </MarkerIcon>
      <MarkerContent>Thought for 4 seconds</MarkerContent>
    </Marker>
    <Marker variant="separator">
      <MarkerContent>Today</MarkerContent>
    </Marker>
  </div>
);

export const QuestionnaireSection = () => (
  <Questionnaire className="max-w-md">
    <QuestionnaireItem name="folder">
      <QuestionnaireTitle>Which folder should I work in?</QuestionnaireTitle>
      <QuestionnaireDescription>Pick one.</QuestionnaireDescription>
      <QuestionnaireChoices>
        <QuestionnaireChoice value="app">abacusai-bot</QuestionnaireChoice>
        <QuestionnaireChoice value="default">
          Default workspace
        </QuestionnaireChoice>
      </QuestionnaireChoices>
    </QuestionnaireItem>
  </Questionnaire>
);

export const CollapsibleSection = () => (
  <Collapsible defaultOpen className="max-w-sm rounded-md border p-2 text-xs">
    <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
      abacusai-bot
    </CollapsibleTrigger>
    <CollapsibleContent className="flex flex-col gap-1 pt-1 pl-4">
      <span>Review my pull requests</span>
      <span>Compress the installers</span>
    </CollapsibleContent>
  </Collapsible>
);
