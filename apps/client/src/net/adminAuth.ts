const STORAGE_KEY = "wiw.adminToken";

const listeners = new Set<() => void>();

export const getAdminToken = (): string => {
  try { return localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
};

export const setAdminToken = (token: string): void => {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
  for (const fn of listeners) fn();
};

export const subscribeAdminToken = (fn: () => void): () => void => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const isAdmin = (): boolean => getAdminToken().length > 0;

export const withAdminAuth = (init: RequestInit = {}): RequestInit => {
  const token = getAdminToken();
  if (!token) return init;
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
};

export const adminFetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  return fetch(input, withAdminAuth(init));
};
