/**
 * In-tab shell backend for Aurora's Files → Terminal pane (WASM cannot fork/pty).
 * Line-buffered command runner over a virtual filesystem.
 */

export type AuroraShellSession = {
  write: (bytes: Uint8Array) => void;
  read: (dest: Uint8Array) => number;
  poll: () => number;
  resize: (cols: number, rows: number) => void;
  close: () => void;
};

type DirEnt = { kind: "dir" | "file"; name: string; content?: string };

function defaultFs(): Map<string, DirEnt[]> {
  const fs = new Map<string, DirEnt[]>();
  fs.set("/home/web_user", [
    { kind: "dir", name: "Documents" },
    { kind: "dir", name: "Downloads" },
    { kind: "file", name: "README.txt", content: "AgentOS web shell · type help\n" },
  ]);
  fs.set("/home/web_user/Documents", [{ kind: "file", name: "notes.txt", content: "hello from Aurora Files\n" }]);
  fs.set("/home/web_user/Downloads", []);
  fs.set("/tmp", []);
  return fs;
}

function norm(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function join(cwd: string, path: string): string {
  if (path.startsWith("/")) return norm(path);
  return norm(cwd.replace(/\/$/, "") + "/" + path);
}

export function createAuroraShellSession(opts?: { cwd?: string; cols?: number; rows?: number }): AuroraShellSession {
  const fs = defaultFs();
  let cwd = norm(opts?.cwd || "/home/web_user");
  let cols = opts?.cols || 80;
  let rows = opts?.rows || 24;
  let line = "";
  const outbound: number[] = [];
  let closed = false;

  const pushText = (text: string) => {
    for (let i = 0; i < text.length; i += 1) outbound.push(text.charCodeAt(i) & 0xff);
  };

  const prompt = () => pushText(`web:${cwd}$ `);

  const listDir = (path: string): DirEnt[] => fs.get(path) || [];

  const ensureDir = (path: string) => {
    if (!fs.has(path)) fs.set(path, []);
  };

  const findEnt = (path: string): { parent: string; ent: DirEnt | null } => {
    const p = norm(path);
    if (p === "/") return { parent: "/", ent: { kind: "dir", name: "" } };
    const parent = norm(p.split("/").slice(0, -1).join("/") || "/");
    const name = p.split("/").pop()!;
    const ent = listDir(parent).find((e) => e.name === name) || null;
    return { parent, ent };
  };

  const run = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const [cmd, ...args] = trimmed.split(/\s+/);
    switch (cmd) {
      case "help":
        pushText(
          "commands: help pwd cd ls cat echo mkdir touch rm clear uname date whoami env true false\n" +
            "this is the Aurora web shell (no host fork/pty). busybox/firefox are separate X clients.\n",
        );
        break;
      case "pwd":
        pushText(cwd + "\n");
        break;
      case "cd": {
        const target = join(cwd, args[0] || "/home/web_user");
        const { ent } = findEnt(target);
        if (target === "/" || (ent && ent.kind === "dir") || fs.has(target)) {
          ensureDir(target === "/" ? "/" : target);
          cwd = target === "/" ? "/" : target;
        } else pushText(`cd: ${args[0]}: No such directory\n`);
        break;
      }
      case "ls": {
        const target = join(cwd, args[0] || ".");
        const entries = fs.get(target);
        if (!entries && !findEnt(target).ent) {
          pushText(`ls: ${args[0] || "."}: No such file or directory\n`);
          break;
        }
        const list = entries || [];
        pushText(list.map((e) => (e.kind === "dir" ? e.name + "/" : e.name)).join("  ") + (list.length ? "\n" : "\n"));
        break;
      }
      case "cat": {
        if (!args[0]) {
          pushText("cat: missing file\n");
          break;
        }
        const target = join(cwd, args[0]);
        const { ent } = findEnt(target);
        if (!ent || ent.kind !== "file") pushText(`cat: ${args[0]}: No such file\n`);
        else pushText(ent.content || "");
        break;
      }
      case "echo":
        pushText(args.join(" ") + "\n");
        break;
      case "mkdir": {
        if (!args[0]) {
          pushText("mkdir: missing operand\n");
          break;
        }
        const target = join(cwd, args[0]);
        const { parent, ent } = findEnt(target);
        if (ent) {
          pushText(`mkdir: ${args[0]}: File exists\n`);
          break;
        }
        ensureDir(parent);
        const name = target.split("/").pop()!;
        listDir(parent).push({ kind: "dir", name });
        ensureDir(target);
        break;
      }
      case "touch": {
        if (!args[0]) {
          pushText("touch: missing operand\n");
          break;
        }
        const target = join(cwd, args[0]);
        const { parent, ent } = findEnt(target);
        ensureDir(parent);
        if (!ent) {
          const name = target.split("/").pop()!;
          listDir(parent).push({ kind: "file", name, content: "" });
        }
        break;
      }
      case "rm": {
        if (!args[0]) {
          pushText("rm: missing operand\n");
          break;
        }
        const target = join(cwd, args[0]);
        const { parent, ent } = findEnt(target);
        if (!ent) {
          pushText(`rm: ${args[0]}: No such file\n`);
          break;
        }
        fs.set(
          parent,
          listDir(parent).filter((e) => e.name !== ent.name),
        );
        if (ent.kind === "dir") fs.delete(target);
        break;
      }
      case "clear":
        pushText("\x1b[2J\x1b[H");
        break;
      case "uname":
        pushText("AgentOS web " + (args.includes("-a") ? "wasm x11 aurora-shell\n" : "wasm\n"));
        break;
      case "date":
        pushText(new Date().toString() + "\n");
        break;
      case "whoami":
        pushText("web_user\n");
        break;
      case "env":
      case "printenv":
        pushText("HOME=/home/web_user\nUSER=web_user\nSHELL=aurora-web\nTERM=xterm-256color\n");
        break;
      case "true":
        break;
      case "false":
        pushText("false\n");
        break;
      default:
        pushText(`${cmd}: command not found\n`);
        pushText("type `help` for built-ins (web shell; no host processes)\n");
    }
  };

  pushText("Aurora web shell — Files terminal (WASM)\r\n");
  pushText("Type commands, e.g. ls, pwd, cat README.txt, help\r\n");
  prompt();

  return {
    write(bytes) {
      if (closed) return;
      for (let i = 0; i < bytes.length; i += 1) {
        const c = bytes[i]!;
        if (c === 0x0d || c === 0x0a) {
          pushText("\r\n");
          run(line);
          line = "";
          prompt();
        } else if (c === 0x7f || c === 0x08) {
          if (line.length) {
            line = line.slice(0, -1);
            pushText("\b \b");
          }
        } else if (c === 0x03) {
          pushText("^C\r\n");
          line = "";
          prompt();
        } else if (c >= 0x20 && c < 0x7f) {
          line += String.fromCharCode(c);
          pushText(String.fromCharCode(c));
        }
      }
    },
    read(dest) {
      if (outbound.length === 0 || dest.byteLength === 0) return 0;
      const n = Math.min(dest.byteLength, outbound.length);
      for (let i = 0; i < n; i += 1) dest[i] = outbound.shift()!;
      return n;
    },
    poll() {
      return outbound.length;
    },
    resize(c, r) {
      cols = c;
      rows = r;
      void cols;
      void rows;
    },
    close() {
      closed = true;
      outbound.length = 0;
    },
  };
}
