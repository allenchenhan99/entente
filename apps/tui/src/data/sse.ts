export interface SseMessage {
  id?: string;
  data: string;
}

export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];

    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary || boundary.index === undefined) break;
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const message = this.parseBlock(block);
      if (message) messages.push(message);
    }
    return messages;
  }

  finish(): SseMessage[] {
    if (this.buffer.trim() === '') return [];
    return this.push('\n\n');
  }

  private parseBlock(block: string): SseMessage | undefined {
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') id = value;
      if (field === 'data') data.push(value);
    }
    return data.length === 0 ? undefined : { ...(id === undefined ? {} : { id }), data: data.join('\n') };
  }
}

export async function consumeSse(response: Response, onMessage: (message: SseMessage) => void): Promise<void> {
  if (!response.body) throw new Error('SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) onMessage(message);
  }
  for (const message of parser.push(decoder.decode())) onMessage(message);
  for (const message of parser.finish()) onMessage(message);
}
