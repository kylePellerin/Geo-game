"use client";
/** Buttons and forms for the admin page (they call /api/admin/action). */
import { useState } from "react";

async function post(body: object) {
  const res = await fetch("/api/admin/action", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
}

export function AdminActions({ action, label }: { action: object; label: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true);
        const r = await post(action);
        setBusy(false);
        setMsg(r.message ?? (r.ok ? "done (reload to see)" : "failed"));
      }}>{busy ? "…" : label}</button>
      {msg && <small> {msg}</small>}
    </>
  );
}

export function AliasForm({ type, raw }: { type: string; raw: string }) {
  const [q, setQ] = useState(raw);
  const [hits, setHits] = useState<{ id: string; name: string; country: string | null }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search entity" size={16} />
      <button type="button" onClick={async () => setHits(await post({ action: "search", type, q }))}>Find</button>
      {hits.map((h) => (
        <div key={h.id}>
          <button type="button" onClick={async () => {
            const r = await post({ action: "alias", entity_id: h.id, alias: raw });
            setMsg(r.ok ? `“${raw}” → ${h.name}` : r.message);
            setHits([]);
          }}>{h.name}{h.country ? ` (${h.country})` : ""}</button>
        </div>
      ))}
      {msg && <small>{msg}</small>}
    </div>
  );
}
