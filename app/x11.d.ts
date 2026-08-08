declare module "x11" {
  const x11: {
    eventMask: Record<string, number>;
    createClient: (
      options: { display: string; stream: unknown },
      callback: (error: Error | null, display: { client: unknown; screen: Array<{ root: number }> }) => void,
    ) => void;
  };

  export default x11;
}

declare module "x11/lib/xserver/index.js" {
  export const XServer: new (options: { width: number; height: number }) => unknown;
  export const createStreamPair: () => [unknown, unknown];
}
