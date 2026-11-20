/** fetch wrapper for the game API: GET when there's no body, POST JSON otherwise. */
import type { ApiError } from "./types";

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: "bad_response", message: "The server sent something odd" }));
  if (!res.ok) throw new Error((json as ApiError).message ?? "Something went wrong");
  return json as T;
}
