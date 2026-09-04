/** Placeholder until the MCP server lands; keeps the HTTP app importable. */
import type { Hono } from 'hono';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
export function mountMcp(_app: Hono, _orchestrator: Orchestrator): void {}
