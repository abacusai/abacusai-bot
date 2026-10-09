These are reviewed renderer adaptations to the offline 2026-09-30 registry,
recorded from main `f7ff13af`. They preserve the already merged UI behavior:

- #294: bounded popup positioning, shared row styling, scrolling and truncated labels.
- #296: the inline send-error alert.
- #308: compact attachment chips.

The original upstream snapshot stays intact. The check replays it offline,
verifies the exact input hashes, applies `renderer.patch`, verifies the exact
output hashes, then compares every generated file with the renderer's `ui/`.
The patch checksum and paths are checked too. Unexpected upstream changes,
additional source edits and unrecorded UI files still fail.

To update an adaptation, regenerate the registry in an isolated directory,
review the source diff and record its patch plus before/after hashes. Updating
this record requires the same code review as changing the underlying UI.
