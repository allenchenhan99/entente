import { serve } from '@hono/node-server';

import { createApp } from './app.js';

export type ServeOptions = Parameters<typeof serve>[0];
export type ServeAdapter = (options: ServeOptions) => unknown;

type RuntimeProcess = {
  argv: string[];
  env: Record<string, string | undefined>;
};

const runtimeProcess = (globalThis as typeof globalThis & { process: RuntimeProcess }).process;

export const resolvePort = (value: string | undefined): number =>
  value === undefined ? 3000 : Number(value);

export const startServer = (
  port: number = resolvePort(runtimeProcess.env.PORT),
  serveApp: ServeAdapter = serve,
): unknown =>
  serveApp({
    fetch: createApp().fetch,
    port,
  });

const entryPath = runtimeProcess.argv[1];
const modulePath = decodeURIComponent(new URL(import.meta.url).pathname);
if (entryPath !== undefined && modulePath === entryPath) {
  startServer();
}
