import { AsyncLocalStorage } from "node:async_hooks";
const contextStore = new AsyncLocalStorage();
export function runWithContext(context, fn) {
    return contextStore.run(context, fn);
}
export function getContext() {
    return contextStore.getStore() ?? null;
}
