# Web file operations

The renderer shares file RPCs and persistence with Electron. Browser file reads use authenticated HTTP instead of serializing bytes through WebSocket RPC. Paths passed to the agent are host paths, including uploads from the browser's computer.

| Operation / entry point | Desktop | Web | Finding / repair |
| --- | --- | --- | --- |
| Session Files: tree, filter, watch, refresh | Checkout RPCs and watch | Same RPCs; manual refresh too | Keep checkout root, decoded `file` search, visible search failures. |
| Session/bot Files: text, Markdown, CSV | Shared reader/viewer | Bounded HTTP reader/viewer | HTML/PDF had reached an empty browser adapter; text has loading, error/retry, empty and truncation states. |
| Images / PowerPoint | File RPCs | Bounded HTTP reads | Images have load errors; PowerPoint keeps the existing parser and 60 MB cap. |
| HTML / PDF | Native browser surface or local file URL | Authenticated blob preview | Electron URLs were unavailable on web. HTML starts as source; preview is sandboxed with external resources blocked. |
| Binary / download | Native external application | Size probe and authenticated download | Binary data is a size-labelled placeholder; downloads carry a MIME type and encoded filename. |
| Files rename / trash | RPC; OS trash | Same rename RPC; host recycle folder | Web trash requires confirmation; host retains files for 30 days. |
| Artifacts list / open / close | Shared feed, native open, inline preview | Same feed and inline viewer | Web Open now selects the preview instead of depending on the OS. Search state owns selection and close/reopen. |
| Artifacts reveal / delete | Reveal; no delete action | Copy path; no delete action | Native reveal hidden. Neither platform exposes artifact deletion; deleting a file removes its recorded artifact from the feed. |
| Changes / diff contents | Checkout/Git RPCs | Same RPCs | No desktop protocol dependency; shared read failures stay visible. |
| Attach computer files / folders | Paths from preload/native picker | Browser file input / directory input; streamed uploads | Preserve nested paths; shared draft descriptors; progress, cancel, retry and source badges. |
| Attach drop / clipboard / mobile | Preload paths, pasted blobs | Recursive directory entries / clipboard Files / universal file input | Preserve relative paths; folder count/size, junk filter and confirmation; failed uploads block send. |
| Attach existing VM paths | Native folder picker / file input | Rooted multi-file picker; current-folder selection | Reference paths in place, without uploading or copying. |
| Add workspace: session/bot start, environment, context tray, routines, commands | Native folder dialog → workspaces.add | App Dialog → same workspaces.add | Raw DOM picker removed. Host and UI clamp navigation to home (isolated bot home outside home). |
| Workspace relocation / missing workspace | Native folder dialog | Same VM Dialog | Shared check/relocate mutation and errors. |
| Library skills / SKILL.md | Native import/edit; marketplace | Marketplace, VM file viewer | Local import buttons were silent no-ops; hide with an explanation. OS editing remains desktop-only. |
| MCP configuration / memory / instructions | Typed configuration/file service | Same RPCs | No native file chooser or file URL required for these editors. |
| Chat local paths / terminal links / history | Native reveal or Files route | Files route or shared file Dialog | Browser openPath no longer creates a raw DOM viewer; host paths stay on the host. |
| OS editor / Finder / diagnostic export | Native actions/dialogs | Native actions omitted | Browser cannot launch host OS applications. Web About uses the license-only platform page. |
| Onboarding / notch | Native onboarding and notch | Web connect flow; no notch | Native folder/device flows are excluded from the web build. |

Uploads use `/upload` with workspace/session identity, a random batch and a validated relative path. Each file streams to an exclusive temporary file and is renamed after completion; aborted partial files are removed. A selection allows at most 1,000 files, 256 MB per file and 512 MB total, with three uploads in flight. More than 200 files or 100 MB prompts for confirmation. `.git`, `node_modules`, `.DS_Store`, Python caches and `.venv` are excluded by default. Picked VM paths are referenced in place. Sending is blocked while uploads are pending or failed.

`/files` remains authenticated and root-bounded; it supports HEAD, bounded reads and byte ranges, with `nosniff`, download disposition and no-store headers. Downloads obtain a one-minute, file-scoped ticket through authenticated POST `/files`; navigation still requires the owner's proxy session. No Python management-backend changes are required: these routes belong to the headless host behind the existing authenticated proxy. The host build must be deployed with the renderer.

Runtime checks used isolated host/web and Electron profiles with text, Markdown, HTML, PNG, PDF, CSV, binary, large, Unicode, nested and symlink fixtures. Verified web Artifacts close/reopen, file deep links/resize, Unicode download bytes, refresh/filter, confirmed trash, workspace selection and nested uploads with retry; native checks covered previews, OS file/folder dialogs, image paste and OS trash. Shared regression suites cover Changes and bot Files. The desktop file-header controls also wrap instead of clipping in a narrow pane. Native external browser/editor/Finder and diagnostic dialogs remain desktop-only; web HTML preview is static and blocks scripts/external resources.
