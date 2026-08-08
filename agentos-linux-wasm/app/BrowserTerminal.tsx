"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type Ref,
} from "react";

export type TerminalTone = "output" | "error" | "system";

export type ForegroundProcess = {
  name: string;
  pid: number;
  kind: "htop" | "cat" | "tail" | "7z" | "curl";
};

export type BrowserTerminalHandle = {
  clear: () => void;
  focus: () => void;
  notify: (text: string, tone?: TerminalTone) => void;
  prompt: (cwd: string) => void;
  reset: (cwd: string) => void;
  stage: (command: string) => void;
  startCat: () => void;
  startCurl: (args: string[]) => void;
  startHtop: (command: "htop" | "top") => void;
  startSevenZipBenchmark: (args: string[]) => void;
  startTail: (label: string) => void;
  writeBlock: (text: string, tone?: TerminalTone) => void;
};

type BrowserTerminalProps = {
  cwd: string;
  onCommand: (command: string) => void;
  onProcessChange: (process: ForegroundProcess | null) => void;
};

type RuntimeProcess = ForegroundProcess & {
  worker?: Worker;
  input?: string;
};

type TerminalApi = BrowserTerminalHandle;

const toneColor: Record<TerminalTone, string> = {
  output: "\x1b[38;2;185;207;194m",
  error: "\x1b[38;2;255;158;141m",
  system: "\x1b[38;2;141;196;169m",
};

const resetColor = "\x1b[0m";
const promptColor = "\x1b[38;2;188;244;118m";
const terminalFontSize = 14;
const terminalFontFamily =
  '"JetBrains Mono Variable", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
const terminalFallbackFontFamily =
  'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

type CurlRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  includeHeaders: boolean;
  headOnly: boolean;
};

type CurlParseResult = { request: CurlRequest } | { error: string };

function parseCurlArgs(args: string[]): CurlParseResult {
  let target = "";
  let method = "GET";
  let body: string | undefined;
  let includeHeaders = false;
  let headOnly = false;
  const headers: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      target = args[index + 1] ?? "";
      break;
    }
    if (arg === "-I" || arg === "--head") {
      method = "HEAD";
      includeHeaders = true;
      headOnly = true;
      continue;
    }
    if (arg === "-i" || arg === "--include") {
      includeHeaders = true;
      continue;
    }
    if (arg === "-X" || arg === "--request") {
      method = (args[index + 1] ?? "GET").toUpperCase();
      index += 1;
      continue;
    }
    if (arg === "-H" || arg === "--header") {
      const value = args[index + 1] ?? "";
      const separator = value.indexOf(":");
      if (separator <= 0) return { error: `curl: malformed header: ${value}` };
      headers[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
      index += 1;
      continue;
    }
    if (arg === "-d" || arg === "--data" || arg === "--data-raw") {
      body = args[index + 1] ?? "";
      if (method === "GET") method = "POST";
      index += 1;
      continue;
    }
    if (arg === "-u" || arg === "--user") {
      index += 1;
      continue;
    }
    if (arg === "-s" || arg === "--silent" || arg === "-S" || arg === "--show-error" || arg === "-L" || arg === "--location" || arg === "--compressed") continue;
    if (arg === "-o" || arg === "--output") return { error: "curl: -o/--output is not available in the browser shell yet" };
    if (arg.startsWith("-")) continue;
    target = arg;
  }

  if (!target) return { error: "curl: no URL specified\nTry `curl google.com`" };
  const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  try {
    new URL(url);
  } catch {
    return { error: `curl: URL rejected: ${target}` };
  }
  return { request: { url, method, headers, body, includeHeaders, headOnly } };
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function visibleLength(value: string): number {
  return Array.from(value).length;
}

function BrowserTerminalInner(
  { cwd, onCommand, onProcessChange }: BrowserTerminalProps,
  forwardedRef: Ref<BrowserTerminalHandle>,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<TerminalApi | null>(null);
  const commandRef = useRef(onCommand);
  const processChangeRef = useRef(onProcessChange);
  const cwdRef = useRef(cwd);

  useEffect(() => {
    commandRef.current = onCommand;
  }, [onCommand]);

  useEffect(() => {
    processChangeRef.current = onProcessChange;
  }, [onProcessChange]);

  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  useImperativeHandle(forwardedRef, () => ({
    clear: () => apiRef.current?.clear(),
    focus: () => apiRef.current?.focus(),
    notify: (text, tone) => apiRef.current?.notify(text, tone),
    prompt: (nextCwd) => apiRef.current?.prompt(nextCwd),
    reset: (nextCwd) => apiRef.current?.reset(nextCwd),
    stage: (command) => apiRef.current?.stage(command),
    startCat: () => apiRef.current?.startCat(),
    startCurl: (args) => apiRef.current?.startCurl(args),
    startHtop: (command) => apiRef.current?.startHtop(command),
    startSevenZipBenchmark: (args) => apiRef.current?.startSevenZipBenchmark(args),
    startTail: (label) => apiRef.current?.startTail(label),
    writeBlock: (text, tone) => apiRef.current?.writeBlock(text, tone),
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: terminalFallbackFontFamily,
      fontSize: terminalFontSize,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.25,
      rescaleOverlappingGlyphs: true,
      scrollback: 5000,
      smoothScrollDuration: 80,
      theme: {
        background: "#14201f",
        foreground: "#b9cfc2",
        cursor: "#bcf476",
        cursorAccent: "#14201f",
        selectionBackground: "#53756888",
        black: "#14201f",
        brightBlack: "#6d8278",
        red: "#ff7f6b",
        brightRed: "#ff9e8d",
        green: "#a6dc72",
        brightGreen: "#bcf476",
        yellow: "#ffc36d",
        brightYellow: "#ffd58f",
        blue: "#71a9d1",
        brightBlue: "#8bc3ec",
        magenta: "#bd8ec8",
        brightMagenta: "#d7a9e1",
        cyan: "#76c9c2",
        brightCyan: "#91e1d9",
        white: "#dce8df",
        brightWhite: "#f1faef",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    let disposed = false;

    // xterm measures a fixed cell grid. Apply the bundled terminal font only
    // after it is loaded, then force a fresh measurement so fallback metrics
    // can never leave later glyphs colliding with neighboring cells.
    void document.fonts
      .load(`400 ${terminalFontSize}px "JetBrains Mono Variable"`)
      .then((loadedFonts) => {
        if (disposed || loadedFonts.length === 0) return;
        terminal.options.fontFamily = terminalFontFamily;
        terminal.clearTextureAtlas();
        fitAddon.fit();
        terminal.refresh(0, terminal.rows - 1);
      })
      .catch(() => {
        // The explicit monospace fallback keeps cell metrics stable offline.
      });

    let currentCwd = cwdRef.current;
    let shellBuffer = "";
    let shellCursor = 0;
    let historyCursor = -1;
    let historyDraft = "";
    const history: string[] = [];
    let activeProcess: RuntimeProcess | null = null;

    const promptSequence = () => `${promptColor}root@agentos:${currentCwd} $${resetColor} `;

    const writeBlock = (text: string, tone: TerminalTone = "output") => {
      if (!text) return;
      terminal.write(`${toneColor[tone]}${normalizeNewlines(text)}${resetColor}`);
      if (!text.endsWith("\n") && !text.endsWith("\r")) terminal.write("\r\n");
      terminal.scrollToBottom();
    };

    const redrawInput = () => {
      terminal.write(`\r\x1b[2K${promptSequence()}${shellBuffer}`);
      const tailLength = visibleLength(shellBuffer.slice(shellCursor));
      if (tailLength > 0) terminal.write(`\x1b[${tailLength}D`);
      terminal.scrollToBottom();
    };

    const writePrompt = (nextCwd: string) => {
      currentCwd = nextCwd;
      shellBuffer = "";
      shellCursor = 0;
      historyCursor = -1;
      historyDraft = "";
      terminal.write(promptSequence());
      terminal.scrollToBottom();
      terminal.focus();
    };

    const announceProcess = (process: RuntimeProcess | null) => {
      activeProcess = process;
      processChangeRef.current(process ? {
        name: process.name,
        pid: process.pid,
        kind: process.kind,
      } : null);
    };

    const completeProcess = (message?: string, tone: TerminalTone = "system") => {
      const process = activeProcess;
      if (!process) return;
      process.worker?.terminate();
      if (process.kind === "htop") terminal.write("\x1b[0m\x1b[?25h\x1b[?1049l");
      terminal.write("\r\n");
      announceProcess(null);
      if (message) writeBlock(message, tone);
      writePrompt(currentCwd);
    };

    const interruptProcess = () => {
      if (!activeProcess) return;
      const process = activeProcess;
      if (process.kind === "curl") process.worker?.postMessage({ type: "cancel" });
      if (process.kind === "htop") terminal.write("\x1b[?1049l\x1b[0m\x1b[?25h");
      completeProcess(`^C\n[${process.pid}] ${process.name} interrupted`, "system");
    };

    const startHtop = (command: "htop" | "top") => {
      if (activeProcess) return;
      const worker = new Worker(new URL("./workers/htop.worker.ts", import.meta.url), { type: "module" });
      const process: RuntimeProcess = {
        name: command === "top" ? "top (htop.wasm)" : "htop",
        pid: 42,
        kind: "htop",
        worker,
      };
      announceProcess(process);
      writeBlock(`loading upstream htop 3.5.2 + ncurses 6.4 (${command})`, "system");

      worker.onmessage = (event: MessageEvent<{ type: string; data?: ArrayBuffer; code?: number; message?: string }>) => {
        if (activeProcess !== process) return;
        if (event.data.type === "output" && event.data.data) {
          terminal.write(new Uint8Array(event.data.data));
          return;
        }
        if (event.data.type === "exit") {
          const code = event.data.code ?? 0;
          completeProcess(code === 0 ? undefined : `${process.name}: exited with code ${code}`, code === 0 ? "system" : "error");
          return;
        }
        if (event.data.type === "error") {
          completeProcess(`htop.wasm: ${event.data.message ?? "runtime failed"}`, "error");
        }
      };
      worker.onerror = (event) => {
        if (activeProcess === process) completeProcess(`htop.wasm: ${event.message || "worker failed"}`, "error");
      };
      worker.postMessage({ type: "start", command, cols: terminal.cols, rows: terminal.rows });
    };

    const startSevenZipBenchmark = (args: string[]) => {
      if (activeProcess) return;
      const worker = new Worker(new URL("./workers/sevenzip-benchmark.worker.ts", import.meta.url), { type: "module" });
      const process: RuntimeProcess = { name: "7z b", pid: 45, kind: "7z", worker };
      announceProcess(process);

      worker.onmessage = (event: MessageEvent<{ type: string; text?: string; code?: number; message?: string }>) => {
        if (activeProcess !== process) return;
        if (event.data.type === "output" && event.data.text !== undefined) {
          writeBlock(event.data.text, "output");
          return;
        }
        if (event.data.type === "exit") {
          const code = event.data.code ?? 0;
          completeProcess(code === 0 ? undefined : `7z: benchmark exited with code ${code}`, code === 0 ? "system" : "error");
          return;
        }
        if (event.data.type === "error") completeProcess(`7z: ${event.data.message ?? "benchmark failed"}`, "error");
      };
      worker.onerror = (event) => {
        if (activeProcess === process) completeProcess(`7z: ${event.message || "benchmark worker failed"}`, "error");
      };
      worker.postMessage({ type: "start", args });
    };

    const startCurl = (args: string[]) => {
      if (activeProcess) return;
      const parsed = parseCurlArgs(args);
      if ("error" in parsed) {
        writeBlock(parsed.error, "error");
        writePrompt(currentCwd);
        return;
      }
      const worker = new Worker(new URL("./workers/network.worker.ts", import.meta.url), { type: "module" });
      const process: RuntimeProcess = { name: "curl", pid: 46, kind: "curl", worker };
      announceProcess(process);
      writeBlock(`curl: connecting through worker WebSocket proxy → ${parsed.request.url}`, "system");
      worker.onmessage = (event: MessageEvent<{
        type: string;
        data?: ArrayBuffer;
        headers?: Record<string, string>;
        status?: number;
        statusText?: string;
        url?: string;
        message?: string;
      }>) => {
        if (activeProcess !== process) return;
        if (event.data.type === "response") {
          if (parsed.request.includeHeaders || parsed.request.headOnly) {
            const lines = [
              `HTTP/1.1 ${event.data.status ?? 0} ${event.data.statusText ?? ""}`.trimEnd(),
              ...Object.entries(event.data.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
              "",
            ];
            writeBlock(lines.join("\n"), "system");
          }
          return;
        }
        if (event.data.type === "chunk" && event.data.data) {
          terminal.write(new Uint8Array(event.data.data));
          terminal.scrollToBottom();
          return;
        }
        if (event.data.type === "end") {
          completeProcess();
          return;
        }
        if (event.data.type === "error") {
          completeProcess(`curl: ${event.data.message ?? "network request failed"}`, "error");
        }
      };
      worker.onerror = (event) => {
        if (activeProcess === process) completeProcess(`curl: ${event.message || "network worker failed"}`, "error");
      };
      worker.postMessage({ type: "start", request: parsed.request });
    };

    const startCat = () => {
      if (activeProcess) return;
      announceProcess({ name: "cat", pid: 43, kind: "cat", input: "" });
    };

    const startTail = (label: string) => {
      if (activeProcess) return;
      announceProcess({ name: label, pid: 44, kind: "tail" });
      writeBlock(`${label}: waiting for new data (Ctrl-C to stop)`, "system");
    };

    const handleCatData = (data: string) => {
      if (!activeProcess || activeProcess.kind !== "cat") return;
      for (const character of data) {
        if (character === "\x03") {
          interruptProcess();
          return;
        }
        if (character === "\x1a") {
          completeProcess(`^Z\n[1]+  Stopped                 cat`, "system");
          return;
        }
        if (character === "\x04") {
          if (activeProcess.input) {
            terminal.write(activeProcess.input);
            activeProcess.input = "";
          } else {
            completeProcess();
          }
          continue;
        }
        if (character === "\x7f" || character === "\b") {
          if (activeProcess.input) {
            activeProcess.input = activeProcess.input.slice(0, -1);
            terminal.write("\b \b");
          }
          continue;
        }
        if (character === "\r" || character === "\n") {
          const line = activeProcess.input ?? "";
          terminal.write(`\r\n${line}\r\n`);
          activeProcess.input = "";
          continue;
        }
        activeProcess.input = (activeProcess.input ?? "") + character;
        terminal.write(character);
      }
    };

    const handleProcessData = (data: string) => {
      if (!activeProcess) return;
      if (activeProcess.kind === "cat") {
        handleCatData(data);
        return;
      }
      if (data.includes("\x03")) {
        interruptProcess();
        return;
      }
      if (data.includes("\x1a")) {
        const process = activeProcess;
        completeProcess(`^Z\n[1]+  Stopped                 ${process.name}`, "system");
        return;
      }
      if (activeProcess.kind === "htop" && activeProcess.worker) {
        const encoded = new TextEncoder().encode(data);
        activeProcess.worker.postMessage({ type: "stdin", data: encoded.buffer }, [encoded.buffer]);
      }
    };

    const historyMove = (direction: 1 | -1) => {
      if (history.length === 0) return;
      if (historyCursor === -1) historyDraft = shellBuffer;
      historyCursor = Math.max(-1, Math.min(history.length - 1, historyCursor + direction));
      shellBuffer = historyCursor === -1 ? historyDraft : history[history.length - 1 - historyCursor] ?? "";
      shellCursor = shellBuffer.length;
      redrawInput();
    };

    const completeCommand = () => {
      const prefix = shellBuffer.slice(0, shellCursor).trimStart();
      if (prefix.includes(" ")) return;
      const commands = [
        "7z", "awk", "cat", "cd", "clear", "date", "diff", "echo", "env", "find", "free",
        "curl", "git", "grep", "gzip", "head", "help", "history", "htop", "jq", "ls", "mkdir", "pkg",
        "printf", "ps", "pwd", "rg", "rm", "sed", "sort", "sqlite3", "tail", "tar", "top",
        "touch", "tr", "uname", "uniq", "which", "whoami",
      ];
      const match = commands.find((command) => command.startsWith(prefix));
      if (!match) return;
      shellBuffer = `${shellBuffer.slice(0, shellCursor - prefix.length)}${match}${shellBuffer.slice(shellCursor)}`;
      shellCursor = match.length;
      redrawInput();
    };

    const handleShellData = (data: string) => {
      if (data === "\x1b[A") return historyMove(1);
      if (data === "\x1b[B") return historyMove(-1);
      if (data === "\x1b[D") {
        shellCursor = Math.max(0, shellCursor - 1);
        return redrawInput();
      }
      if (data === "\x1b[C") {
        shellCursor = Math.min(shellBuffer.length, shellCursor + 1);
        return redrawInput();
      }
      if (data === "\x1b[H" || data === "\x1b[1~") {
        shellCursor = 0;
        return redrawInput();
      }
      if (data === "\x1b[F" || data === "\x1b[4~") {
        shellCursor = shellBuffer.length;
        return redrawInput();
      }
      if (data === "\x1b[3~") {
        if (shellCursor < shellBuffer.length) shellBuffer = shellBuffer.slice(0, shellCursor) + shellBuffer.slice(shellCursor + 1);
        return redrawInput();
      }

      for (const character of data) {
        if (character === "\r" || character === "\n") {
          const command = shellBuffer.trim();
          terminal.write("\r\n");
          if (!command) {
            writePrompt(currentCwd);
            continue;
          }
          history.push(command);
          if (history.length > 100) history.shift();
          shellBuffer = "";
          shellCursor = 0;
          historyCursor = -1;
          commandRef.current(command);
          continue;
        }
        if (character === "\x03") {
          terminal.write("^C\r\n");
          writePrompt(currentCwd);
          continue;
        }
        if (character === "\x04") {
          if (!shellBuffer) {
            writeBlock("logout (the browser VM remains available)", "system");
            writePrompt(currentCwd);
          }
          continue;
        }
        if (character === "\x0c") {
          terminal.write("\x1b[2J\x1b[3J\x1b[H");
          redrawInput();
          continue;
        }
        if (character === "\x01") {
          shellCursor = 0;
          redrawInput();
          continue;
        }
        if (character === "\x05") {
          shellCursor = shellBuffer.length;
          redrawInput();
          continue;
        }
        if (character === "\x15") {
          shellBuffer = shellBuffer.slice(shellCursor);
          shellCursor = 0;
          redrawInput();
          continue;
        }
        if (character === "\x0b") {
          shellBuffer = shellBuffer.slice(0, shellCursor);
          redrawInput();
          continue;
        }
        if (character === "\x17") {
          const before = shellBuffer.slice(0, shellCursor);
          const trimmed = before.replace(/\s+$/, "");
          const shortened = trimmed.replace(/\S+$/, "");
          shellBuffer = shortened + shellBuffer.slice(shellCursor);
          shellCursor = shortened.length;
          redrawInput();
          continue;
        }
        if (character === "\x12") {
          const match = [...history].reverse().find((entry) => entry.includes(shellBuffer));
          if (match) {
            shellBuffer = match;
            shellCursor = match.length;
            redrawInput();
          }
          continue;
        }
        if (character === "\t") {
          completeCommand();
          continue;
        }
        if (character === "\x7f" || character === "\b") {
          if (shellCursor > 0) {
            shellBuffer = shellBuffer.slice(0, shellCursor - 1) + shellBuffer.slice(shellCursor);
            shellCursor -= 1;
            redrawInput();
          }
          continue;
        }
        if (character >= " " && character !== "\x7f") {
          shellBuffer = shellBuffer.slice(0, shellCursor) + character + shellBuffer.slice(shellCursor);
          shellCursor += character.length;
          redrawInput();
        }
      }
    };

    const dataSubscription = terminal.onData((data) => {
      if (activeProcess) handleProcessData(data);
      else handleShellData(data);
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (activeProcess?.kind === "htop" && activeProcess.worker) {
        activeProcess.worker.postMessage({ type: "resize", cols, rows });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // The host can briefly have zero dimensions during responsive layout.
      }
    });
    resizeObserver.observe(host);

    const writeBoot = () => {
      terminal.write(`${toneColor.system}agentOS browser VM · wasm terminal · upstream htop 3.5.2${resetColor}\r\n`);
      terminal.write(`${toneColor.system}boot  ready   image writable   net worker-ws-proxy   PTY raw/canonical${resetColor}\r\n`);
      writeBlock("Type help for commands. Default image: git 7z htop rg jq sqlite3.", "output");
      writePrompt(currentCwd);
    };

    apiRef.current = {
      clear: () => terminal.write("\x1b[2J\x1b[3J\x1b[H"),
      focus: () => terminal.focus(),
      notify: (text, tone = "system") => {
        if (activeProcess) return;
        terminal.write("\r\x1b[2K");
        writeBlock(text, tone);
        redrawInput();
      },
      prompt: writePrompt,
      reset: (nextCwd) => {
        activeProcess?.worker?.terminate();
        announceProcess(null);
        currentCwd = nextCwd;
        shellBuffer = "";
        shellCursor = 0;
        history.splice(0);
        terminal.reset();
        writeBoot();
      },
      stage: (command) => {
        if (activeProcess) return;
        shellBuffer = command;
        shellCursor = command.length;
        historyCursor = -1;
        redrawInput();
        terminal.focus();
      },
      startCat,
      startCurl,
      startHtop,
      startSevenZipBenchmark,
      startTail,
      writeBlock,
    };

    const frame = requestAnimationFrame(() => {
      fitAddon.fit();
      writeBoot();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      activeProcess?.worker?.terminate();
      resizeObserver.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      apiRef.current = null;
      terminal.dispose();
    };
  }, []);

  return <div className="xterm-host" ref={hostRef} aria-label="Interactive AgentOS terminal" />;
}

export const BrowserTerminal = forwardRef(BrowserTerminalInner);
