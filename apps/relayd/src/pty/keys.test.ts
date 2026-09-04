import { describe, it, expect } from 'vitest';
import { keyToBytes, UnknownKeyError } from './keys.js';

describe('input keys mapping', () => {
  it('maps the documented logical keys to terminal bytes', () => {
    expect(keyToBytes('enter')).toBe('\r');
    expect(keyToBytes('esc')).toBe('\x1b');
    expect(keyToBytes('tab')).toBe('\t');
    expect(keyToBytes('backspace')).toBe('\x7f');
    expect(keyToBytes('up')).toBe('\x1b[A');
    expect(keyToBytes('down')).toBe('\x1b[B');
    expect(keyToBytes('right')).toBe('\x1b[C');
    expect(keyToBytes('left')).toBe('\x1b[D');
    expect(keyToBytes('ctrl+c')).toBe('\x03');
    expect(keyToBytes('ctrl+d')).toBe('\x04');
    expect(keyToBytes('ctrl+Z')).toBe('\x1a');
  });

  it('rejects unknown keys', () => {
    expect(() => keyToBytes('meta+x')).toThrow(UnknownKeyError);
    expect(() => keyToBytes('ctrl+1')).toThrow(UnknownKeyError);
    expect(() => keyToBytes('')).toThrow(UnknownKeyError);
  });
});
