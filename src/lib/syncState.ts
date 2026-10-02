/** Tiny shared state for "local data changed, sync soon" plus device identity. */

const dirtyListeners = new Set<() => void>();

export function markDirty() {
  try {
    localStorage.setItem('sync.dirty', '1');
  } catch {}
  dirtyListeners.forEach((fn) => fn());
}

export function isDirty() {
  try {
    return localStorage.getItem('sync.dirty') === '1';
  } catch {
    return true;
  }
}

export function clearDirty() {
  try {
    localStorage.removeItem('sync.dirty');
  } catch {}
}

export function onDirty(fn: () => void) {
  dirtyListeners.add(fn);
  return () => dirtyListeners.delete(fn);
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Device';
}

function stored(key: string, make: () => string) {
  try {
    let v = localStorage.getItem(key);
    if (!v) {
      v = make();
      localStorage.setItem(key, v);
    }
    return v;
  } catch {
    return make();
  }
}

export const device = {
  get id() {
    return stored('device.id', () => crypto.randomUUID());
  },
  get name() {
    return stored('device.name', guessDeviceName);
  },
  set name(v: string) {
    try {
      localStorage.setItem('device.name', v.trim() || guessDeviceName());
    } catch {}
  },
};
