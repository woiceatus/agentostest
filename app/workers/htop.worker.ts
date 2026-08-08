type HtopFileSystem = {
  chdir: (path: string) => void;
  init: (
    input: () => number | null,
    output: (byte: number) => void,
    error: (byte: number) => void,
  ) => void;
  mkdirTree: (path: string) => void;
};

type HtopModule = {
  FS: HtopFileSystem;
  TTY: {
    default_tty_ops: {
      ioctl_tiocgwinsz: () => [number, number];
    };
  };
  _agentos_set_terminal_size: (columns: number, rows: number) => void;
  callMain: (args: string[]) => number | void;
};

type HtopFactory = (options: {
  noInitialRun: boolean;
  locateFile: (path: string) => string;
  preRun: Array<(module: HtopModule) => void>;
  onExit: (code: number) => void;
  onAbort: (reason: unknown) => void;
  print: (text: string) => void;
  printErr: (text: string) => void;
}) => Promise<HtopModule>;

type WorkerCommand =
  | { type: "start"; command: "htop" | "top"; cols: number; rows: number }
  | { type: "stdin"; data: ArrayBuffer }
  | { type: "resize"; cols: number; rows: number };

const inputQueue: number[] = [];
let columns = 80;
let rows = 24;
let outputBuffer: number[] = [];
let outputScheduled = false;
let exited = false;

function flushOutput() {
  outputScheduled = false;
  if (outputBuffer.length === 0) return;
  const bytes = new Uint8Array(outputBuffer);
  outputBuffer = [];
  self.postMessage({ type: "output", data: bytes.buffer }, { transfer: [bytes.buffer] });
}

function outputByte(byte: number) {
  outputBuffer.push(byte);
  if (!outputScheduled) {
    outputScheduled = true;
    queueMicrotask(flushOutput);
  }
}

function outputLine(text: string) {
  for (const byte of new TextEncoder().encode(`${text}\n`)) outputByte(byte);
}

async function start(command: "htop" | "top") {
  try {
    const moduleUrl = new URL("/wasm/htop/htop.mjs", self.location.origin).href;
    const imported = await import(/* @vite-ignore */ moduleUrl) as { default: HtopFactory };
    const createHtopModule = imported.default;
    const wasmUrl = new URL("/wasm/htop/htop.wasm", self.location.origin).href;
    const runtime = await createHtopModule({
      noInitialRun: true,
      locateFile: (path) => path.endsWith(".wasm") ? wasmUrl : path,
      preRun: [(runtime) => runtime.FS.init(
        () => inputQueue.shift() ?? null,
        outputByte,
        outputByte,
      )],
      onExit: (code) => {
        if (exited) return;
        exited = true;
        flushOutput();
        self.postMessage({ type: "exit", code });
      },
      onAbort: (reason) => {
        if (!exited) self.postMessage({ type: "error", message: String(reason) });
      },
      print: outputLine,
      printErr: outputLine,
    });

    runtime.TTY.default_tty_ops.ioctl_tiocgwinsz = () => [rows, columns];
    runtime._agentos_set_terminal_size(columns, rows);
    runtime.FS.mkdirTree("/home/root/.config/htop");
    runtime.FS.mkdirTree("/workspace");
    runtime.FS.chdir("/workspace");
    runtime.callMain(command === "top" ? ["--no-color"] : []);
  } catch (error) {
    if (!exited) self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const message = event.data;
  if (message.type === "stdin") {
    inputQueue.push(...new Uint8Array(message.data));
    return;
  }
  if (message.type === "resize") {
    columns = Math.max(20, message.cols);
    rows = Math.max(10, message.rows);
    return;
  }
  columns = Math.max(20, message.cols);
  rows = Math.max(10, message.rows);
  void start(message.command);
};

export {};
