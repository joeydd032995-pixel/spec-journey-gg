'use client';
/* Settings — AI Analyst key (bring-your-own, stored only in this browser)
   and a read-only view of how the deployment sources its data. */
import React, { useEffect, useState } from "react";
import { Check, KeyRound, Satellite, Settings as SettingsIcon, Trash2 } from "lucide-react";

import { C, FONT, SP } from "@/lib/theme";
import { STORAGE_KEYS as K, loadKey, saveKey } from "@/lib/storage";
import { Badge, Btn, Card, CardHeader, Hint, Label, Notice, inputStyle } from "@/components/ui";

interface StatusPayload {
  dataSource: "direct" | "scraper";
  scraperUrl: string | null;
  aiConfigured: boolean;
  betsapiConfigured: boolean;
}

type Msg = { t: "pos" | "neg" | "amber"; m: string } | null;

export default function Settings() {
  const [key, setKey] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<StatusPayload | null>(null);

  useEffect(() => {
    const stored = loadKey<string>(K.anthropicKey, "");
    setSavedKey(stored);
    setKey(stored);
    fetch("/api/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && setStatus(s))
      .catch(() => {});
  }, []);

  function save() {
    const clean = key.trim();
    saveKey(K.anthropicKey, clean);
    setSavedKey(clean);
    setMsg(clean ? { t: "pos", m: "Key saved to this browser." } : { t: "amber", m: "Key cleared." });
  }

  function clear() {
    saveKey(K.anthropicKey, "");
    setKey(""); setSavedKey("");
    setMsg({ t: "amber", m: "Key cleared." });
  }

  async function testKey() {
    const clean = key.trim();
    if (!clean && !status?.aiConfigured) { setMsg({ t: "neg", m: "Enter a key first." }); return; }
    setTesting(true); setMsg(null);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "test", apiKey: clean }),
      });
      const data = await res.json();
      if (res.ok && data.ok) setMsg({ t: "pos", m: "Key works — the AI Analyst is ready." });
      else setMsg({ t: "neg", m: data.error || "Key check failed." });
    } catch {
      setMsg({ t: "neg", m: "Could not reach the server." });
    } finally {
      setTesting(false);
    }
  }

  const aiReady = Boolean(status?.aiConfigured || savedKey);

  return (
    <div className="rise" style={{ display: "grid", gap: SP.lg }}>
      <Card>
        <CardHeader icon={<KeyRound size={15} />} title="AI Analyst key"
          sub="Powers the AI Analyst chat. Your key is stored only in this browser (localStorage) and sent to this site's own server per request — never to third parties. Get one at console.anthropic.com."
          actions={<Badge tone={aiReady ? "pos" : "amber"}>{status?.aiConfigured ? "configured on server" : savedKey ? "using your key" : "not configured"}</Badge>} />
        {status?.aiConfigured ? (
          <Hint>This deployment already has a server-side key — the AI Analyst works without any setup. A key entered below is only used if the server key is removed.</Hint>
        ) : null}
        <div style={{ marginTop: SP.sm }}>
          <Label>Anthropic API key</Label>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…" autoComplete="off" aria-label="Anthropic API key"
            style={{ ...inputStyle, maxWidth: 480 }} />
        </div>
        {msg && <div style={{ marginTop: SP.md }}><Notice tone={msg.t}>{msg.m}</Notice></div>}
        <div style={{ display: "flex", gap: SP.sm, marginTop: SP.md, flexWrap: "wrap" }}>
          <Btn kind="primary" onClick={save}><Check size={14} />Save key</Btn>
          <Btn onClick={testKey} disabled={testing}>{testing ? "Testing…" : "Test key"}</Btn>
          {savedKey && <Btn kind="danger" onClick={clear}><Trash2 size={14} />Remove</Btn>}
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Satellite size={15} />} title="Data source"
          sub="Where match and player data comes from. No setup is required — the site reads h2hggl.com's public API directly. Running the self-hosted scraper (see /scraper) is optional and adds caching."
          actions={status && (
            <Badge tone={status.dataSource === "direct" ? "blue" : "pos"}>
              {status.dataSource === "direct" ? "direct · h2hggl.com" : "self-hosted scraper"}
            </Badge>
          )} />
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, fontFamily: FONT.mono }}>
          {status ? (
            status.dataSource === "direct" ? (
              <>mode: direct — fetching from h2hggl.com&apos;s public API on demand<br />
                betsapi fallback: {status.betsapiConfigured ? "configured" : "not configured (optional)"}</>
            ) : (
              <>mode: scraper — proxying {status.scraperUrl}<br />
                betsapi fallback: {status.betsapiConfigured ? "configured" : "not configured (optional)"}</>
            )
          ) : "checking…"}
        </div>
        <Hint>
          Environment variables (server-side, e.g. Vercel → Project Settings → Environment Variables):{" "}
          <span style={{ fontFamily: FONT.mono }}>ANTHROPIC_API_KEY</span> (AI Analyst),{" "}
          <span style={{ fontFamily: FONT.mono }}>H2HGGL_API_URL</span> (optional scraper),{" "}
          <span style={{ fontFamily: FONT.mono }}>BETSAPI_TOKEN</span> (optional fallback).
        </Hint>
      </Card>

      <Card>
        <CardHeader icon={<SettingsIcon size={15} />} title="Model parameters"
          sub="Projection-model tuning lives in the Data view next to the data it feeds on (Data → Model parameters)." />
      </Card>
    </div>
  );
}
