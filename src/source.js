const origin = 'https://selected.invalid/'; // Virtual namespace: never handed to global fetch.

function pathOf(value, base) {
  const raw = String(value).split(/[?#]/, 1)[0];
  if (raw.includes('\\')) throw new Error('Invalid selected file path.');
  for (const segment of raw.split('/')) {
    const decoded = decodeURIComponent(segment);
    if (segment !== decoded && (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\'))) {
      throw new Error('Invalid encoded selected file path.');
    }
  }
  const url = new URL(value, base);
  if (url.origin !== new URL(origin).origin || url.username || url.password || url.search) {
    throw new Error('External URLs and queries are not allowed in selected files.');
  }
  if (!/^[a-z][a-z\d+.-]*:/i.test(raw) && !raw.startsWith('/')) {
    let depth = new URL(base).pathname.split('/').length - 2;
    for (const part of raw.split('/')) {
      if (part === '..') { if (!depth--) throw new Error('Reference escapes the selected folder.'); }
      else if (part && part !== '.') depth++;
    }
  }
  const parts = url.pathname.slice(1).split('/').map(part => decodeURIComponent(part));
  if (parts.some(part => part === '.' || part === '..' || part.includes('/') || part.includes('\\') || /[\u0000-\u001f\u007f]/.test(part))) {
    throw new Error('Invalid selected file path.');
  }
  url.hash = '';
  return { url: url.href, path: parts.join('/') };
}

export function createFileSource(root) {
  if (!(root instanceof File) || !root.name || root.name.includes('/') || root.name.includes('\\')) {
    throw new Error('Choose one GML or tileset JSON file.');
  }
  let rootPath = root.name, files = new Map([[rootPath, root]]), closed = false;
  const urls = new Map();
  const assertOpen = () => { if (closed) throw new Error('File selection is closed.'); };
  const source = {
    get name() { return root.name; },
    get url() { return new URL(rootPath.split('/').map(encodeURIComponent).join('/'), origin).href; },
    resolve(value, base = source.url) { assertOpen(); return pathOf(value, base).url; },
    file(value, base = source.url) {
      assertOpen();
      const { path } = pathOf(value, base);
      const file = files.get(path);
      if (!file) throw new Error(`Missing selected file: ${path}. Choose its related folder.`);
      return file;
    },
    async fetch(value, { signal } = {}) {
      signal?.throwIfAborted();
      const file = source.file(value);
      signal?.throwIfAborted();
      return new Response(file);
    },
    objectUrl(value) {
      const key = source.resolve(value);
      if (!urls.has(key)) urls.set(key, URL.createObjectURL(source.file(key)));
      return urls.get(key);
    },
    ownsObjectUrl(value) { return [...urls.values()].includes(value); },
    async selectFolder(selection) {
      assertOpen();
      const next = new Map(), candidates = [];
      let packageName;
      for (const file of selection) {
        const parts = file.webkitRelativePath.split('/');
        if (parts.length < 2 || !parts[0] || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
          throw new Error('Choose a folder with valid relative file paths.');
        }
        if (packageName && parts[0] !== packageName) throw new Error('Select exactly one related folder.');
        packageName = parts[0];
        const path = parts.slice(1).join('/');
        if (next.has(path)) throw new Error(`Duplicate selected file path: ${path}`);
        next.set(path, file);
        if (file.name === root.name && file.size === root.size) candidates.push(path);
      }
      if (!candidates.length) throw new Error('The chosen folder does not contain the selected root file (name and size must match).');
      const digest = async file => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).join(',');
      const identity = await digest(root);
      const matches = [];
      for (const path of candidates) if (await digest(next.get(path)) === identity) matches.push(path);
      assertOpen();
      if (matches.length !== 1) throw new Error(matches.length ? 'Duplicate matching root files in the chosen folder.' : 'The chosen folder has a different root file.');
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      rootPath = matches[0];
      files = next;
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      files.clear();
    },
  };
  return source;
}
