import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { RpcRouter, buildNotification, JsonValue } from "./rpc-router";

const AUTH_HEADER = "x-claude-code-ide-authorization";

export interface WsServerEvents {
  onListening?: (port: number) => void;
  onConnect?: (id: number) => void;
  onDisconnect?: (id: number) => void;
  onError?: (err: Error) => void;
}

export class IdeWsServer {
  private http?: http.Server;
  private wss?: WebSocketServer;
  private clients = new Map<number, WebSocket>();
  private nextClientId = 1;
  private port = 0;

  constructor(
    private readonly router: RpcRouter,
    private readonly authToken: string,
    private readonly events: WsServerEvents = {},
  ) {}

  async start(): Promise<number> {
    const server = http.createServer();
    this.http = server;
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    // Auth-gated upgrade. Claude Code sends the token in a custom header,
    // matching how every official IDE host validates it.
    server.on("upgrade", (req, socket, head) => {
      const presented = req.headers[AUTH_HEADER];
      if (typeof presented !== "string" || presented !== this.authToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    wss.on("connection", (ws) => this.onConnection(ws));
    wss.on("error", (err) => this.events.onError?.(err));
    server.on("error", (err) => this.events.onError?.(err));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Server failed to bind a port");
    }
    this.port = addr.port;
    this.events.onListening?.(this.port);
    return this.port;
  }

  async stop(): Promise<void> {
    for (const ws of this.clients.values()) {
      try {
        ws.close(1001, "Server shutting down");
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    if (this.wss) {
      await new Promise<void>((resolve) =>
        this.wss!.close(() => resolve()),
      );
      this.wss = undefined;
    }
    if (this.http) {
      await new Promise<void>((resolve) =>
        this.http!.close(() => resolve()),
      );
      this.http = undefined;
    }
  }

  getPort(): number {
    return this.port;
  }

  clientCount(): number {
    return this.clients.size;
  }

  broadcast(method: string, params?: JsonValue): void {
    if (this.clients.size === 0) return;
    const payload = buildNotification(method, params);
    for (const ws of this.clients.values()) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  private onConnection(ws: WebSocket): void {
    const id = this.nextClientId++;
    this.clients.set(id, ws);
    this.events.onConnect?.(id);

    ws.on("message", async (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const response = await this.router.handle(text);
      if (response && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(response));
      }
    });

    ws.on("close", () => {
      this.clients.delete(id);
      this.events.onDisconnect?.(id);
    });

    ws.on("error", (err) => this.events.onError?.(err));
  }
}
