// Wraps a status-bar HTMLElement and reflects server state with a colored dot.

type State =
  | { kind: "off" }
  | { kind: "listening"; port: number }
  | { kind: "connected"; port: number; clients: number };

export class StatusBar {
  private state: State = { kind: "off" };

  constructor(private readonly el: HTMLElement) {
    el.addClass("claude-code-ide-status-bar");
    this.render();
  }

  setListening(port: number): void {
    this.state = { kind: "listening", port };
    this.render();
  }

  setConnected(port: number, clients: number): void {
    this.state = { kind: "connected", port, clients };
    this.render();
  }

  setOff(): void {
    this.state = { kind: "off" };
    this.render();
  }

  private render(): void {
    this.el.empty();
    this.el.removeClass("is-listening", "is-connected");
    const dot = this.el.createSpan({ cls: "ccide-dot" });
    void dot;
    let label = "Claude IDE: off";
    if (this.state.kind === "listening") {
      this.el.addClass("is-listening");
      label = `Claude IDE: listening :${this.state.port}`;
    } else if (this.state.kind === "connected") {
      this.el.addClass("is-connected");
      label = `Claude IDE: connected · ${this.state.clients} client${
        this.state.clients === 1 ? "" : "s"
      }`;
    }
    this.el.createSpan({ text: label });
  }
}
