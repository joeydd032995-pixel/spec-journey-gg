'use client';
/* ============================================================================
   Design-system atoms. Every view composes these — no ad-hoc one-off styling
   for shared concepts (cards, stats, fields, badges, buttons, tables).
   ========================================================================== */
import React from "react";
import { C, FONT, SP, RADIUS } from "@/lib/theme";
import type { Player } from "@/lib/model";

/* ----------------------------- containers -------------------------------- */
export const Card = ({ children, style, glow, flush }: {
  children?: React.ReactNode; style?: React.CSSProperties; glow?: boolean; flush?: boolean;
}) => (
  <div style={{
    background: C.surface, border: `1px solid ${glow ? C.accentDim : C.border}`,
    borderRadius: RADIUS.lg, padding: flush ? 0 : SP.lg, overflow: flush ? "hidden" : undefined,
    boxShadow: glow ? `0 0 0 1px ${C.accentDim}, 0 8px 30px -18px ${C.accent}` : "0 4px 6px rgba(0,0,0,.07), 0 1px 3px rgba(0,0,0,.06)",
    ...style,
  }}>{children}</div>
);

/** Card title row: bold title left, actions right. */
export const CardHeader = ({ title, sub, actions, icon }: {
  title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; icon?: React.ReactNode;
}) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: SP.sm, marginBottom: SP.md }}>
    <div style={{ display: "flex", alignItems: "center", gap: SP.sm, minWidth: 0 }}>
      {icon && <span style={{ color: C.accent, display: "inline-flex" }}>{icon}</span>}
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 1.5 }}>{sub}</div>}
      </div>
    </div>
    {actions && <div style={{ display: "flex", gap: SP.sm, flexWrap: "wrap", alignItems: "center" }}>{actions}</div>}
  </div>
);

export const Label = ({ children }: { children?: React.ReactNode }) => (
  <div style={{ fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: C.muted, fontWeight: 700, marginBottom: SP.xs }}>{children}</div>
);

export const Hint = ({ children }: { children?: React.ReactNode }) => (
  <div style={{ marginTop: SP.md, fontSize: 12, color: C.faint, lineHeight: 1.5 }}>{children}</div>
);

/* ----------------------------- badges & pills ---------------------------- */
export type BadgeTone = "pos" | "neg" | "amber" | "blue" | "muted";

export const Badge = ({ tone = "muted", children }: { tone?: BadgeTone; children?: React.ReactNode }) => {
  const map: Record<BadgeTone, [string, string]> = {
    pos: [C.pos, C.accentBg], neg: [C.neg, C.negBg], amber: [C.amber, C.amberBg],
    blue: [C.blue, C.blueBg], muted: [C.muted, C.surface2],
  };
  const [fg, bg] = map[tone] || map.muted;
  return (
    <span style={{ color: fg, background: bg, border: `1px solid ${fg}33`, padding: "2px 8px",
      borderRadius: 999, fontSize: 11, fontWeight: 700, fontFamily: FONT.mono, whiteSpace: "nowrap" }}>{children}</span>
  );
};

export const FactorPill = ({ k, v, tone }: { k: React.ReactNode; v: React.ReactNode; tone?: string }) => (
  <span style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: RADIUS.md,
    padding: "4px 8px", color: C.muted, fontFamily: FONT.mono, fontSize: 11 }}>
    {k} <b style={{ color: tone || C.text }}>{v}</b>
  </span>
);

/* ----------------------------- inputs ------------------------------------ */
export const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", background: C.bg, border: `1px solid ${C.border}`,
  borderRadius: RADIUS.md, color: C.text, padding: "8px 10px", fontSize: 13,
  fontFamily: FONT.mono, outline: "none", minHeight: 36,
};

export const selStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

export const Field = ({ label, value, onChange, type = "text", placeholder, step, mono = true, width }: {
  label?: string; value?: string | number; onChange: (v: string) => void; type?: string;
  placeholder?: string; step?: string | number; mono?: boolean; width?: string | number;
}) => (
  <div style={{ width }}>
    {label && <Label>{label}</Label>}
    <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} type={type} step={step} placeholder={placeholder}
      style={{ ...inputStyle, fontFamily: mono ? FONT.mono : FONT.ui }}
      onFocus={(e) => (e.target.style.borderColor = C.accentDim)}
      onBlur={(e) => (e.target.style.borderColor = C.border)} />
  </div>
);

export function PlayerSelect({ players, value, onChange, label }: {
  players: Player[]; value: string; onChange: (v: string) => void; label?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      {label && <Label>{label}</Label>}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ ...selStyle, color: value ? C.text : C.faint, fontFamily: FONT.ui,
          backgroundImage: `linear-gradient(45deg, transparent 50%, ${C.muted} 50%), linear-gradient(135deg, ${C.muted} 50%, transparent 50%)`,
          backgroundPosition: "right 14px center, right 9px center", backgroundSize: "5px 5px, 5px 5px", backgroundRepeat: "no-repeat" }}>
        <option value="">— select —</option>
        {players.map((p) => <option key={p.name} value={p.name} style={{ background: C.surface }}>{p.name}</option>)}
      </select>
    </div>
  );
}

/* ----------------------------- buttons ------------------------------------ */
export type BtnKind = "primary" | "ghost" | "danger";

export const Btn = ({ children, onClick, kind = "ghost", disabled, style, title }: {
  children?: React.ReactNode; onClick?: () => void; kind?: BtnKind; disabled?: boolean;
  style?: React.CSSProperties; title?: string;
}) => {
  const kinds: Record<BtnKind, React.CSSProperties> = {
    primary: { background: C.accent, color: "#04130c", border: `1px solid ${C.accent}`, fontWeight: 800 },
    ghost: { background: "transparent", color: C.text, border: `1px solid ${C.borderHi}` },
    danger: { background: "transparent", color: C.neg, border: `1px solid ${C.neg}55` },
  };
  return (
    <button onClick={onClick} disabled={disabled} title={title} className="ggba-btn"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: RADIUS.md,
        fontSize: 13, minHeight: 36, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
        fontFamily: FONT.ui, letterSpacing: 0.3, transition: "transform .08s ease, filter .15s",
        ...kinds[kind], ...style }}
      onMouseDown={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "translateY(0)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0)")}>{children}</button>
  );
};

export const iconBtn: React.CSSProperties = {
  background: "transparent", border: "none", color: C.muted, cursor: "pointer",
  padding: SP.xs, display: "inline-flex", borderRadius: RADIUS.sm,
};

/* ----------------------------- stats ------------------------------------- */
export const Stat = ({ label, value, sub, tone }: {
  label?: React.ReactNode; value?: React.ReactNode; sub?: React.ReactNode; tone?: string;
}) => (
  <div style={{ minWidth: 0 }}>
    <Label>{label}</Label>
    <div style={{ fontFamily: FONT.mono, fontSize: 22, fontWeight: 700, color: tone || C.text,
      lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: C.faint, marginTop: SP.xs, lineHeight: 1.4 }}>{sub}</div>}
  </div>
);

/** Dense KPI strip: stats in one row separated by hairline dividers. */
export const StatStrip = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 0 }} className="ggba-statstrip">
    {React.Children.map(children, (child, i) => (
      <div style={{ padding: `${SP.xs}px ${SP.lg}px`, borderLeft: i === 0 ? "none" : `1px solid ${C.border}` }}>{child}</div>
    ))}
  </div>
);

/* ----------------------------- feedback ----------------------------------- */
export const Empty = ({ icon, title, body }: { icon?: React.ReactNode; title?: React.ReactNode; body?: React.ReactNode }) => (
  <div style={{ textAlign: "center", padding: `${SP.xxl + SP.lg}px ${SP.xl}px`, color: C.muted }}>
    <div style={{ display: "inline-flex", padding: SP.lg, borderRadius: RADIUS.lg, background: C.surface2,
      border: `1px solid ${C.border}`, marginBottom: SP.md }}>{icon}</div>
    <div style={{ fontSize: 16, color: C.text, fontWeight: 700, marginBottom: SP.xs }}>{title}</div>
    <div style={{ fontSize: 13, maxWidth: 420, margin: "0 auto", lineHeight: 1.5 }}>{body}</div>
  </div>
);

export const Notice = ({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) => (
  <div style={{ marginBottom: SP.md }}><Badge tone={tone}>{children}</Badge></div>
);

/* ----------------------------- table bits --------------------------------- */
export const tdR: React.CSSProperties = { padding: "8px 12px", textAlign: "right", color: C.text, fontVariantNumeric: "tabular-nums" };

export const thStyle = (align: "left" | "right"): React.CSSProperties => ({
  padding: "10px 12px", textAlign: align, borderBottom: `1px solid ${C.border}`,
  fontWeight: 700, letterSpacing: 0.5, position: "sticky", top: 0, background: C.surface,
  whiteSpace: "nowrap", color: C.muted, fontSize: 11, textTransform: "uppercase",
});

export const tipStyle: React.CSSProperties = {
  background: C.surface, border: `1px solid ${C.borderHi}`, borderRadius: RADIUS.md,
  fontSize: 12, fontFamily: FONT.mono, color: C.text,
};

/** W/L form string rendered as colored letters. */
export const FormDots = ({ form }: { form?: string }) => (
  <span style={{ fontFamily: FONT.mono, letterSpacing: 2 }}>
    {(form || "—").split("").map((c, i) => (
      <span key={i} style={{ color: c === "W" ? C.pos : c === "L" ? C.neg : C.faint }}>{c}</span>
    ))}
  </span>
);
