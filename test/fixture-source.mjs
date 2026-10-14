// Node-only fixture transport for existing geometry tests. Never imported by the app.
export function fixtureSource(base) {
  return {
    resolve(value, parent = base) {
      const url = new URL(value, parent);
      if (url.origin !== new URL(base).origin) throw new Error('External URLs are not allowed.');
      if (!/^\/(samples|data)\//.test(url.pathname)) throw new Error('Input must be within selected test fixtures.');
      url.hash = '';
      return url.href;
    },
    async fetch(value, options = {}) {
      const response = await fetch(this.resolve(value), { ...options, redirect: 'error' });
      if (!response.ok) throw new Error(`Local fixture load failed: HTTP ${response.status}`);
      return response;
    },
    objectUrl(value) { return this.resolve(value); },
    ownsObjectUrl() { return false; },
  };
}
