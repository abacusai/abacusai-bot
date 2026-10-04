import { KeymapEditor } from "#renderer/components/keymap-editor";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { toHotkeyPlatform } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";

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
