export {
  SessionTabRef,
  NewSessionSearch,
  SessionSearch,
  DiffSearch,
} from "#next/lib/navigation/search";
export const isRelativePath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !/^[A-Za-z]:/.test(path) &&
  !path.split(/[\\/]/).includes("..");
