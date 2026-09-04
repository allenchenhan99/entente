/**
 * WebSocket per pane at `/pty/:id` (PRD §23, `PtyServerMessage` / `PtyClientMessage`).
 * On connect: `hello` (PaneInfo) → `scrollback` (base64 of the raw ring) → live `output` frames → `exit`.
 * Accepts `input` (base64 bytes), `resize`, `ping` → `pong`. Any number of clients per pane; an unknown pane is
 * refused with HTTP 404 before the upgrade.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { PtyClientMessage, ptyRoutes } from '@relay/protocol';
import type { PtyServerMessage } from '@relay/protocol';
import type { RelayHost } from './host.js';
import type { Pane } from './pane.js';

export type PtyUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

const PTY_PREFIX = ptyRoutes.pty('');

/** Pane id from a request URL, or undefined when the path is not `/pty/:id`. */
export function paneIdFromUrl(url: string | undefined): string | undefined {
  const pathname = (url ?? '').split('?')[0]!;
  if (!pathname.startsWith(PTY_PREFIX)) return undefined;
  const rest = pathname.slice(PTY_PREFIX.length);
  if (rest.length === 0 || rest.includes('/')) return undefined;
  try {
    return decodeURIComponent(rest);
  } catch {
    return undefined;
  }
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function attach(ws: WebSocket, pane: Pane): void {
  const send = (msg: PtyServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  send({ t: 'hello', pane: pane.info() });
  send({ t: 'scrollback', data: pane.scrollback().toString('base64') });
  const offOutput = pane.onOutput((chunk) => send({ t: 'output', data: chunk.toString('base64') }));
  const offExit = pane.onExit((code) => send({ t: 'exit', code }));
  ws.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const msg = PtyClientMessage.safeParse(parsed);
    if (!msg.success) return;
    switch (msg.data.t) {
      case 'input':
        pane.write(Buffer.from(msg.data.data, 'base64'));
        break;
      case 'resize':
        pane.resize(msg.data.cols, msg.data.rows);
        break;
      case 'ping':
        send({ t: 'pong' });
        break;
    }
  });
  ws.on('close', () => {
    offOutput();
    offExit();
  });
}

export function createPtyWebSocketServer(host: RelayHost): { wss: WebSocketServer; handleUpgrade: PtyUpgradeHandler } {
  const wss = new WebSocketServer({ noServer: true });
  const handleUpgrade: PtyUpgradeHandler = (req, socket, head) => {
    const paneId = paneIdFromUrl(req.url);
    if (paneId === undefined) return refuse(socket, 404, 'Not Found');
    const pane = host.get(paneId);
    if (!pane) return refuse(socket, 404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, pane));
  };
  return { wss, handleUpgrade };
}
