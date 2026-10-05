import { KeymapEditor } from "#renderer/components/keymap-editor";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { uiPlatform } from "#renderer/lib/platform";
import { useSystem } from "#renderer/lib/use-app-context";

export const KeyboardPage = () => {
  const system = useSystem();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  return (
    <KeymapEditor
      keymap={prefs.keymap ?? {}}
      platform={uiPlatform(system.platform)}
      onUpdate={update}
    />
  );
};
