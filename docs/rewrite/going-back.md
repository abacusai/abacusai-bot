# Going back to the previous version

Quit AbacusAI Bot before installing the previous version.

After release N, the previous version opens the bots, sessions, routines and settings left before the update. Conversations and preference changes made in N do not appear in that version. N leaves the legacy files in place. Reinstalling N shows the new conversations again.

After release N+1, restore the legacy files before installing a legacy version. Run the installed N+1 or newer executable once with `--restore-legacy-files`:

- macOS: `"/Applications/AbacusAI-Bot.app/Contents/MacOS/AbacusAI-Bot" --restore-legacy-files`
- Windows PowerShell: `& "$env:LOCALAPPDATA\Programs\AbacusAI-Bot\AbacusAI-Bot.exe" --restore-legacy-files`
- Linux: `/path/to/abacusai-bot --restore-legacy-files`

Use the executable at your installed location if it differs. The command checks every profile, prints a report and exits. It verifies backups against their recorded digests and rebuilds a damaged restore index. Preferences in prefs.json stay authoritative. An existing file with different content stays in place; the restored copy is written beside it with `.restored-` in its name and listed in the report. Send skipped-file or collision reports to support before installing the legacy version. Backups are kept for 30 days.

If the command cannot start, contact support. Do not move backup files by hand. A second restore after another N+1 migration uses the newer cycle's backups.
