import { KeymapEditor } from "#next/components/keymap-editor";
import { usePrefs, useUpdatePrefs } from "#next/data/db/prefs";
import { toHotkeyPlatform } from "#next/lib/platform";
import { useAppContext } from "#next/lib/use-app-context";

export const KeyboardPage = () => {
  const { system } = useAppContext();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  return (
    <KeymapEditor
      keymap={prefs.keymap ?? {}}
      platform={toHotkeyPlatform(system.platform)}
      onUpdate={update}
    />
  );
};
