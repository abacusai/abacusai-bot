/**
 * Side-effect module: selects the active profile's home directory. Must be
 * imported first in index.ts, before any module captures abacusBotHome().
 */
import { initProfileHome } from "./profile-home";

initProfileHome();
