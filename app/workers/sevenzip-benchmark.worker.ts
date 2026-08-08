import SevenZip from "7z-wasm";
import sevenZipWasmUrl from "7z-wasm/7zz.wasm?url";

type WorkerCommand = { type: "start"; args: string[] };

function exitCodeFrom(error: unknown): number {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") return error.status;
  return 1;
}

self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
  if (event.data.type !== "start") return;
  try {
    const runtime = await SevenZip({
      locateFile: () => sevenZipWasmUrl,
      print: (text) => self.postMessage({ type: "output", text }),
      printErr: (text) => self.postMessage({ type: "output", text }),
    });
    let code = 0;
    try {
      runtime.callMain(event.data.args);
    } catch (error) {
      code = exitCodeFrom(error);
    }
    self.postMessage({ type: "exit", code });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

export {};
