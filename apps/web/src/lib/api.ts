export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Fired when the server says the session is gone, so the app shows the login screen again. */
export const SIGNED_OUT_EVENT = 'salura:signed-out';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    // The session cookie travels with every same-origin request.
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Tidak bisa terhubung ke server. Periksa koneksi lalu coba lagi.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error;
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    throw new ApiError(res.status, err?.code ?? 'http', err?.message ?? `Server membalas ${res.status}`);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
};
