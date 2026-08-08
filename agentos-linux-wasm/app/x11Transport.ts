import { EventEmitter } from "events";

type Duplex = EventEmitter & {
  write: (buf: Uint8Array | Buffer) => boolean;
  end: () => void;
  destroy: () => void;
  destroyed: boolean;
  peer: Duplex | null;
};

/**
 * Synchronous in-process duplex.
 * Unlike x11's createStreamPair (setImmediate), writes deliver immediately so a
 * WASM client can poll for the X setup reply in the same turn.
 */
function createSyncStreamPair(): [Duplex, Duplex] {
  const make = (): Duplex => {
    const stream = new EventEmitter() as Duplex;
    stream.destroyed = false;
    stream.peer = null;
    stream.write = (buf) => {
      const peer = stream.peer;
      if (stream.destroyed || !peer || peer.destroyed) return true;
      const copy = Buffer.from(buf);
      peer.emit("data", copy);
      return true;
    };
    stream.end = () => {
      const peer = stream.peer;
      stream.destroyed = true;
      if (peer && !peer.destroyed) peer.emit("end");
    };
    stream.destroy = () => stream.end();
    return stream;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export type X11ByteTransport = {
  write: (bytes: Uint8Array) => void;
  read: (dest: Uint8Array) => number;
  poll: () => number;
  close: () => void;
  clientSide: Duplex;
  serverSide: Duplex;
};

/** Duplex bridge: WASM X client <-> JS XServer (synchronous byte delivery). */
export function createX11ByteTransport(): X11ByteTransport {
  const [clientSide, serverSide] = createSyncStreamPair();
  const inbound: Uint8Array[] = [];
  let inboundBytes = 0;
  let closed = false;

  clientSide.on("data", (value) => {
    if (closed || value == null) return;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    inbound.push(copy);
    inboundBytes += copy.byteLength;
  });
  clientSide.on("end", () => {
    closed = true;
  });

  return {
    clientSide,
    serverSide,
    write(bytes) {
      if (closed || bytes.byteLength === 0) return;
      clientSide.write(bytes);
    },
    read(dest) {
      if (inboundBytes === 0 || dest.byteLength === 0) return 0;
      let offset = 0;
      while (offset < dest.byteLength && inbound.length > 0) {
        const head = inbound[0]!;
        const take = Math.min(dest.byteLength - offset, head.byteLength);
        dest.set(head.subarray(0, take), offset);
        offset += take;
        inboundBytes -= take;
        if (take === head.byteLength) inbound.shift();
        else inbound[0] = head.subarray(take);
      }
      return offset;
    },
    poll() {
      return inboundBytes;
    },
    close() {
      if (closed) return;
      closed = true;
      clientSide.end();
    },
  };
}
