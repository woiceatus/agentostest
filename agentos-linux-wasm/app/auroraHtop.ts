/**
 * Minimal ANSI / VT100 screen buffer for feeding upstream htop.wasm output
 * into the Aurora Terminal line list (which is a text chrome, not xterm.js).
 */

export type AnsiScreen = {
  cols: number;
  rows: number;
  write: (bytes: Uint8Array | string) => void;
  lines: () => string[];
  clear: () => void;
};

function createGrid(cols: number, rows: number): string[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
}

export function createAnsiScreen(cols: number, rows: number): AnsiScreen {
  const width = Math.max(20, Math.min(120, cols | 0));
  const height = Math.max(6, Math.min(40, rows | 0));
  let cells = createGrid(width, height);
  let cursorX = 0;
  let cursorY = 0;
  let parser = "";

  const clampCursor = () => {
    cursorX = Math.max(0, Math.min(width - 1, cursorX));
    cursorY = Math.max(0, Math.min(height - 1, cursorY));
  };

  const put = (ch: string) => {
    if (ch === "\r") {
      cursorX = 0;
      return;
    }
    if (ch === "\n") {
      cursorX = 0;
      cursorY += 1;
      if (cursorY >= height) {
        cells.shift();
        cells.push(Array.from({ length: width }, () => " "));
        cursorY = height - 1;
      }
      return;
    }
    if (ch === "\b") {
      cursorX = Math.max(0, cursorX - 1);
      return;
    }
    if (ch === "\t") {
      cursorX = Math.min(width - 1, cursorX + (8 - (cursorX % 8)));
      return;
    }
    if (ch < " " && ch !== " ") return;
    cells[cursorY][cursorX] = ch.length ? ch[0]! : " ";
    cursorX += 1;
    if (cursorX >= width) {
      cursorX = 0;
      cursorY += 1;
      if (cursorY >= height) {
        cells.shift();
        cells.push(Array.from({ length: width }, () => " "));
        cursorY = height - 1;
      }
    }
  };

  const eraseInDisplay = (mode: number) => {
    if (mode === 2 || mode === 3) {
      cells = createGrid(width, height);
      cursorX = 0;
      cursorY = 0;
      return;
    }
    if (mode === 0) {
      for (let x = cursorX; x < width; x += 1) cells[cursorY][x] = " ";
      for (let y = cursorY + 1; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) cells[y][x] = " ";
      }
      return;
    }
    if (mode === 1) {
      for (let y = 0; y < cursorY; y += 1) {
        for (let x = 0; x < width; x += 1) cells[y][x] = " ";
      }
      for (let x = 0; x <= cursorX; x += 1) cells[cursorY][x] = " ";
    }
  };

  const eraseInLine = (mode: number) => {
    if (mode === 2) {
      for (let x = 0; x < width; x += 1) cells[cursorY][x] = " ";
      return;
    }
    if (mode === 1) {
      for (let x = 0; x <= cursorX; x += 1) cells[cursorY][x] = " ";
      return;
    }
    for (let x = cursorX; x < width; x += 1) cells[cursorY][x] = " ";
  };

  const handleCsi = (body: string, final: string) => {
    const args = body
      .split(";")
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 10))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const a0 = args[0] ?? 0;
    const a1 = args[1] ?? 0;
    switch (final) {
      case "H":
      case "f": {
        cursorY = Math.max(0, (a0 || 1) - 1);
        cursorX = Math.max(0, (a1 || 1) - 1);
        clampCursor();
        break;
      }
      case "A":
        cursorY = Math.max(0, cursorY - (a0 || 1));
        break;
      case "B":
        cursorY = Math.min(height - 1, cursorY + (a0 || 1));
        break;
      case "C":
        cursorX = Math.min(width - 1, cursorX + (a0 || 1));
        break;
      case "D":
        cursorX = Math.max(0, cursorX - (a0 || 1));
        break;
      case "G":
        cursorX = Math.max(0, Math.min(width - 1, (a0 || 1) - 1));
        break;
      case "d":
        cursorY = Math.max(0, Math.min(height - 1, (a0 || 1) - 1));
        break;
      case "J":
        eraseInDisplay(a0 || 0);
        break;
      case "K":
        eraseInLine(a0 || 0);
        break;
      case "m":
      case "h":
      case "l":
      case "n":
      case "r":
      case "s":
      case "u":
      case "t":
        // Ignore SGR / mode / status / scroll region for Aurora text chrome.
        break;
      default:
        break;
    }
  };

  const feedChar = (ch: string) => {
    if (parser.length === 0) {
      if (ch === "\x1b") {
        parser = "\x1b";
        return;
      }
      put(ch);
      return;
    }

    parser += ch;
    if (parser === "\x1b[") return;
    if (parser === "\x1b]") {
      // OSC — wait for BEL / ST
      return;
    }
    if (parser.startsWith("\x1b]")) {
      if (ch === "\x07" || parser.endsWith("\x1b\\")) parser = "";
      return;
    }
    if (parser === "\x1b(" || parser === "\x1b)") {
      // charset designate; consume next char
      return;
    }
    if (parser.length === 3 && (parser.startsWith("\x1b(") || parser.startsWith("\x1b)"))) {
      parser = "";
      return;
    }
    if (parser.startsWith("\x1b[")) {
      const final = ch;
      if ((final >= "@" && final <= "~") || final === "`") {
        const body = parser.slice(2, -1).replace(/^[?=><]/, "");
        handleCsi(body, final);
        parser = "";
      } else if (parser.length > 48) {
        parser = "";
      }
      return;
    }
    // Unknown ESC sequence — drop.
    if (parser.length > 2) parser = "";
  };

  return {
    cols: width,
    rows: height,
    write(input) {
      const text = typeof input === "string" ? input : new TextDecoder().decode(input);
      for (const ch of text) feedChar(ch);
    },
    lines() {
      return cells.map((row) => row.join("").replace(/\s+$/u, ""));
    },
    clear() {
      cells = createGrid(width, height);
      cursorX = 0;
      cursorY = 0;
      parser = "";
    },
  };
}

export type AuroraHtopSession = {
  worker: Worker;
  screen: AnsiScreen;
  stop: () => void;
};

type AuroraTermSink = {
  memory: WebAssembly.Memory;
  aurora_term_clear: (...args: number[]) => number;
  aurora_term_line_buf: (...args: number[]) => number;
  aurora_term_line_cap: (...args: number[]) => number;
  aurora_term_add_line: (...args: number[]) => number;
  aurora_term_show: (...args: number[]) => number;
};

function writeWasmString(memory: WebAssembly.Memory, ptr: number, cap: number, value: string): number {
  const bytes = new TextEncoder().encode(value);
  const length = Math.min(bytes.length, Math.max(0, cap - 1));
  new Uint8Array(memory.buffer, ptr, length).set(bytes.subarray(0, length));
  return length;
}

export function pushScreenToAuroraTerm(aurora: AuroraTermSink, screen: AnsiScreen): void {
  aurora.aurora_term_clear();
  const visible = screen.lines().filter((line, index, all) => {
    if (line.trim().length > 0) return true;
    // Keep blank rows inside the live htop frame so layout stays stable.
    return index < all.length - 1;
  });
  const rows = visible.length > 0 ? visible : ["$ htop", "loading upstream htop.wasm…"];
  for (const line of rows.slice(0, 40)) {
    const len = writeWasmString(
      aurora.memory,
      aurora.aurora_term_line_buf(),
      aurora.aurora_term_line_cap(),
      line.slice(0, 90),
    );
    aurora.aurora_term_add_line(len);
  }
  aurora.aurora_term_show(1);
}

/** Launch the real upstream htop WASM worker and mirror its PTY into Aurora Terminal. */
export function startAuroraHtop(
  aurora: AuroraTermSink,
  opts: { cols: number; rows: number; onUpdate?: () => void; onStatus?: (text: string) => void },
): AuroraHtopSession {
  const screen = createAnsiScreen(opts.cols, opts.rows);
  screen.write("$ htop\r\nloading upstream htop 3.5.2 + ncurses…\r\n");
  pushScreenToAuroraTerm(aurora, screen);
  opts.onUpdate?.();

  const worker = new Worker(new URL("./workers/htop.worker.ts", import.meta.url), { type: "module" });
  let stopped = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (stopped) return;
    flushTimer = null;
    pushScreenToAuroraTerm(aurora, screen);
    opts.onUpdate?.();
  };

  const scheduleFlush = () => {
    if (flushTimer !== null || stopped) return;
    flushTimer = setTimeout(flush, 50);
  };

  worker.onmessage = (event: MessageEvent<{ type: string; data?: ArrayBuffer; message?: string; code?: number }>) => {
    if (stopped) return;
    if (event.data.type === "output" && event.data.data) {
      screen.write(new Uint8Array(event.data.data));
      scheduleFlush();
      return;
    }
    if (event.data.type === "error") {
      screen.write(`\r\nhtop.wasm: ${event.data.message ?? "runtime failed"}\r\n`);
      flush();
      opts.onStatus?.(`Aurora Terminal · htop error`);
      return;
    }
    if (event.data.type === "exit") {
      screen.write(`\r\n[htop exited ${event.data.code ?? 0}]\r\n$ `);
      flush();
      opts.onStatus?.(`Aurora Terminal · htop exited`);
    }
  };
  worker.onerror = (event) => {
    if (stopped) return;
    screen.write(`\r\nhtop.wasm worker failed: ${event.message || "unknown"}\r\n`);
    flush();
  };

  worker.postMessage({ type: "start", command: "htop", cols: screen.cols, rows: screen.rows });
  opts.onStatus?.("Aurora Terminal · running real htop.wasm");

  return {
    worker,
    screen,
    stop: () => {
      stopped = true;
      if (flushTimer !== null) clearTimeout(flushTimer);
      worker.terminate();
    },
  };
}
