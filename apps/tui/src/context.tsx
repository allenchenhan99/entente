import { spawn } from 'node:child_process';

import {
  actionsFor,
  buildGraph,
  describe,
  narrate,
  storyFor,
  type GraphApi,
} from '@relay/protocol';
import React, { createContext, useContext, type ReactNode } from 'react';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type CommandExecutor = (argv: string[]) => Promise<void>;

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

const defaultExecute: CommandExecutor = async (argv) => {
  const [command, ...args] = argv;
  if (!command) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? 'signal'}`)));
  });
};

interface Dependencies {
  fetch: FetchLike;
  execute: CommandExecutor;
  graphApi: GraphApi;
}

const defaultGraphApi: GraphApi = { buildGraph, actionsFor, narrate, storyFor, describe };

const DependenciesContext = createContext<Dependencies>({
  fetch: defaultFetch,
  execute: defaultExecute,
  graphApi: defaultGraphApi,
});

export interface DependenciesProviderProps {
  fetch?: FetchLike;
  execute?: CommandExecutor;
  graphApi?: GraphApi;
  children: ReactNode;
}

export function DependenciesProvider({
  fetch = defaultFetch,
  execute = defaultExecute,
  graphApi = defaultGraphApi,
  children,
}: DependenciesProviderProps) {
  return <DependenciesContext.Provider value={{ fetch, execute, graphApi }}>{children}</DependenciesContext.Provider>;
}

export function useDependencies(): Dependencies {
  return useContext(DependenciesContext);
}
