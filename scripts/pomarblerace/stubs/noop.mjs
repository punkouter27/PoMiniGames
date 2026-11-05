// A stand-in whose every unknown member is a no-op function, so engine calls the harness does not
// care about (sparks, cues, grades, new effects other code adds later) cost nothing and never throw.
export function noopProxy(base = {}) {
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'then' || typeof key === 'symbol') return undefined;
      return () => undefined;
    },
  });
}
