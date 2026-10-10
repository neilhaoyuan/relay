/** Same-origin JSON requests and WebSocket URLs for the private network workspace. */
export async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, headers: data === undefined ? undefined : { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result as T;
}
export function socketUrl(path: string): string { return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`; }
