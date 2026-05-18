import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const IDE_DIR = path.join(os.homedir(), ".claude", "ide");

export interface LockfileShape {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: "ws";
  runningInWindows: boolean;
  authToken: string;
}

export class LockfileManager {
  private currentPath?: string;

  constructor(
    private readonly ideName: string,
    private readonly workspaceFolders: string[],
  ) {}

  write(port: number, authToken: string): string {
    fs.mkdirSync(IDE_DIR, { recursive: true, mode: 0o700 });
    const filePath = path.join(IDE_DIR, `${port}.lock`);
    const payload: LockfileShape = {
      pid: process.pid,
      workspaceFolders: this.workspaceFolders,
      ideName: this.ideName,
      transport: "ws",
      runningInWindows: process.platform === "win32",
      authToken,
    };
    // Live VS Code lockfiles use compact JSON, no trailing newline.
    fs.writeFileSync(filePath, JSON.stringify(payload), { mode: 0o600 });
    this.currentPath = filePath;
    return filePath;
  }

  cleanup(): void {
    if (!this.currentPath) return;
    try {
      fs.rmSync(this.currentPath, { force: true });
    } catch {
      // ignore — best-effort
    }
    this.currentPath = undefined;
  }

  getCurrentPath(): string | undefined {
    return this.currentPath;
  }

  static directory(): string {
    return IDE_DIR;
  }
}
