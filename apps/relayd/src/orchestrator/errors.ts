/** Errors raised by the orchestrator; `status` maps directly onto an HTTP status. */
export class RelayError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RelayError';
  }
}
export const notFound = (what: string) => new RelayError(404, `${what} not found`);
export const conflict = (msg: string) => new RelayError(409, msg);
