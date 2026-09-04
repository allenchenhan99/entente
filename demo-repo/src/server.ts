import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';

import { createApp } from './app.js';

export type ServeOptions = Parameters<typeof serve>[0];
export type ServeAdapter = (options: ServeOptions) => unknown;

export const resolvePort = (value: string | undefined): number =>
  value === undefined ? 3000 : Number(value);

export const startServer = (
  port: number = resolvePort(process.env.PORT),
  serveApp: ServeAdapter = serve,
): unknown =>
  serveApp({
    fetch: createApp().fetch,
    port,
  });

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  startServer();
}
