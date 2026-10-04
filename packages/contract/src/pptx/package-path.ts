/** POSIX paths inside an OOXML package. */
const normalize = (value: string): string => {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !value.startsWith("/")) parts.push(part);
  }
  return (value.startsWith("/") ? "/" : "") + (parts.join("/") || ".");
};
const basename = (value: string): string => value.split("/").at(-1) ?? "";
export const packagePath = {
  posix: {
    normalize,
    join: (...parts: string[]) => normalize(parts.join("/")),
    dirname: (value: string) => {
      const index = value.lastIndexOf("/");
      return index < 0 ? "." : index === 0 ? "/" : value.slice(0, index);
    },
    basename,
    extname: (value: string) => {
      const name = basename(value);
      const index = name.lastIndexOf(".");
      return index > 0 ? name.slice(index) : "";
    },
  },
};
