/** CodeMirror IDE editor: syntax highlighting, search, line numbers, history, and save shortcut. */
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";

export class CodeEditor {
  private view: EditorView;
  private path = "";
  private states = new Map<string, EditorState>();
  constructor(parent: HTMLElement, private changed: (content: string) => void, private save: () => void) {
    this.view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: [oneDark] }) });
  }
  open(path: string, content: string): void {
    if (this.path) this.states.set(this.path, this.view.state);
    this.path = path;
    const cached = this.states.get(path);
    if (cached?.doc.toString() === content) { this.view.setState(cached); return; }
    const suffix = path.split(".").pop();
    const language: Extension = ["js","jsx","ts","tsx","mjs","cjs"].includes(suffix ?? "") ? javascript({ typescript: suffix === "ts" || suffix === "tsx", jsx: suffix === "jsx" || suffix === "tsx" })
      : suffix === "json" ? json() : suffix === "html" ? html() : suffix === "css" ? css() : suffix === "md" ? markdown() : [];
    this.view.setState(EditorState.create({ doc: content, extensions: [basicSetup, oneDark, language,
      keymap.of([{ key: "Mod-s", run: () => { this.save(); return true; } }]),
      EditorView.updateListener.of(update => { if (update.docChanged) this.changed(update.state.doc.toString()); }),
      Prec.highest(EditorView.theme({ "&": { height: "100%", fontSize: "13px", backgroundColor: "#1e1e1e", color: "#d4d4d4" }, ".cm-scroller": { overflow: "auto", fontFamily: "'Cascadia Code', 'SFMono-Regular', Consolas, monospace" }, ".cm-gutters": { backgroundColor: "#1e1e1e", color: "#858585", border: "none" }, ".cm-activeLine": { backgroundColor: "#ffffff04" }, ".cm-activeLineGutter": { backgroundColor: "#1e1e1e", color: "#c6c6c6" }, ".cm-cursor": { borderLeftColor: "#aeafad" }, "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#264f78" } })),
    ] }));
  }
  focus(): void { this.view.focus(); }
  forget(path: string): void { this.states.delete(path); if (this.path === path) this.path = ""; }
  clear(): void { this.path = ""; this.states.clear(); }
}
