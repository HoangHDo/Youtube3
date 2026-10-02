/**
 * Thin fetch wrapper around the CYBERSTREAM API.
 * Every helper throws an Error carrying `.code` and `.status` so callers can
 * branch on the failure without parsing strings.
 */

class ApiError extends Error {
  constructor(message, { code = 'request_failed', status = 0, detail } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const TIMEOUT_MS = 45_000;

async function request(path, { method = 'GET', body, signal, timeout = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // Let the caller's signal cancel ours too.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 300) };
      }
    }

    if (!res.ok) {
      throw new ApiError(data?.message || data?.error || `Request failed (${res.status})`, {
        code: data?.error || 'request_failed',
        status: res.status,
        detail: data?.detail,
      });
    }

    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('The request timed out. Check the server and your connection.', {
        code: 'timeout',
      });
    }
    throw new ApiError(error?.message || 'Network error', { code: 'network_error' });
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: (signal) => request('/api/health', { signal, timeout: 8000 }),

  /** Resolve a pasted URL or id into metadata + playable stream links. */
  resolve(input, { quality = 0, refresh = false, signal } = {}) {
    const params = new URLSearchParams();
    if (quality) params.set('quality', String(quality));
    if (refresh) params.set('refresh', '1');
    const query = params.toString();
    return request(`/api/resolve?${query}`, {
      method: 'POST',
      body: { url: input },
      signal,
      timeout: 60_000,
    });
  },

  catalog({ source = 'local', url = '', limit = 24, signal } = {}) {
    const params = new URLSearchParams({ source, limit: String(limit) });
    if (url) params.set('url', url);
    return request(`/api/catalog?${params}`, { signal, timeout: 20_000 });
  },

  state: (signal) => request('/api/state', { signal, timeout: 10_000 }),

  savePreferences: (patch) => request('/api/state/preferences', { method: 'PUT', body: patch }),

  history: (action, id) => request('/api/state/history', { method: 'PUT', body: { action, id } }),

  saved: (action, id) => request('/api/state/saved', { method: 'PUT', body: { action, id } }),

  watch: (payload) => request('/api/state/watch', { method: 'POST', body: payload, timeout: 10_000 }),

  reProbe: () => request('/api/admin/resolver/refresh', { method: 'POST' }),
};

export { ApiError };
