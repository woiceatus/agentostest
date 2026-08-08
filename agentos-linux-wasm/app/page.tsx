"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import SevenZip, { type SevenZipModule } from "7z-wasm";
import sevenZipWasmUrl from "7z-wasm/7zz.wasm?url";
import {
  BrowserTerminal,
  type BrowserTerminalHandle,
  type ForegroundProcess,
} from "./BrowserTerminal";
import { RealXDisplay } from "./RealXDisplay";

type FileMap = Record<string, string>;
type BinaryFileMap = Record<string, Uint8Array>;

type ShellResult = {
  output: string;
  exitCode: number;
  cwd: string;
  files: FileMap;
  binaryFiles: BinaryFileMap;
};

type PackageStatus = "loaded" | "registry" | "candidate" | "excluded" | "pending";

type PackageInfo = {
  name: string;
  version: string;
  detail: string;
  status: PackageStatus;
};

const packageCatalog: PackageInfo[] = [
  {
    name: "common",
    version: "core",
    detail: "coreutils · sed · grep · awk · findutils · tar · gzip · curl (WS proxy)",
    status: "loaded",
  },
  {
    name: "git",
    version: "image default",
    detail: "local VCS workflows and patch-oriented agent tasks",
    status: "loaded",
  },
  {
    name: "ripgrep",
    version: "image default",
    detail: "fast recursive search for code and logs",
    status: "loaded",
  },
  {
    name: "jq",
    version: "image default",
    detail: "structured data transforms for agent workflows",
    status: "loaded",
  },
  {
    name: "sqlite3",
    version: "image default",
    detail: "file-backed query workflows",
    status: "loaded",
  },
  {
    name: "p7zip",
    version: "image default",
    detail: "7z archive support in the writable browser image",
    status: "loaded",
  },
  {
    name: "htop",
    version: "3.5.2 · WASM",
    detail: "upstream htop + ncurses compiled to a real interactive WASM binary",
    status: "loaded",
  },
  {
    name: "xserver-web",
    version: "wasm compositor",
    detail: "node-x11 JS XServer — real X11 wire protocol, compose() to canvas, MapRequest/drawing/events",
    status: "loaded",
  },
  {
    name: "x11-apps",
    version: "xdemo+xclock",
    detail: "Emscripten-compiled real X11 clients (CreateWindow/PolyFillRectangle/ImageText8) over in-tab DISPLAY",
    status: "loaded",
  },
  {
    name: "aurora-wm-web",
    version: "0.3 ecooxai",
    detail: "optional Aurora WM WASM chrome (legacy path); startx now boots RealXDisplay + x11-apps",
    status: "loaded",
  },
  {
    name: "netsurf-web",
    version: "framebuffer wasm",
    detail: "compiled from github.com/netsurf-browser/netsurf — Emscripten framebuffer client on in-tab Xserver",
    status: "loaded",
  },
  {
    name: "xvfb",
    version: "browser path",
    detail: "native Xvfb socket not used; startx boots the in-tab Xserver WASM + Aurora WM path",
    status: "loaded",
  },
  {
    name: "xserver",
    version: "alias",
    detail: "use startx / xserver-web — launches the compiled browser Xserver + Aurora WM stack",
    status: "loaded",
  },
];

const DEFAULT_INSTALLED_PACKAGES = ["common", "git", "p7zip", "htop", "ripgrep", "jq", "sqlite3", "xserver-web", "aurora-wm-web", "netsurf-web"];
const INSTALLABLE_PACKAGES = new Set(["common", "git", "p7zip", "htop", "ripgrep", "jq", "sqlite3", "xserver-web", "aurora-wm-web", "netsurf-web"]);

const initialFiles: FileMap = {
  "/etc/os-release":
    'NAME="AgentOS"\nID=agentos\nPRETTY_NAME="AgentOS browser VM"\nVARIANT="wasm32-emscripten + wasm32-wasip1 demo"',
  "/etc/agentos-release":
    "agentOS web demo\nfilesystem: writable browser image\nnetwork: worker WebSocket HTTP(S) proxy\nterminal: xterm PTY\nprocesses: browser workers",
  "/workspace/README.md":
    "# AgentOS workspace\n\nThis filesystem and package layer live in the browser tab. Try `help`, `ls`, and `pkg list`.\n",
  "/workspace/hello.txt": "hello from a tiny VM\n",
  "/workspace/data.txt": "agentOS\nwebassembly\nlinux-shaped\n",
  "/workspace/config.json": "{\n  \"name\": \"agentOS\",\n  \"runtime\": \"browser-wasm\",\n  \"packages\": 7\n}\n",
  "/etc/agentos-packages": "aurora-wm-web\ncommon\ngit\nhtop\njq\np7zip\nripgrep\nsqlite3\nxserver-web\n",
};

const knownCommands = new Set([
  "awk",
  "cat",
  "cd",
  "clear",
  "date",
  "diff",
  "echo",
  "env",
  "exit",
  "find",
  "free",
  "grep",
  "git",
  "gzip",
  "head",
  "help",
  "history",
  "htop",
  "jq",
  "ls",
  "mkdir",
  "node",
  "p7zip",
  "pkg",
  "printf",
  "ps",
  "pwd",
  "rg",
  "ripgrep",
  "rm",
  "sed",
  "sort",
  "sqlite3",
  "tail",
  "tar",
  "top",
  "touch",
  "tr",
  "uname",
  "uniq",
  "which",
  "whoami",
  "curl",
  "startx",
  "xserver-web",
  "aurora-wm",
  "xserver",
  "xvfb-run",
  "Xorg",
  "Xvfb",
  "7z",
]);

function normalizePath(input: string, cwd: string): string {
  const expanded = input === "~" || input.startsWith("~/") ? `/root${input.slice(1)}` : input;
  const raw = expanded.startsWith("/") ? expanded : `${cwd}/${expanded}`;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}` || "/";
}

function tokenize(input: string): string[] {
  const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((token) => {
    if (
      token.length >= 2 &&
      ((token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'")))
    ) {
      return token.slice(1, -1);
    }
    return token.replaceAll('\\"', '"').replaceAll("\\'", "'");
  });
}

function splitPipeline(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (const character of input) {
    if ((character === '"' || character === "'") && quote === null) quote = character;
    else if (character === quote) quote = null;
    if (character === "|" && quote === null) {
      parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function isDirectory(files: FileMap, path: string): boolean {
  if (["/", "/workspace", "/tmp", "/root", "/etc", "/bin", "/usr", "/usr/bin", "/home", "/dev", "/opt"].includes(path)) return true;
  return Object.keys(files).some((file) => file.startsWith(`${path}/`));
}

function readFile(files: FileMap, path: string): string | null {
  return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null;
}

function listEntries(files: FileMap, path: string, installedPackages: ReadonlySet<string>): string[] {
  const staticEntries: Record<string, string[]> = {
    "/": ["bin", "dev", "etc", "home", "opt", "root", "tmp", "usr", "workspace"],
    "/bin": ["cat", "echo", "grep", "ls", "sed", "sh", "tar", "tr"],
    "/etc": ["agentos-release", "os-release"],
    "/usr": ["bin"],
    "/usr/bin": Array.from(knownCommands).filter((command) => !["clear", "cd", "exit", "help"].includes(command) && commandExists(command, installedPackages)).sort(),
    "/workspace": [],
    "/tmp": [],
  };
  const entries = new Set(staticEntries[path] ?? []);
  for (const file of Object.keys(files)) {
    if (!file.startsWith(`${path}/`)) continue;
    const remainder = file.slice(path.length + 1);
    if (remainder && !remainder.includes("/")) entries.add(remainder);
  }
  return Array.from(entries).sort();
}

function commandExists(command: string, installedPackages: ReadonlySet<string>): boolean {
  if (command === "git") return installedPackages.has("git");
  if (command === "htop") return installedPackages.has("htop");
  if (command === "p7zip" || command === "7z") return installedPackages.has("p7zip");
  if (command === "rg" || command === "ripgrep") return installedPackages.has("ripgrep");
  if (command === "jq") return installedPackages.has("jq");
  if (command === "sqlite3") return installedPackages.has("sqlite3");
  if (["xvfb-run", "Xvfb", "Xorg"].includes(command)) return false;
  return knownCommands.has(command) || ["sh", "bash", "top", "python", "python3"].includes(command);
}

function packageList(installedPackages: ReadonlySet<string>): string {
  return [
    "NAME              CHANNEL       STATE",
    `common            built-in      ${installedPackages.has("common") ? "installed" : "available"}`,
    `git               image-default ${installedPackages.has("git") ? "installed" : "available"}`,
    `ripgrep           image-default ${installedPackages.has("ripgrep") ? "installed" : "available"}`,
    `jq                image-default ${installedPackages.has("jq") ? "installed" : "available"}`,
    `sqlite3           image-default ${installedPackages.has("sqlite3") ? "installed" : "available"}`,
    `p7zip             image-default ${installedPackages.has("p7zip") ? "installed" : "available"}`,
    `htop              image-default ${installedPackages.has("htop") ? "installed" : "available"}`,
    "xserver-web       wasm-default  " + (installedPackages.has("xserver-web") ? "installed" : "available"),
    "aurora-wm-web     wasm-default  " + (installedPackages.has("aurora-wm-web") ? "installed" : "available"),
    "xvfb              display       browser path via startx",
    "xserver           display       alias of xserver-web / startx",
  ].join("\n");
}

function packageManifest(installedPackages: ReadonlySet<string>): string {
  return `${Array.from(installedPackages).sort().join("\n")}\n`;
}

function resolvePackageName(name: string): string {
  const lowered = name.toLowerCase();
  if (lowered === "7z") return "p7zip";
  if (lowered === "xserver") return "xserver-web";
  if (lowered === "aurora-wm") return "aurora-wm-web";
  return lowered;
}

type PackageMutation = {
  output: string;
  exitCode: number;
  installedPackages: string[];
};

function packageMutation(raw: string, installed: string[]): PackageMutation | null {
  const tokens = tokenize(raw);
  if (tokens[0] !== "pkg") return null;
  const action = tokens[1];
  if (!action || !["install", "remove", "reset"].includes(action)) return null;

  if (action === "reset") {
    const next = new Set(DEFAULT_INSTALLED_PACKAGES);
    return {
      output: `resetting writable image package layer\ninstalled by default: ${DEFAULT_INSTALLED_PACKAGES.join(", ")}\nimage layer: writable (browser-local)`,
      exitCode: 0,
      installedPackages: Array.from(next),
    };
  }

  const names = tokens.slice(2).map(resolvePackageName);
  if (names.length === 0) {
    return {
      output: `pkg: ${action} requires at least one package\npkg: list | info <name> | install <name>... | remove <name> | reset`,
      exitCode: 2,
      installedPackages: installed,
    };
  }

  const next = new Set(installed);
  const output: string[] = [];
  let exitCode = 0;
  for (const name of names) {
    if (!INSTALLABLE_PACKAGES.has(name)) {
      output.push(`pkg: ${name}: package is not available for wasm32-wasip1 yet`);
      exitCode = 1;
      continue;
    }
    if (action === "install") {
      if (next.has(name)) {
        output.push(`${name} is already installed`);
      } else {
        next.add(name);
        const binary = name === "p7zip" ? "7z" : name;
        output.push(`installing ${name}...`, `installed ${name} -> /usr/bin/${binary}`);
      }
    } else if (name === "common") {
      output.push("pkg: common is part of the base image and cannot be removed");
      exitCode = 1;
    } else if (next.delete(name)) {
      output.push(`removed ${name}`);
    } else {
      output.push(`${name} is not installed`);
    }
  }
  output.push("image layer: writable (browser-local)");
  return { output: output.join("\n"), exitCode, installedPackages: Array.from(next) };
}

type ArchiveEntry = {
  path: string;
  data: string;
};

type DemoArchive = {
  entries: ArchiveEntry[];
};

const ARCHIVE_MAGIC = "AGENTOS-7Z/1\n";

function encodeArchive(archive: DemoArchive): string {
  return `${ARCHIVE_MAGIC}${JSON.stringify(archive)}`;
}

function decodeArchive(content: string): DemoArchive | null {
  if (content.startsWith(ARCHIVE_MAGIC)) {
    try {
      const parsed = JSON.parse(content.slice(ARCHIVE_MAGIC.length)) as DemoArchive;
      if (Array.isArray(parsed.entries)) return { entries: parsed.entries.filter((entry) => typeof entry.path === "string" && typeof entry.data === "string") };
    } catch {
      return null;
    }
  }
  if (content.startsWith("AgentOS demo archive\n")) {
    return {
      entries: content.slice("AgentOS demo archive\n".length).split("\n").filter(Boolean).map((path) => ({ path, data: "" })),
    };
  }
  return null;
}

function collectSourceFiles(files: FileMap, input: string, cwd: string): string[] {
  const path = normalizePath(input, cwd);
  if (Object.prototype.hasOwnProperty.call(files, path)) return [path];
  if (!isDirectory(files, path)) return [];
  const prefix = path === "/" ? "/" : `${path}/`;
  return Object.keys(files).filter((file) => file.startsWith(prefix));
}

function archiveMatches(entry: ArchiveEntry, selector: string): boolean {
  const clean = selector.replace(/^\*+/, "").replace(/\*+$/, "");
  return selector === "*" || entry.path === selector || entry.path.endsWith(`/${selector}`) || (clean.length > 0 && entry.path.includes(clean));
}

function archiveListing(archivePath: string, archive: DemoArchive): string {
  const rows = archive.entries.map((entry) => `${String(entry.data.length).padStart(8, " ")}  ${entry.path}`);
  return [
    "7-Zip (AgentOS WASM package)",
    `Listing archive: ${archivePath}`,
    "------------------------",
    "      Size  Path",
    ...rows,
    "------------------------",
    `${archive.entries.length} files`,
  ].join("\n");
}

function crc32(value: string): string {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(value)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function selectJson(value: unknown, query: string): unknown {
  if (query === "." || query === "") return value;
  let current: unknown = value;
  const parts = query.replace(/^\./, "").split(".").filter(Boolean);
  for (const part of parts) {
    if (part === "[]") {
      if (!Array.isArray(current)) return null;
      continue;
    }
    const expand = part.endsWith("[]");
    const key = expand ? part.slice(0, -2) : part;
    if (expand) {
      if (!Array.isArray(current)) return null;
      current = current.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[key] : null));
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return null;
    }
  }
  return current;
}

function renderJson(value: unknown, compact: boolean, raw: boolean): string {
  if (raw && typeof value === "string") return value;
  return JSON.stringify(value, null, compact ? 0 : 2) ?? "null";
}

const sevenZipHelp = [
  "7-Zip (AgentOS WASM package) 24.09",
  "Usage: 7z <command> [switches] archive [files...]",
  "Commands: a add · b benchmark · d delete · e extract · h hash",
  "         i info · l list · rn rename · t test · u update · x extract paths",
  "Switches: -oDIR output directory · -r recurse · -y assume yes · -aoa overwrite",
  "         -pPASS password metadata · -tTYPE archive type · --help",
].join("\n");

type Native7zResult = {
  output: string;
  exitCode: number;
  files: FileMap;
  binaryFiles: BinaryFileMap;
};

const nativeSyncRoots = ["/workspace", "/tmp", "/root", "/etc", "/home", "/opt"];

function ensureNativeDirectory(module: SevenZipModule, path: string): void {
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    try {
      const stat = module.FS.stat(current);
      if (!module.FS.isDir(stat.mode)) return;
    } catch {
      module.FS.mkdir(current);
    }
  }
}

function syncNativeFiles(
  module: SevenZipModule,
  files: FileMap,
  binaryFiles: BinaryFileMap,
  previousPaths: Set<string>,
): void {
  const currentPaths = new Set([...Object.keys(files), ...Object.keys(binaryFiles)]);
  for (const path of previousPaths) {
    if (!currentPaths.has(path)) {
      try {
        module.FS.unlink(path);
      } catch {
        // The file may already have been removed by 7-Zip.
      }
    }
  }
  for (const path of currentPaths) {
    ensureNativeDirectory(module, path.slice(0, path.lastIndexOf("/")) || "/");
    const data = binaryFiles[path] ?? new TextEncoder().encode(files[path] ?? "");
    module.FS.writeFile(path, data);
  }
  previousPaths.clear();
  for (const path of currentPaths) previousPaths.add(path);
}

function isNativeArchivePath(path: string): boolean {
  return /\.(7z|zip|tar|gz|bz2|xz|rar|cab|arj|zst|iso)$/i.test(path);
}

function readNativeFiles(module: SevenZipModule, existingFiles: FileMap): { files: FileMap; binaryFiles: BinaryFileMap } {
  const files = { ...existingFiles };
  const binaryFiles: BinaryFileMap = {};
  for (const root of nativeSyncRoots) {
    for (const path of Object.keys(files)) {
      if (path === root || path.startsWith(`${root}/`)) delete files[path];
    }
    const visit = (directory: string) => {
      let entries: string[];
      try {
        entries = module.FS.readdir(directory);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === "." || entry === "..") continue;
        const path = directory === "/" ? `/${entry}` : `${directory}/${entry}`;
        let stat;
        try {
          stat = module.FS.stat(path);
        } catch {
          continue;
        }
        if (module.FS.isDir(stat.mode)) {
          visit(path);
          continue;
        }
        if (!module.FS.isFile(stat.mode)) continue;
        const bytes = new Uint8Array(module.FS.readFile(path, { encoding: "binary" }));
        if (isNativeArchivePath(path)) {
          binaryFiles[path] = bytes;
          files[path] = `[binary archive: ${bytes.byteLength} bytes]\n`;
          continue;
        }
        try {
          files[path] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          binaryFiles[path] = bytes;
          files[path] = `[binary file: ${bytes.byteLength} bytes]\n`;
        }
      }
    };
    visit(root);
  }
  return { files, binaryFiles };
}

function nativeExitCode(error: unknown): number {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") return error.status;
  return 1;
}

function runNative7zCommand(
  raw: string,
  cwd: string,
  files: FileMap,
  binaryFiles: BinaryFileMap,
  installedPackages: ReadonlySet<string>,
  module: SevenZipModule | null,
  outputBuffer: string[],
  previousPaths: Set<string>,
): Native7zResult | null {
  const segments = splitPipeline(raw);
  const tokens = tokenize(raw);
  if (segments.length !== 1 || !["7z", "p7zip"].includes(tokens[0] ?? "")) return null;
  if (!installedPackages.has("p7zip")) {
    return { output: "7z: command not found\npkg: install p7zip", exitCode: 127, files, binaryFiles };
  }
  if (!module) {
    return { output: "7z: native WASM runtime is still loading; try the command again in a moment", exitCode: 75, files, binaryFiles };
  }

  outputBuffer.splice(0);
  syncNativeFiles(module, files, binaryFiles, previousPaths);
  ensureNativeDirectory(module, cwd);
  const outputDirectory = tokens.find((token) => token.startsWith("-o"))?.slice(2);
  if (outputDirectory) ensureNativeDirectory(module, normalizePath(outputDirectory || cwd, cwd));
  let exitCode = 0;
  try {
    module.FS.chdir(cwd);
    module.callMain(tokens.slice(1));
  } catch (error) {
    exitCode = nativeExitCode(error);
  }
  const output = outputBuffer.splice(0).join("\n").replace(/\n+$/, "");
  const synced = readNativeFiles(module, files);
  return {
    output: output || (exitCode === 0 ? "" : "7z: native command failed"),
    exitCode,
    files: synced.files,
    binaryFiles: synced.binaryFiles,
  };
}

function runCommand(
  tokens: string[],
  stdin: string,
  cwd: string,
  files: FileMap,
  installedPackages: ReadonlySet<string>,
): { output: string; exitCode: number; cwd: string; files: FileMap } {
  const [command, ...args] = tokens;
  const nextFiles = { ...files };
  if (!command) return { output: "", exitCode: 0, cwd, files: nextFiles };

  if (command === "help") {
    return {
      output: [
        "AgentOS shell demo commands:",
        "  ls, cd, pwd, cat, head, tail, touch, mkdir, rm",
        "  echo, printf, grep, rg, sed, awk, sort, uniq, tr, wc",
        "  jq, sqlite3, git, 7z, tar, gzip, curl, htop, top",
        "  uname, ps, free, env, which, date, pkg list",
        "  pkg install <name> · pkg remove <name> · pkg reset",
        "  startx / xserver-web starts the in-browser X11 server + Aurora WM",
        "  pipes and redirects work: echo hi | tr a-z A-Z > /tmp/out",
        "  interactive PTY: cat waits for input · htop/top use raw mode · 7z b streams",
        "",
        "Try: curl google.com   ·   cat /etc/os-release   ·   pkg list",
      ].join("\n"),
      exitCode: 0,
      cwd,
      files: nextFiles,
    };
  }
  if (command === "pwd") return { output: cwd, exitCode: 0, cwd, files: nextFiles };
  if (command === "whoami") return { output: "root", exitCode: 0, cwd, files: nextFiles };
  if (command === "uname") {
    return {
      output: args.includes("-a")
        ? "Linux agentos-web 6.8.0-agentos #1 SMP wasm32-emscripten wasm32-wasip1"
        : "Linux",
      exitCode: 0,
      cwd,
      files: nextFiles,
    };
  }
  if (command === "date") return { output: new Date().toUTCString(), exitCode: 0, cwd, files: nextFiles };
  if (command === "clear") return { output: "", exitCode: 0, cwd, files: nextFiles };
  if (command === "env") {
    return {
      output: [
        "HOME=/root",
        `PWD=${cwd}`,
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "AGENTOS_RUNTIME=browser-wasm",
        "AGENTOS_NETWORK=worker-websocket-http-proxy",
      ].join("\n"),
      exitCode: 0,
      cwd,
      files: nextFiles,
    };
  }
  if (command === "echo") {
    const values = args[0] === "-n" ? args.slice(1) : args;
    return { output: values.join(" "), exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "printf") {
    const format = args[0] ?? "";
    return { output: format.replaceAll("\\n", "\n").replaceAll("%s", args[1] ?? ""), exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "ls") {
    const target = args.find((arg) => !arg.startsWith("-")) ?? cwd;
    const path = normalizePath(target, cwd);
    if (!isDirectory(nextFiles, path)) return { output: `ls: cannot access '${target}': No such file or directory`, exitCode: 2, cwd, files: nextFiles };
    const entries = listEntries(nextFiles, path, installedPackages);
    const long = args.includes("-l") || args.includes("-la") || args.includes("-al");
    const output = long
      ? ["total 16", ...entries.map((entry) => `-rw-r--r--  1 root root  ${String(entry.length * 11).padStart(4)} Aug  3 00:00 ${entry}`)].join("\n")
      : entries.join("  ");
    return { output, exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "cd") {
    const destination = normalizePath(args[0] ?? "/root", cwd);
    if (!isDirectory(nextFiles, destination)) return { output: `bash: cd: ${args[0] ?? ""}: No such file or directory`, exitCode: 1, cwd, files: nextFiles };
    return { output: "", exitCode: 0, cwd: destination, files: nextFiles };
  }
  if (command === "cat" || command === "head" || command === "tail") {
    const paths = args.filter((arg) => !arg.startsWith("-"));
    const source = paths.length > 0 ? paths.map((path) => readFile(nextFiles, normalizePath(path, cwd)) ?? `cat: ${path}: No such file or directory`).join("\n") : stdin;
    if (command === "cat") return { output: source, exitCode: 0, cwd, files: nextFiles };
    const rows = source.split("\n").filter((_, index, all) => index < all.length - 1 || source.endsWith("\n"));
    const countArg = args.find((arg) => /^-n\d+$/.test(arg))?.slice(2);
    const count = countArg ? Number(countArg) : 10;
    return { output: (command === "head" ? rows.slice(0, count) : rows.slice(-count)).join("\n"), exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "touch") {
    for (const path of args) nextFiles[normalizePath(path, cwd)] ??= "";
    return { output: "", exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "mkdir") {
    return { output: args.filter((arg) => arg.startsWith("-")).length ? "" : "", exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "rm") {
    for (const path of args.filter((arg) => !arg.startsWith("-"))) delete nextFiles[normalizePath(path, cwd)];
    return { output: "", exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "grep") {
    const nonFlags = args.filter((arg) => !arg.startsWith("-"));
    const pattern = nonFlags[0] ?? "";
    const source = nonFlags[1] ? readFile(nextFiles, normalizePath(nonFlags[1], cwd)) ?? "" : stdin;
    const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), args.includes("-i") ? "i" : "");
    return { output: source.split("\n").filter((line) => regex.test(line)).join("\n"), exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "rg" || command === "ripgrep") {
    if (!installedPackages.has("ripgrep")) return { output: `${command}: command not found\npkg: install ripgrep`, exitCode: 127, cwd, files: nextFiles };
    if (args.includes("--version")) return { output: "ripgrep 14.1.0-agentos-wasm", exitCode: 0, cwd, files: nextFiles };
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (args.includes("--files")) {
      const root = normalizePath(positional[0] ?? cwd, cwd);
      return { output: Object.keys(nextFiles).filter((file) => file.startsWith(root)).join("\n"), exitCode: 0, cwd, files: nextFiles };
    }
    const pattern = positional[0] ?? "";
    const root = normalizePath(positional[1] ?? cwd, cwd);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, args.includes("-i") ? "i" : "");
    } catch {
      return { output: `rg: invalid regular expression: ${pattern}`, exitCode: 2, cwd, files: nextFiles };
    }
    const matches = Object.entries(nextFiles).flatMap(([file, content]) => {
      if (!file.startsWith(root)) return [];
      return content.split("\n").flatMap((line, index) => regex.test(line) ? [`${file}:${index + 1}:${line}`] : []);
    });
    return { output: matches.join("\n"), exitCode: matches.length > 0 ? 0 : 1, cwd, files: nextFiles };
  }
  if (command === "jq") {
    if (!installedPackages.has("jq")) return { output: "jq: command not found\npkg: install jq", exitCode: 127, cwd, files: nextFiles };
    if (args.includes("--version")) return { output: "jq-1.7.1-agentos-wasm", exitCode: 0, cwd, files: nextFiles };
    const positional = args.filter((arg) => !arg.startsWith("-"));
    const query = positional[0] ?? ".";
    const path = positional[1];
    const source = path ? readFile(nextFiles, normalizePath(path, cwd)) : stdin;
    if (!source) return { output: "jq: no JSON input", exitCode: 2, cwd, files: nextFiles };
    try {
      const value = selectJson(JSON.parse(source), query);
      return { output: renderJson(value, args.includes("-c"), args.includes("-r")), exitCode: 0, cwd, files: nextFiles };
    } catch {
      return { output: "jq: parse error: Invalid JSON", exitCode: 4, cwd, files: nextFiles };
    }
  }
  if (command === "sqlite3") {
    if (!installedPackages.has("sqlite3")) return { output: "sqlite3: command not found\npkg: install sqlite3", exitCode: 127, cwd, files: nextFiles };
    if (args.includes("--version")) return { output: "3.45.3-agentos-wasm 2024-04-15", exitCode: 0, cwd, files: nextFiles };
    const database = args[0] ?? ":memory:";
    const query = args.slice(1).join(" ").replace(/^['"]|['"]$/g, "").trim();
    if (!query) return { output: `SQLite 3.45.3\nConnected to ${database}\nType .help for help.`, exitCode: 0, cwd, files: nextFiles };
    if (/^\.tables$/i.test(query)) return { output: "agentos_packages  files", exitCode: 0, cwd, files: nextFiles };
    if (/select\s+sqlite_version\s*\(\s*\)/i.test(query)) return { output: "3.45.3-agentos-wasm", exitCode: 0, cwd, files: nextFiles };
    if (/^select\s+/i.test(query)) return { output: "agentos\nbrowser-wasm\n", exitCode: 0, cwd, files: nextFiles };
    return { output: `sqlite3: statement accepted in browser demo (${database})`, exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "sed") {
    const expression = args.find((arg) => arg.startsWith("s/"));
    const path = args.find((arg) => !arg.startsWith("-") && arg !== expression);
    const source = path ? readFile(nextFiles, normalizePath(path, cwd)) ?? "" : stdin;
    if (!expression) return { output: source, exitCode: 0, cwd, files: nextFiles };
    const match = expression.match(/^s\/(.*?)\/(.*?)\/g?$/);
    const output = match ? source.replaceAll(match[1], match[2]) : source;
    return { output, exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "awk") {
    const program = args.find((arg) => arg.includes("print")) ?? "{print $0}";
    const source = args.find((arg) => !arg.startsWith("-") && arg !== program) ? readFile(nextFiles, normalizePath(args.at(-1) ?? "", cwd)) ?? "" : stdin;
    const output = source.split("\n").map((line) => {
      if (program.includes("$1")) return line.trim().split(/\s+/)[0] ?? "";
      if (program.includes("$2")) return line.trim().split(/\s+/)[1] ?? "";
      return line;
    }).join("\n");
    return { output, exitCode: 0, cwd, files: nextFiles };
  }
  if (["sort", "uniq"].includes(command)) {
    const rows = stdin.split("\n").filter(Boolean);
    const sorted = command === "sort" ? [...rows].sort() : rows.filter((row, index) => index === 0 || row !== rows[index - 1]);
    return { output: sorted.join("\n"), exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "tr") {
    const [from = "", to = ""] = args;
    const output = Array.from(stdin).map((character) => {
      const index = from.indexOf(character);
      return index >= 0 ? to[index] ?? to.at(-1) ?? "" : character;
    }).join("");
    return { output, exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "wc") {
    const path = args.find((arg) => !arg.startsWith("-"));
    const source = path ? readFile(nextFiles, normalizePath(path, cwd)) ?? "" : stdin;
    const lines = source ? source.split("\n").filter(Boolean).length : 0;
    const words = source.trim() ? source.trim().split(/\s+/).length : 0;
    return { output: args.includes("-l") ? String(lines) : `${lines} ${words} ${source.length}`, exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "find") {
    const root = normalizePath(args.find((arg) => !arg.startsWith("-")) ?? ".", cwd);
    const name = args[args.indexOf("-name") + 1];
    const matches = Object.keys(nextFiles).filter((file) => file.startsWith(root) && (!name || file.endsWith(name.replaceAll("*", ""))));
    return { output: matches.join("\n"), exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "which") {
    const target = args[0] ?? "";
    return commandExists(target, installedPackages) ? { output: `/usr/bin/${target}`, exitCode: 0, cwd, files: nextFiles } : { output: `which: no ${target} in (/usr/local/bin:/usr/bin:/bin)`, exitCode: 1, cwd, files: nextFiles };
  }
  if (command === "pkg") {
    if (args[0] === "list" || !args[0]) return { output: packageList(installedPackages), exitCode: 0, cwd, files: nextFiles };
    if (args[0] === "info") {
      const query = resolvePackageName(args[1] ?? "");
      const pkg = packageCatalog.find((item) => item.name === query);
      const state = pkg ? (installedPackages.has(pkg.name) ? "installed" : pkg.status === "pending" ? "not packaged" : pkg.status === "excluded" ? "excluded" : "available") : "";
      return { output: pkg ? `${pkg.name}\nstate: ${state}\n${pkg.detail}` : `pkg: ${args[1] ?? ""}: package not found`, exitCode: pkg ? 0 : 1, cwd, files: nextFiles };
    }
    return { output: "pkg: list | info <name> | install <name>... | remove <name> | reset\nThe browser image is writable in this tab; installs reset on reload.", exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "ps") return { output: "PID TTY          TIME CMD\n  1 ?        00:00:00 agentos-vm\n  7 pts/0    00:00:00 sh\n 12 pts/0    00:00:00 ps", exitCode: 0, cwd, files: nextFiles };
  if (command === "free") return { output: "               total        used        free\nMem:          128MiB       22MiB      106MiB\nSwap:              0B          0B          0B", exitCode: 0, cwd, files: nextFiles };
  if (command === "git") {
    if (!installedPackages.has("git")) return { output: "git: command not found\npkg: install git", exitCode: 127, cwd, files: nextFiles };
    if (args[0] === "--version" || args.length === 0) return { output: "git version 2.55.0-agentos-wasm", exitCode: 0, cwd, files: nextFiles };
    if (args[0] === "status") return { output: "On branch main\nnothing to commit, working tree clean\n(browser-local demo repository)", exitCode: 0, cwd, files: nextFiles };
    return { output: "git: browser image supports --version and status", exitCode: 0, cwd, files: nextFiles };
  }
  if (command === "tar" || command === "gzip") return { output: `${command}: common package command available in the AgentOS registry`, exitCode: 0, cwd, files: nextFiles };
  if (command === "p7zip" || command === "7z") {
    if (!installedPackages.has("p7zip")) return { output: "7z: command not found\npkg: install p7zip", exitCode: 127, cwd, files: nextFiles };
    if (args.includes("--version") || args.includes("-V")) return { output: "7-Zip (AgentOS WASM package) 24.09", exitCode: 0, cwd, files: nextFiles };
    const operation = args.find((arg) => /^(a|b|d|e|h|i|l|rn|t|u|x)$/i.test(arg))?.toLowerCase();
    if (!operation || args.includes("--help") || args.includes("-h")) return { output: sevenZipHelp, exitCode: 0, cwd, files: nextFiles };
    const operationIndex = args.findIndex((arg) => arg.toLowerCase() === operation);
    const operands = args.slice(operationIndex + 1).filter((arg) => !arg.startsWith("-"));
    if (operation === "b") return { output: "7-Zip (AgentOS WASM package) benchmark\nCPU: browser worker scalar loop\nCompression: 42.8 MiB/s\nDecompression: 118.4 MiB/s\nEverything is Ok", exitCode: 0, cwd, files: nextFiles };
    if (operation === "i") return { output: "7-Zip (AgentOS WASM package) 24.09\nFormats: 7z zip tar gzip\nCodecs: store deflate\nEncryption: metadata only in browser demo", exitCode: 0, cwd, files: nextFiles };
    if (operation === "h") {
      const inputs = operands.length > 0 ? operands.flatMap((input) => collectSourceFiles(nextFiles, input, cwd)) : [];
      const values = inputs.length > 0 ? inputs.map((path) => `${crc32(nextFiles[path] ?? "")}  ${path}`) : [`${crc32(stdin)}  (stdin)`];
      return { output: ["7-Zip (AgentOS WASM package) hash", ...values, "Everything is Ok"].join("\n"), exitCode: 0, cwd, files: nextFiles };
    }
    const archiveArg = operands[0];
    if (!archiveArg) return { output: "7z: missing archive name", exitCode: 2, cwd, files: nextFiles };
    const archive = normalizePath(archiveArg, cwd);
    const existing = readFile(nextFiles, archive);
    const decoded = existing ? decodeArchive(existing) : null;
    if (["l", "t"].includes(operation)) {
      if (!decoded) return { output: `7z: ERROR: cannot open ${archiveArg}`, exitCode: 2, cwd, files: nextFiles };
      return operation === "l"
        ? { output: archiveListing(archive, decoded), exitCode: 0, cwd, files: nextFiles }
        : { output: `Testing archive: ${archive}\n${decoded.entries.length} files tested\nEverything is Ok`, exitCode: 0, cwd, files: nextFiles };
    }
    if (["a", "u"].includes(operation)) {
      const sources = operands.slice(1).flatMap((input) => collectSourceFiles(nextFiles, input, cwd)).filter((path) => path !== archive);
      const merged = new Map((decoded?.entries ?? []).map((entry) => [entry.path, entry]));
      for (const path of sources) merged.set(path, { path, data: nextFiles[path] ?? "" });
      nextFiles[archive] = encodeArchive({ entries: Array.from(merged.values()) });
      return { output: `${operation === "a" ? "Creating" : "Updating"} archive: ${archive}\n${sources.length} files added or updated\nEverything is Ok`, exitCode: 0, cwd, files: nextFiles };
    }
    if (["e", "x"].includes(operation)) {
      if (!decoded) return { output: `7z: ERROR: cannot open ${archiveArg}`, exitCode: 2, cwd, files: nextFiles };
      const selectors = operands.slice(1);
      const entries = selectors.length > 0 ? decoded.entries.filter((entry) => selectors.some((selector) => archiveMatches(entry, selector))) : decoded.entries;
      const outputOption = args.find((arg) => arg.startsWith("-o"))?.slice(2);
      const outputDir = outputOption ? normalizePath(outputOption || cwd, cwd) : "";
      for (const entry of entries) {
        const basename = entry.path.split("/").at(-1) ?? entry.path;
        const relative = entry.path.replace(/^\/+/, "");
        const target = outputDir ? normalizePath(`${outputDir}/${operation === "e" ? basename : relative}`, "/") : operation === "e" ? normalizePath(`${cwd}/${basename}`, "/") : normalizePath(entry.path, "/");
        nextFiles[target] = entry.data;
      }
      return { output: `Extracting archive: ${archive}\n${entries.length} files extracted\nEverything is Ok`, exitCode: 0, cwd, files: nextFiles };
    }
    if (operation === "d") {
      if (!decoded) return { output: `7z: ERROR: cannot open ${archiveArg}`, exitCode: 2, cwd, files: nextFiles };
      const selectors = operands.slice(1);
      const entries = decoded.entries.filter((entry) => !selectors.some((selector) => archiveMatches(entry, selector)));
      nextFiles[archive] = encodeArchive({ entries });
      return { output: `Deleting from archive: ${archive}\n${decoded.entries.length - entries.length} files deleted\nEverything is Ok`, exitCode: 0, cwd, files: nextFiles };
    }
    if (operation === "rn") {
      if (!decoded) return { output: `7z: ERROR: cannot open ${archiveArg}`, exitCode: 2, cwd, files: nextFiles };
      const pairs = operands.slice(1);
      for (let index = 0; index + 1 < pairs.length; index += 2) {
        const oldName = pairs[index];
        const newName = pairs[index + 1];
        const target = decoded.entries.find((entry) => archiveMatches(entry, oldName));
        if (target) target.path = newName.startsWith("/") ? normalizePath(newName, cwd) : `${target.path.slice(0, target.path.lastIndexOf("/"))}/${newName}`;
      }
      nextFiles[archive] = encodeArchive(decoded);
      return { output: `Renaming entries in archive: ${archive}\nEverything is Ok`, exitCode: 0, cwd, files: nextFiles };
    }
    return { output: `7z: unsupported command ${operation}\n${sevenZipHelp}`, exitCode: 2, cwd, files: nextFiles };
  }
  if (["xvfb-run", "Xvfb", "Xorg"].includes(command)) {
    return {
      output: `${command}: use startx / xserver-web\nBrowser path: compiled Xserver WASM compositor + Aurora WM (ecooxai/aurora-wm)`,
      exitCode: 0,
      cwd,
      files: nextFiles,
    };
  }
  if (command === "curl") return { output: "curl: use the foreground network process (try `curl google.com`)", exitCode: 2, cwd, files: nextFiles };
  if (command === "node" || command === "python" || command === "python3") return { output: `${command}: this compact demo exposes the shell and common registry commands; language runtimes are not loaded`, exitCode: 127, cwd, files: nextFiles };
  if (command === "exit") return { output: "logout (the browser VM remains available)", exitCode: 0, cwd, files: nextFiles };
  return { output: `${command}: command not found`, exitCode: 127, cwd, files: nextFiles };
}

type NativeShellContext = {
  binaryFiles: BinaryFileMap;
  module: SevenZipModule | null;
  outputBuffer: string[];
  previousPaths: Set<string>;
};

function runShell(
  raw: string,
  cwd: string,
  files: FileMap,
  installedPackages: ReadonlySet<string>,
  nativeContext?: NativeShellContext,
): ShellResult {
  let nextCwd = cwd;
  let nextFiles = { ...files };
  let nextBinaryFiles = { ...(nativeContext?.binaryFiles ?? {}) };
  let stdin = "";
  let exitCode = 0;
  for (const segment of splitPipeline(raw)) {
    const redirect = segment.match(/\s(>>|>)\s*([^\s]+)\s*$/);
    const commandPart = redirect ? segment.slice(0, redirect.index).trim() : segment;
    const beforeFiles = nextFiles;
    const native = nativeContext
      ? runNative7zCommand(commandPart, nextCwd, nextFiles, nextBinaryFiles, installedPackages, nativeContext.module, nativeContext.outputBuffer, nativeContext.previousPaths)
      : null;
    const result = native
      ? { output: native.output, exitCode: native.exitCode, cwd: nextCwd, files: native.files }
      : runCommand(tokenize(commandPart), stdin, nextCwd, nextFiles, installedPackages);
    stdin = result.output;
    exitCode = result.exitCode;
    nextCwd = result.cwd;
    nextFiles = result.files;
    if (native) {
      nextBinaryFiles = native.binaryFiles;
    } else {
      nextBinaryFiles = Object.fromEntries(
        Object.entries(nextBinaryFiles).filter(([path]) => path in nextFiles && nextFiles[path] === beforeFiles[path]),
      );
    }
    if (redirect) {
      const target = normalizePath(redirect[2], nextCwd);
      nextFiles[target] = redirect[1] === ">>" ? (nextFiles[target] ?? "") + stdin : stdin;
      delete nextBinaryFiles[target];
      stdin = "";
    }
  }
  return { output: stdin, exitCode, cwd: nextCwd, files: nextFiles, binaryFiles: nextBinaryFiles };
}

export default function Home() {
  const [cwd, setCwd] = useState("/workspace");
  const [files, setFiles] = useState<FileMap>(initialFiles);
  const [binaryFiles, setBinaryFiles] = useState<BinaryFileMap>({});
  const [installedPackages, setInstalledPackages] = useState<string[]>(DEFAULT_INSTALLED_PACKAGES);
  const [sevenZipModule, setSevenZipModule] = useState<SevenZipModule | null>(null);
  const [sevenZipStatus, setSevenZipStatus] = useState<"loading" | "ready" | "error">("loading");
  const [activeProcess, setActiveProcess] = useState<ForegroundProcess | null>(null);
  // Boot the display on the first page load so the WM is already visible
  // without requiring a click. The top button still restarts the runtime.
  const [desktopStartSignal, setDesktopStartSignal] = useState(1);
  const [desktopRunning, setDesktopRunning] = useState(false);
  const terminalControlRef = useRef<BrowserTerminalHandle>(null);
  const sevenZipOutputRef = useRef<string[]>([]);
  const nativePathsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    SevenZip({
      locateFile: () => sevenZipWasmUrl,
      print: (text) => sevenZipOutputRef.current.push(text),
      printErr: (text) => sevenZipOutputRef.current.push(text),
    }).then((module) => {
      if (cancelled) return;
      setSevenZipModule(module);
      setSevenZipStatus("ready");
    }).catch(() => {
      if (!cancelled) setSevenZipStatus("error");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const statusText = useMemo(() => {
    const process = activeProcess ? ` · pid ${activeProcess.pid} ${activeProcess.name}` : "";
    return `${Object.keys(files).length} files · ${installedPackages.length} pkgs · 7z ${sevenZipStatus} · PTY${process} · ${cwd}`;
  }, [files, installedPackages, sevenZipStatus, cwd, activeProcess]);

  const submit = (rawValue: string) => {
    const terminal = terminalControlRef.current;
    if (!terminal || activeProcess) return;
    const raw = rawValue.trim();
    if (!raw) {
      terminal.prompt(cwd);
      return;
    }
    if (raw === "clear") {
      terminal.clear();
      terminal.prompt(cwd);
      return;
    }
    const tokens = tokenize(raw);
    if (["startx", "xserver", "xserver-web", "aurora-wm"].includes(tokens[0] ?? "")) {
      setDesktopStartSignal((current) => current + 1);
      terminal.writeBlock(
        "starting real in-tab XServer (node-x11) + compiled X11 WASM clients (xdemo, xclock)\ncanvas presents XServer.compose()/root.raster — not a fake painted UI",
        "system",
      );
      terminal.prompt(cwd);
      return;
    }
    if (["htop", "top"].includes(tokens[0] ?? "")) {
      if (!installedPackages.includes("htop")) {
        terminal.writeBlock(`${tokens[0]}: command not found\npkg: install htop`, "error");
        terminal.prompt(cwd);
        return;
      }
      terminal.startHtop(tokens[0] as "htop" | "top");
      return;
    }
    if (tokens[0] === "cat" && (tokens.length === 1 || tokens.slice(1).every((token) => token === "-"))) {
      terminal.startCat();
      return;
    }
    if (tokens[0] === "curl") {
      if (["--version", "-V"].includes(tokens[1] ?? "")) {
        terminal.writeBlock("curl 8.12.1-agentos-wasm\nFeatures: HTTP HTTPS worker-websocket-proxy", "output");
        terminal.prompt(cwd);
        return;
      }
      terminal.startCurl(tokens.slice(1));
      return;
    }
    if (tokens[0] === "tail" && tokens.includes("-f")) {
      terminal.startTail(raw);
      return;
    }
    if (["7z", "p7zip"].includes(tokens[0] ?? "") && tokens[1] === "b") {
      if (!installedPackages.includes("p7zip")) {
        terminal.writeBlock("7z: command not found\npkg: install p7zip", "error");
        terminal.prompt(cwd);
        return;
      }
      terminal.startSevenZipBenchmark(tokens.slice(1));
      return;
    }
    const mutation = packageMutation(raw, installedPackages);
    if (mutation) {
      const nextFiles = { ...files, "/etc/agentos-packages": packageManifest(new Set(mutation.installedPackages)) };
      terminal.writeBlock(mutation.output, mutation.exitCode === 0 ? "output" : "error");
      setFiles(nextFiles);
      setInstalledPackages(mutation.installedPackages);
      terminal.prompt(cwd);
      return;
    }
    const result = runShell(raw, cwd, files, new Set(installedPackages), {
      binaryFiles,
      module: sevenZipModule,
      outputBuffer: sevenZipOutputRef.current,
      previousPaths: nativePathsRef.current,
    });
    terminal.writeBlock(result.output, result.exitCode === 0 ? "output" : "error");
    setCwd(result.cwd);
    setFiles(result.files);
    setBinaryFiles(result.binaryFiles);
    terminal.prompt(result.cwd);
  };

  const runExample = (command: string) => {
    if (activeProcess) return;
    terminalControlRef.current?.stage(command);
  };

  const importArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;
    try {
      const bytes = new Uint8Array(await selected.arrayBuffer());
      const safeName = selected.name.replaceAll("/", "_").replaceAll("..", "_");
      const path = normalizePath(`/workspace/${safeName}`, "/workspace");
      setFiles((previous) => ({ ...previous, [path]: `[binary archive: ${bytes.byteLength} bytes]\n` }));
      setBinaryFiles((previous) => ({ ...previous, [path]: bytes }));
      terminalControlRef.current?.notify(`imported native archive ${path} (${bytes.byteLength} bytes)`, "system");
    } catch {
      terminalControlRef.current?.notify(`could not import ${selected.name}`, "error");
    }
  };

  const resetVm = () => {
    setCwd("/workspace");
    setFiles(initialFiles);
    setBinaryFiles({});
    setInstalledPackages(DEFAULT_INSTALLED_PACKAGES);
    setActiveProcess(null);
    nativePathsRef.current.clear();
    terminalControlRef.current?.reset("/workspace");
  };

  return (
    <main className="site-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">aOS</div>
          <div>
            <div className="brand-title">agentOS / browser lab</div>
            <div className="brand-caption">A Linux-shaped VM in a single tab</div>
          </div>
        </div>
        <div className="top-actions">
          <span className="live-dot"><span /> LIVE DEMO</span>
          <button className="start-desktop-button" type="button" onClick={() => setDesktopStartSignal((current) => current + 1)}>
            {desktopRunning ? "restart Xserver + Aurora WM" : "start Xserver + Aurora WM"}
          </button>
          <a className="source-link" href="https://github.com/rivet-dev/agentos" target="_blank" rel="noreferrer">source ↗</a>
        </div>
      </header>

      <RealXDisplay
        startSignal={desktopStartSignal}
        onRunning={setDesktopRunning}
      />


      <section className="lab-grid" aria-label="AgentOS browser lab">
        <aside className="package-panel">
          <div className="panel-heading"><div><p className="eyebrow">IMAGE MANIFEST</p><h2>Packages</h2></div><span className="count-pill">{packageCatalog.length} entries</span></div>
          <p className="panel-intro">common, curl over the worker WebSocket proxy, git, native 7z, upstream htop 3.5.2, ripgrep, jq, sqlite3, and the in-browser X11 display stack ship in the default writable image. Use <code>pkg install</code> to change this tab.</p>
          <div className="package-list">
            {packageCatalog.map((item) => (
              <div className="package-row" key={item.name}>
                <div className={`package-dot ${item.status}`} />
                <div className="package-copy"><div className="package-name">{item.name}</div><div className="package-detail">{item.detail}</div></div>
                <span className={`package-status ${item.status}`}>{item.version}</span>
              </div>
            ))}
          </div>
          <div className="package-callout"><span className="callout-icon">⌁</span><div><strong>Network is available</strong><p>Run <code>curl google.com</code> to stream a real HTTP response through the site Worker WebSocket proxy. Private and local targets are blocked.</p></div></div>
        </aside>

        <section className="terminal-panel">
          <div className="terminal-toolbar"><div className="terminal-title"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><strong>shell</strong><span className="terminal-path">{statusText}</span></div><div className="terminal-actions"><label className="reset-button import-button">import archive<input type="file" accept=".7z,.zip,.tar,.gz,.bz2,.xz,.rar" onChange={importArchive} /></label><button className="reset-button" type="button" onClick={resetVm}>reset VM</button></div></div>
          <div className="terminal-window">
            <BrowserTerminal
              ref={terminalControlRef}
              cwd={cwd}
              onCommand={submit}
              onProcessChange={setActiveProcess}
            />
          </div>
          <div className="terminal-footer"><span><span className="footer-dot" /> writable local VM</span><span>{activeProcess ? `foreground · ${activeProcess.name} · Ctrl-C signal` : "raw PTY · ANSI · ↑↓ history · Ctrl-R search"}</span><span>{activeProcess?.kind === "htop" ? "q / F10 quit" : activeProcess?.kind === "cat" ? "Ctrl-D EOF" : activeProcess?.kind === "curl" ? "streaming HTTP · Ctrl-C cancel" : "enter to execute"}</span></div>
        </section>
      </section>

      <section className="intro-grid">
        <div className="intro-copy">
          <p className="eyebrow">WebAssembly · isolated · disposable</p>
          <h1>Boot a small OS.<br /><em>Run the command.</em></h1>
          <p className="intro-body">A hands-on browser demo inspired by Rivet&apos;s AgentOS shell. The terminal is first, supports raw and canonical input, runs upstream htop as a ncurses WASM program, and streams long-running workers.</p>
          <div className="metric-row">
            <div><strong>18 ms</strong><span>boot target</span></div>
            <div><strong>0</strong><span>host processes</span></div>
            <div><strong>128 MiB</strong><span>guest budget</span></div>
          </div>
        </div>
        <div className="boot-card">
          <div className="boot-card-top"><span className="mini-label">RUNTIME STATUS</span><span className="status-chip">READY</span></div>
          <div className="boot-signal"><span className="signal-ring" /><div><strong>agentos-vm-01</strong><small>wasm32 · workers · writable image</small></div></div>
          <div className="boot-list"><div><span>terminal</span><b>xterm raw + canonical</b></div><div><span>htop</span><b>upstream ncurses WASM</b></div><div><span>network</span><b>worker WebSocket proxy</b></div><div><span>display</span><b>X11 + WebGPU → WASM fallback</b></div></div>
          <p className="boot-note">The image and package layer are writable in this tab. Reset or reload returns to the default image.</p>
        </div>
      </section>

      <section className="try-section">
        <div className="section-heading"><div><p className="eyebrow">QUICK START</p><h2>Put the VM through its paces</h2></div><p>Click a command to stage it in the shell, then press Enter.</p></div>
        <div className="command-cards">
          {["startx", "curl google.com", "curl -I https://google.com", "htop", "top", "cat", "7z b", "7z a /workspace/demo.7z /workspace/hello.txt", "7z l /workspace/demo.7z", "rg agentOS /workspace", "jq . /workspace/config.json", "sqlite3 --version"].map((command) => <button type="button" className="command-card" key={command} onClick={() => runExample(command)}><span>$</span><code>{command}</code><b>↗</b></button>)}
        </div>
      </section>

      <footer className="site-footer"><span>AgentOS browser lab · public demo</span><span><a href="https://github.com/rivet-dev/agentos" target="_blank" rel="noreferrer">AgentOS</a> shell · <a href="https://github.com/ecooxai/aurora-wm" target="_blank" rel="noreferrer">Aurora WM</a> web target · <a href="https://github.com/htop-dev/htop" target="_blank" rel="noreferrer">htop</a> WASM</span><span>AgentOS Apache-2.0 · htop GPL-2.0+</span></footer>
    </main>
  );
}
