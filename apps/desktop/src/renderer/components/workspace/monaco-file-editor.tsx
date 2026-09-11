import MonacoEditor, { loader } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import { useTheme } from "../../hooks/use-theme";

// Configure Monaco to use bundled workers (offline-safe for Electron)
if (!(globalThis as Record<string, unknown>).MonacoEnvironmentConfigured) {
  (globalThis as Record<string, unknown>).MonacoEnvironmentConfigured = true;
  self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      if (label === "json") return new jsonWorker();
      if (label === "css" || label === "scss" || label === "less")
        return new cssWorker();
      if (label === "html" || label === "handlebars" || label === "razor")
        return new htmlWorker();
      if (label === "typescript" || label === "javascript")
        return new tsWorker();
      return new editorWorker();
    },
  };
  loader.config({ monaco });
}

// Maps common file extensions to Monaco language IDs
const EXT_TO_LANGUAGE: Record<string, string> = {
  // Web
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  // Data / config
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  xml: "xml",
  ini: "ini",
  env: "ini",
  cfg: "ini",
  conf: "ini",
  // Systems
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",
  go: "go",
  rs: "rust",
  py: "python",
  rb: "ruby",
  php: "php",
  dart: "dart",
  r: "r",
  lua: "lua",
  perl: "perl",
  pl: "perl",
  // Shell / scripts
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  // Markup / docs
  md: "markdown",
  mdx: "markdown",
  rst: "restructuredtext",
  tex: "latex",
  // DB / infra
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  hcl: "hcl",
  proto: "proto",
  // Build
  makefile: "makefile",
  dockerfile: "dockerfile",
  gradle: "kotlin",
  // Other
  vue: "html",
  svelte: "html",
  txt: "plaintext",
  log: "plaintext",
  csv: "plaintext",
};

export const extensionToMonacoLanguage = (filename: string): string => {
  const lower = filename.toLowerCase();
  const basename = lower.split("/").pop() ?? lower;
  if (basename === "dockerfile" || basename.startsWith("dockerfile."))
    return "dockerfile";
  if (basename === "makefile" || basename === "gnumakefile") return "makefile";
  const ext = basename.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
};

/**
 * Push `next` into a cached model only when it differs. `pushEditOperations`
 * keeps the change on the undo stack, which matters when the reader is
 * mid-edit.
 */
const syncModelValue = (
  model: MonacoType.editor.ITextModel,
  next: string
): void => {
  if (model.getValue() === next) return;
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: next }],
    () => null
  );
};

export interface MonacoFileEditorProps {
  filePath: string;
  filename: string;
  content: string;
  readOnly: boolean;
  onSave: (content: string) => void;
  onChange: (content: string) => void;
}

export const MonacoFileEditor = ({
  filePath,
  filename,
  content,
  readOnly,
  onSave,
  onChange,
}: MonacoFileEditorProps): JSX.Element => {
  const { isDark } = useTheme();
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(
    null
  );
  const modelRef = useRef<MonacoType.editor.ITextModel | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Never drive model updates from this ref reactively.
  const contentRef = useRef(content);
  contentRef.current = content;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const filenameRef = useRef(filename);
  filenameRef.current = filename;

  // Bumping this key remounts <Editor>; see the onDidDispose handler for why.
  const [instanceKey, setInstanceKey] = useState(0);
  // One bump per disposal cycle; the next mount resets this.
  const remountScheduledRef = useRef(false);

  const handleEditorDidMount = useCallback(
    (editor: MonacoType.editor.IStandaloneCodeEditor) => {
      editorRef.current = editor;
      remountScheduledRef.current = false;

      // @monaco-editor/react is not React <Activity>-safe: reactivation calls
      // setModel() on a disposed editor. Bump instanceKey on dispose so a
      // fresh <Editor> mounts instead.
      editor.onDidDispose(() => {
        if (editorRef.current === editor) editorRef.current = null;
        if (!remountScheduledRef.current) {
          remountScheduledRef.current = true;
          setInstanceKey((k) => k + 1);
        }
      });

      // Replace Monaco's auto-URI model with a file-URI one now, or the first
      // keystroke creates it and setModel() resets the cursor to position 0.
      const language = extensionToMonacoLanguage(filenameRef.current);
      const uri = monaco.Uri.file(filePathRef.current);
      let model = monaco.editor.getModel(uri);
      if (model == null) {
        model = monaco.editor.createModel(contentRef.current, language, uri);
      } else {
        // Models are cached per URI, so a file the agent has since rewritten
        // would serve a stale buffer; `content` already holds pending edits.
        syncModelValue(model, contentRef.current);
      }
      try {
        editor.setModel(model);
      } catch {
        // Disposed before mount completed; onMount redoes this on recreate.
        editorRef.current = null;
        return;
      }
      modelRef.current = model;

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current(editor.getValue());
      });

      editor.onDidChangeModelContent(() => {
        onChangeRef.current(editor.getValue());
      });
    },
    []
  );

  // `content` is deliberately not a dep: Monaco owns the buffer after mount,
  // and setModel() on every keystroke would reset the cursor.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor == null) return; // onMount handles the initial setup

    const language = extensionToMonacoLanguage(filename);
    const uri = monaco.Uri.file(filePath);

    let model = monaco.editor.getModel(uri);
    if (model == null) {
      model = monaco.editor.createModel(contentRef.current, language, uri);
    } else {
      monaco.editor.setModelLanguage(model, language);
    }

    if (modelRef.current !== model) {
      // Refresh a cached model only on the swap; every render would fight the
      // cursor.
      syncModelValue(model, contentRef.current);
      modelRef.current = model;
      try {
        editor.setModel(model);
      } catch {
        // Disposed between renders; onMount redoes this on recreate.
        editorRef.current = null;
      }
    }
  }, [filePath, filename]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    monaco.editor.setTheme(isDark ? "vs-dark" : "vs");
  }, [isDark]);

  const language = extensionToMonacoLanguage(filename);

  return (
    <MonacoEditor
      key={instanceKey}
      data-id="monaco-file-editor"
      height="100%"
      language={language}
      defaultValue={content}
      theme={isDark ? "vs-dark" : "vs"}
      onMount={handleEditorDidMount}
      options={{
        readOnly,
        fontSize: 13,
        fontFamily:
          '"JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace',
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: "off",
        lineNumbers: "on",
        renderWhitespace: "selection",
        tabSize: 2,
        automaticLayout: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        padding: { top: 8, bottom: 8 },
      }}
    />
  );
};
