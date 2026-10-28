import { useSyncExternalStore } from "react";
import type { SessionStore, SessionView } from "./store";

/** store → React。getSnapshot 由 store 缓存，所以引用稳定。 */
export function useSessionView(store: SessionStore): SessionView {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
