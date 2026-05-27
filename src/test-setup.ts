// Vitest global setup — polyfill Web Storage API for Node 25+
// Node 25 ships a built-in `localStorage` backed by a file, but it only
// implements getItem/setItem/removeItem/length/key — not clear(). The
// jsdom environment is supposed to replace this, but Node's global leaks
// through before jsdom can override it. We replace it with a proper in-
// memory implementation so tests can call localStorage.clear().

const makeStorage = (): Storage => {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
    getItem(k: string) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k: string, v: string) {
      store[k] = String(v);
    },
    removeItem(k: string) {
      delete store[k];
    },
    clear() {
      store = {};
    },
  };
};

Object.defineProperty(globalThis, "localStorage", {
  value: makeStorage(),
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, "sessionStorage", {
  value: makeStorage(),
  writable: true,
  configurable: true,
});
