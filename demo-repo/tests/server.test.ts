import { describe, expect, it } from 'vitest';

import {
  type ServeAdapter,
  type ServeOptions,
  resolvePort,
  startServer,
} from '../src/server.js';

describe('server', () => {
  it('uses port 3000 by default', () => {
    expect(resolvePort(undefined)).toBe(3000);
  });

  it('uses a configured port', () => {
    expect(resolvePort('4321')).toBe(4321);
  });

  it('passes the port and app handler to the server adapter', async () => {
    let receivedOptions: ServeOptions | undefined;
    const serverResult = { kind: 'server' };
    const fakeServe: ServeAdapter = (options) => {
      receivedOptions = options;
      return serverResult;
    };

    const result = startServer(4321, fakeServe);

    expect(result).toBe(serverResult);
    expect(receivedOptions?.port).toBe(4321);

    const response = (await receivedOptions?.fetch(
      new Request('http://localhost/health'),
      {} as never,
    )) as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
