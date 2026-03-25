import { AsyncLocalStorage } from "node:async_hooks";

export type RequestAuthContext = {
  sessionId: string;
  redmineAccessToken: string;
  scopes: string[];
};

const contextStore = new AsyncLocalStorage<RequestAuthContext>();

export function runWithContext<T>(context: RequestAuthContext, fn: () => Promise<T>): Promise<T> {
  return contextStore.run(context, fn);
}

export function getContext(): RequestAuthContext | null {
  return contextStore.getStore() ?? null;
}

