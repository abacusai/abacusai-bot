import { useEffect, useRef, useState, type ReactNode } from "react";

/** Copy rendered text, preserving block boundaries and excluding code chrome. */
export const selectedText = (fragment: DocumentFragment): string => {
  fragment
    .querySelectorAll(
      'button,[aria-hidden="true"],.chat-code-header,.chat-code-more,[data-selection-chrome]'
    )
    .forEach((el) => el.remove());
  fragment
    .querySelectorAll<HTMLAnchorElement>("a[data-copy-url]")
    .forEach((el) => el.replaceWith(el.dataset.copyUrl!));
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof Element) && !(node instanceof DocumentFragment))
      return "";
    const value = [...node.childNodes].map(text).join("");
    if (!(node instanceof Element)) return value;
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "TD" || node.tagName === "TH") return value + "\t";
    if (node.tagName === "LI") return "- " + value.trim() + "\n";
    if (/^(P|H[1-6]|PRE|TR|UL|OL|BLOCKQUOTE|DIV)$/.test(node.tagName))
      return value + "\n";
    return value;
  };
  return text(fragment)
    .replace(/\t\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
};

export const SelectableText = ({
  children,
  onSelectionChange,
}: {
  children: ReactNode;
  onSelectionChange(active: boolean): void;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const changed = () => {
      const selection = document.getSelection();
      const value =
        selection != null &&
        !selection.isCollapsed &&
        (root.current?.contains(selection.anchorNode) === true ||
          root.current?.contains(selection.focusNode) === true);
      setActive(value);
      onSelectionChange(value);
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, [onSelectionChange]);
  return (
    <div
      ref={root}
      tabIndex={0}
      data-message-text=""
      data-selecting={active ? "" : undefined}
      className="focus-visible:ring-ring min-w-0 rounded-sm outline-none select-text focus-visible:ring-2"
      onKeyDown={(event) => {
        const el = root.current;
        if (
          !el ||
          (event.target instanceof Element &&
            event.target.closest("button,input,textarea"))
        )
          return;
        const selection = document.getSelection();
        if (!selection) return;
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "a"
        ) {
          event.preventDefault();
          event.stopPropagation();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
        } else if (
          event.shiftKey &&
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!el.contains(selection.anchorNode)) {
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          }
          selection.modify(
            "extend",
            event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? "backward"
              : "forward",
            event.key === "ArrowUp" || event.key === "ArrowDown"
              ? "line"
              : "character"
          );
        }
      }}
      onCopy={(event) => {
        const selection = document.getSelection();
        if (
          !selection?.rangeCount ||
          !root.current?.contains(selection.anchorNode) ||
          !root.current.contains(selection.focusNode)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const range = selection.getRangeAt(0);
        const ancestor = range.commonAncestorContainer;
        const link = (
          ancestor instanceof Element ? ancestor : ancestor.parentElement
        )?.closest<HTMLAnchorElement>("a[data-copy-url]");
        event.clipboardData.setData(
          "text/plain",
          link?.dataset.copyUrl ?? selectedText(range.cloneContents())
        );
      }}
    >
      {children}
    </div>
  );
};
