/** Persisted IDE layout: pointer/keyboard splitters, panel visibility, docking, and command palette. */
type Preferences = { sidebar: number; agent: number; terminal: number; sidebarVisible: boolean; agentVisible: boolean; terminalVisible: boolean; agentLeft: boolean };
type Command = { label: string; run: () => void; enabled?: () => boolean };
const defaults: Preferences = { sidebar: 230, agent: 320, terminal: 220, sidebarVisible: true, agentVisible: true, terminalVisible: true, agentLeft: false };
const key = "relay.layout.v1";
const element = (id: string) => document.getElementById(id)!;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

export class Layout {
  private prefs = { ...defaults };
  private mobile = matchMedia("(max-width: 900px)");
  private mobileSidebar = false;
  private mobileAgent = false;
  private maximized = false;
  constructor() {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
      for (const name of ["sidebar", "agent", "terminal"] as const) if (typeof stored[name] === "number" && Number.isFinite(stored[name])) this.prefs[name] = clamp(stored[name], 100, 900);
      for (const name of ["sidebarVisible", "agentVisible", "terminalVisible", "agentLeft"] as const) if (typeof stored[name] === "boolean") this.prefs[name] = stored[name];
    } catch { /* Storage may be unavailable; the layout still works for this session. */ }
    for (const id of ["toggle-sidebar", "activity-explorer"]) element(id).onclick = () => this.toggle("sidebar");
    for (const id of ["toggle-agent", "activity-agent", "close-agent"]) element(id).onclick = () => this.toggle("agent");
    for (const id of ["toggle-terminal", "activity-terminal", "close-terminal"]) element(id).onclick = () => this.toggle("terminal");
    element("activity-workspaces").onclick = () => {
      if (this.mobile.matches) this.mobileSidebar = true; else this.prefs.sidebarVisible = true;
      (element("workspace-section") as HTMLDetailsElement).open = true;
      this.render(); this.save(); element("new-workspace").focus();
    };
    element("maximize-terminal").onclick = () => { this.maximized = !this.maximized; this.render(); };
    element("move-agent").onclick = () => { this.prefs.agentLeft = !this.prefs.agentLeft; this.render(); this.save(); };
    element("reset-layout").onclick = () => this.reset();
    this.splitter("sidebar", "sidebar-resizer", false, () => 1);
    this.splitter("agent", "agent-resizer", false, () => this.prefs.agentLeft ? 1 : -1);
    this.splitter("terminal", "terminal-resizer", true, () => -1);
    this.mobile.addEventListener("change", () => { this.mobileSidebar = false; this.mobileAgent = false; this.render(); });
    window.addEventListener("resize", () => this.render());
    new ResizeObserver(() => this.render()).observe(element("code-column"));
    window.addEventListener("keydown", event => {
      if (element("app").classList.contains("task-mode")) return;
      if (document.querySelector("dialog[open]") || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() === "b") { event.preventDefault(); this.toggle("sidebar"); }
      if (event.key.toLowerCase() === "j") { event.preventDefault(); this.toggle("terminal"); }
    });
    this.render();
  }
  toggle(panel: "sidebar" | "agent" | "terminal"): void {
    if (this.mobile.matches && panel === "sidebar") this.mobileSidebar = !this.mobileSidebar;
    else if (this.mobile.matches && panel === "agent") this.mobileAgent = !this.mobileAgent;
    else { const name = `${panel}Visible` as const; this.prefs[name] = !this.prefs[name]; }
    if (panel === "terminal") this.maximized = false;
    this.render(); this.save();
  }
  revealTerminal(): void { this.prefs.terminalVisible = true; this.render(); this.save(); }
  closeMobileSidebar(): void { if (this.mobile.matches) { this.mobileSidebar = false; this.render(); } }
  reset(): void { this.prefs = { ...defaults }; this.maximized = false; this.mobileSidebar = false; this.mobileAgent = false; this.render(); this.save(); }
  private save(): void { try { localStorage.setItem(key, JSON.stringify(this.prefs)); } catch { /* Optional persistence. */ } }
  private limits(panel: "sidebar" | "agent" | "terminal"): [number, number] {
    if (panel === "sidebar") return [150, Math.min(500, window.innerWidth - 560)];
    if (panel === "agent") return [220, Math.min(600, element("studio").clientWidth - 244)];
    return [100, Math.max(100, element("code-column").clientHeight - 140)];
  }
  private render(): void {
    const app = element("app");
    const sidebar = this.mobile.matches ? this.mobileSidebar : this.prefs.sidebarVisible;
    const agent = this.mobile.matches ? this.mobileAgent : this.prefs.agentVisible;
    app.classList.toggle("sidebar-hidden", !sidebar);
    app.classList.toggle("agent-hidden", !agent);
    app.classList.toggle("terminal-hidden", !this.prefs.terminalVisible);
    app.classList.toggle("terminal-maximized", this.maximized && this.prefs.terminalVisible);
    app.classList.toggle("agent-left", this.prefs.agentLeft);
    for (const panel of ["sidebar", "agent", "terminal"] as const) {
      const [min, max] = this.limits(panel);
      const value = this.mobile.matches && panel !== "terminal" ? this.prefs[panel] : clamp(this.prefs[panel], min, max);
      app.style.setProperty(`--${panel}-${panel === "terminal" ? "height" : "width"}`, `${value}px`);
      const handle = element(`${panel}-resizer`);
      handle.setAttribute("aria-valuemin", String(min)); handle.setAttribute("aria-valuemax", String(Math.max(min, max))); handle.setAttribute("aria-valuenow", String(value));
    }
    for (const [ids, pressed] of [[["toggle-sidebar", "activity-explorer"], sidebar], [["toggle-agent", "activity-agent"], agent], [["toggle-terminal", "activity-terminal"], this.prefs.terminalVisible]] as const) {
      for (const id of ids) element(id).setAttribute("aria-pressed", String(pressed));
    }
    const maximize = element("maximize-terminal");
    maximize.setAttribute("aria-pressed", String(this.maximized));
    maximize.setAttribute("aria-label", this.maximized ? "Restore terminal" : "Maximize terminal");
    maximize.title = this.maximized ? "Restore terminal" : "Maximize terminal";
  }
  private splitter(panel: "sidebar" | "agent" | "terminal", id: string, verticalMotion: boolean, direction: () => number): void {
    const handle = element(id);
    let drag: { pointer: number; start: number; value: number } | undefined;
    const set = (value: number) => { const [min, max] = this.limits(panel); this.prefs[panel] = clamp(value, min, max); this.render(); };
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
      drag = { pointer: event.pointerId, start: verticalMotion ? event.clientY : event.clientX, value: Number(handle.getAttribute("aria-valuenow")) };
      document.body.classList.add("resizing"); handle.classList.add("dragging");
    });
    handle.addEventListener("pointermove", event => { if (drag?.pointer === event.pointerId) set(drag.value + ((verticalMotion ? event.clientY : event.clientX) - drag.start) * direction()); });
    const finish = () => { if (!drag) return; drag = undefined; document.body.classList.remove("resizing"); handle.classList.remove("dragging"); this.save(); };
    handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", finish); handle.addEventListener("lostpointercapture", finish);
    handle.addEventListener("dblclick", () => { set(defaults[panel]); this.save(); });
    handle.addEventListener("keydown", event => {
      const decrease = verticalMotion ? "ArrowUp" : "ArrowLeft", increase = verticalMotion ? "ArrowDown" : "ArrowRight";
      if (![decrease, increase, "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const [min, max] = this.limits(panel);
      set(event.key === "Home" ? min : event.key === "End" ? max : Number(handle.getAttribute("aria-valuenow")) + (event.key === increase ? 1 : -1) * direction() * (event.shiftKey ? 40 : 10)); this.save();
    });
  }
}

export function commandPalette(commands: Command[]): void {
  const dialog = element("palette") as HTMLDialogElement, input = element("command-search") as HTMLInputElement, results = element("command-results");
  let index = 0, filtered: Command[] = [];
  const render = () => {
    filtered = commands.filter(command => (!command.enabled || command.enabled()) && command.label.toLowerCase().includes(input.value.toLowerCase()));
    index = Math.min(index, Math.max(0, filtered.length - 1)); results.replaceChildren();
    filtered.forEach((command, i) => {
      const button = document.createElement("button"); button.textContent = command.label; button.classList.toggle("selected", i === index);
      button.onclick = () => { dialog.close(); command.run(); }; results.append(button);
    });
    if (!filtered.length) { const message = document.createElement("p"); message.textContent = "No matching commands"; results.append(message); }
    results.children[index]?.scrollIntoView({ block: "nearest" });
  };
  const open = () => { if (document.querySelector("dialog[open]")) return; index = 0; input.value = ""; dialog.showModal(); render(); input.focus(); };
  element("command-button").onclick = open; element("welcome-commands").onclick = open;
  input.addEventListener("input", () => { index = 0; render(); });
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); index = (index + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % (filtered.length || 1); render(); }
    if (event.key === "Enter" && filtered[index]) { event.preventDefault(); dialog.close(); filtered[index].run(); }
  });
  window.addEventListener("keydown", event => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); open(); } });
}
