---
name: ui-ux-pro
description: >
  General-purpose UI/UX design skill — invoke before any component creation, page design,
  visual review, refactor, color or typography decision, or data visualization task.
  Synthesizes impeccable, ui-ux-pro-max, refactoring-ui, ui-aesthetics-skill,
  ux-ui-agent-skills, designer-skills, and xora patterns into a single authoritative
  reference for producing professional, accessible, non-generic UI.
triggers:
  - design
  - component
  - ui
  - style
  - visual
  - layout
  - chart
  - refactor
  - review design
  - accessibility
  - color
  - typography
  - animation
---

# UI/UX Pro — General-Purpose Design Skill

Synthesized from: **impeccable** · **ui-ux-pro-max** · **refactoring-ui** · **ui-aesthetics-skill** · **ux-ui-agent-skills** · **designer-skills** · **xora**

---

## 1. When to Use / Skip

**Invoke for:** component creation, page design, visual review, refactor, color or typography decision, chart/data visualization, animation, interaction states, accessibility audit.

**Skip for:** backend logic, API design, database schema, infrastructure, or performance work unrelated to rendering.

---

## 2. Task Classification

Route the request into one of six types before starting. The type determines your workflow order.

| # | Type | Definition |
|---|---|---|
| 1 | **Generate** | New page, section, or component from scratch |
| 2 | **Review** | Diagnose/critique existing UI — biggest structural failure first, not CSS details |
| 3 | **Refactor** | Rewrite existing code — choose: light polish / medium restructure / full rebuild |
| 4 | **Component Polish** | Refine controls, cards, tables, modals without structural change |
| 5 | **State/Motion** | Fix interaction feedback and transitions |
| 6 | **Data Viz** | Chart type → color → accessibility → responsive behavior |

---

## 3. Priority Rules

These are ordered. A higher rule overrides a lower one without discussion.

### CRITICAL — never violate

- **Contrast:** ≥ 4.5:1 for normal text, ≥ 3:1 for large text/UI components (WCAG AA)
  - *Flip trick:* if white text on a colored background is hard to read, don't darken the bg to near-black — switch to dark text on a light-tinted background instead
- **Touch targets:** ≥ 44×44px for all interactive elements; ≥ 8px gap between adjacent targets
- **Focus rings:** always visible on keyboard-navigable elements; never bare `outline: none` without a replacement ring
- **No emoji as structural icons** — use a consistent SVG icon system (Lucide, Heroicons, Phosphor)
- **Color alone never conveys meaning** — always pair status colors with an icon or text label

### HIGH

- **Composition first** — establish layout and information hierarchy before adding color, shadows, or effects
- **Spacing rhythm:** only the 4px scale — `4 8 12 16 24 32 48 64 96 128px` — no arbitrary values
- **Type scale:** hand-picked `12 14 16 18 20 24 30 36 48 60 72px` — never ratio-generated sizes
- **Line measure:** 45–75 characters per line; body line-height 1.5–1.7; heading line-height 1.0–1.2
- **Mobile-first:** explicit layout behavior at 375px · 768px · 1280px · 1440px; no horizontal scroll
- **Responsive scaling:** large elements shrink faster than small elements at mobile breakpoints

### MEDIUM

- **Semantic color tokens** — name things (`color-primary`, `color-surface`, `color-error`) rather than embedding raw hex in component code
- **Animation timing:** 150–300ms for micro-interactions; ≤ 80ms for press/active feedback; always respect `prefers-reduced-motion`
- **Forms:** visible label always; error message below the field, not as a tooltip; never placeholder-only; validate inline on blur with clear recovery path
- **Charts:** tooltip always; axis labels with units; legend for multi-series; accessible color pairs; table fallback for screen readers

### LOW

- **Glow effects:** exceptional, not structural — reserve for key active/selected states only
- **Shadows:** use only to describe layering — each shadow must justify a z-level (see §9)
- **Easing:** `ease-out` or `cubic-bezier(0.16, 1, 0.3, 1)`; never bounce or elastic easing

---

## 4. Generation Workflow

Run steps in order. Do not skip to color before structure is working.

1. Identify artifact type and exact scope — do not expand without request
2. Name the intended impression: *"calm data clarity"* / *"assertive dashboard"* / *"approachable onboarding"*
3. Build structural skeleton first (no color, no shadows, no effects)
4. Apply spacing rhythm using only the 4px scale
5. Set typographic hierarchy through weight and color — not just size
6. Define all component states: default → hover → focus → active → disabled → error → loading → empty
7. Color system: neutrals first, then one strong accent — one clear primary action per screen
8. Depth cues in order: border → shadow → blur — each layer must explain a z-level
9. Motion last — only after the static composition works
10. **Grayscale test:** *"If the layout fails without color, the structure is not solved yet."*

---

## 5. Visual Hierarchy

*Source: refactoring-ui/hierarchy.md*

**Size alone is not enough.** Use weight and color together:
- Primary content: weight 600–700, high-contrast color
- Secondary: weight 400, muted/grey color
- Tertiary: weight 400, faint/light-grey color

**De-emphasize to emphasize.** If the primary element doesn't stand out, weaken the competing elements rather than amplifying the primary.

**Avoid `Label: Value` formats.** Combine into natural phrases ("12 left in stock"). When labels are required (data dashboards), treat them as supporting content — smaller, lighter weight, UPPERCASE with letter-spacing — and emphasize the data value itself.

**Visual hierarchy ≠ document hierarchy.** An `<h2>` section title can be small and subtle. Semantic tags don't dictate visual weight.

**Icons are visually heavy.** Give icons a softer color (lower contrast) to balance them against adjacent text.

**Button hierarchy by role, not just semantics:**
- Primary: solid, high-contrast fill
- Secondary: outline or low-contrast fill
- Tertiary: link style (no container)
- Destructive: red/bold *only* in the confirmation context where it is the primary action — not on every delete button

---

## 6. Color System

*Source: refactoring-ui/color.md + xora design system*

### Always work in HSL

```
Hue:        0–360° (the color itself)
Saturation: 0% = grey, 100% = vivid
Lightness:  0% = black, 100% = white
```

### Building shade scales

You need more shades than you think:
- **Greys:** 8–10 shades, tinted slightly blue (cool) or yellow (warm) — never dead `hsl(0,0%,50%)`
- **Primary:** 5–10 shades of your brand color
- **Semantic accents** (error/warning/success): multiple shades — light variants for backgrounds, dark variants for text

### The shade curve (critical)

As lightness approaches 0% or 100%, perceived saturation drops. Compensate:
- Increase saturation at the very light and very dark ends of the scale
- Rotate hue slightly as lightness changes:
  - Darker shades → rotate toward blue/purple/red
  - Lighter shades → rotate toward yellow/cyan
- This produces natural-looking, non-dead shades

### Contrast accessibility

- 4.5:1 minimum for normal text; 3:1 for large text/UI components
- Flip contrast: if white text on a colored background is failing, switch to dark text on a light-tinted background instead of darkening the background to near-black
- Color-blind safe: icons or text labels must accompany all status indicators — hue alone is insufficient

### Dark theme

- Surface hierarchy via subtle HSL lightness steps — not heavy shadows
- Text: cool-neutral near-white e.g. `hsl(220, 15%, 90%)` — not pure `#ffffff`
- Avoid warm white, cream, or beige on dark surfaces — reads as broken dark mode
- **Energetic dark accents:** cyan (#2EF2FF range) or electric green work well on dark navy/near-black backgrounds
- Glow: only on interactive accent states — not structural decoration

### Light theme

- Cool-neutral surfaces — avoid warm white as a false "premium" signal
- Keep default states visually quiet; reserve emphasis for interaction and semantic states

---

## 7. Spacing & Layout

*Source: refactoring-ui/layout-spacing.md*

### The only valid spacing values

```
4   8   12   16   24   32   48   64   96   128px
```
No arbitrary values. No 123px. No 37px.

### Grouping rule

Space **between** groups must be larger than space **within** groups. This is how you communicate relationships without borders or dividers.

### Canvas sizing

If content needs 600px wide, give it 600px — don't stretch to fill the screen. Content doesn't need to justify its margins to the user.

### Layout patterns

- Fixed-width sidebar + flexible main content outperforms rigid equal-column grids for most UIs
- Use `max-width` (not percentages) for text containers
- Dense interfaces (dashboards, admin panels) are an intentional choice — not the default

### Responsive

- Explicit layout behavior at 375px, 768px, 1280px, 1440px
- Large elements shrink faster than small elements going mobile
- Recompose mobile layouts — don't just collapse columns

---

## 8. Typography

*Source: refactoring-ui/typography.md + xora*

### Type scale (only these values)

```
12   14   16   18   20   24   30   36   48   60   72px
```
Use `rem` or `px`. Stay on the scale — no arbitrary sizes.

### Font selection

- Neutral sans-serif with ≥ 5 weights for body/UI text
- Serif or display fonts for editorial moments only
- Avoid condensed typefaces with short x-heights for body text
- **Proven pairings (xora):** Inter for numbers/data, Poppins for body; Archivo for bold display headings

### Line length and rhythm

- 45–75 characters per line for body text
- Body line-height: 1.5–1.7
- Heading line-height: 1.0–1.2

### Alignment

- Left-align all standard readable text
- Never justify text on web without CSS hyphenation
- Center only for headlines or blocks of ≤ 3 lines
- Right-align tabular/numeric columns

### Letter spacing

- Reduce spacing for large display headings (they're set too loose by default)
- Increase spacing for ALL-CAPS text

---

## 9. Shadows & Depth

*Source: refactoring-ui/depth-and-polish.md + xora shadow system*

### Light source rule

The light source is always the top of the screen — consistent across the entire interface:
- **Raised elements:** light top border (highlight) + dark bottom shadow
- **Inset/well elements:** dark top inner-shadow + light bottom border

### 5-level shadow system

Every shadow must justify which z-level it represents:

```
Level 1 — Button/close-to-surface:  0 1px 2px rgba(0,0,0,.05)
Level 2 — Card:                      0 4px 6px rgba(0,0,0,.07),
                                      0 1px 3px rgba(0,0,0,.06)
Level 3 — Dropdown:                  0 10px 15px rgba(0,0,0,.10),
                                      0 4px 6px rgba(0,0,0,.05)
Level 4 — Modal:                     0 20px 25px rgba(0,0,0,.10),
                                      0 8px 10px rgba(0,0,0,.04)
Level 5 — Tooltip/top-layer:        0 25px 50px rgba(0,0,0,.25)
```

### Two-part shadow formula

Combine: a large, soft ambient shadow (general depth) + a tight, dark occlusion shadow (ground contact near the object).

### Dark theme glow system (xora reference)

When using glow on dark backgrounds:
- Buttons: `inset 0px 2px 4px rgba(255,255,255,.05)` + small colored outer shadow at the accent hue
- Accent lines/dividers: directional glow (e.g. `box-shadow: 0 0 8px hsl(183, 100%, 60%)`)
- Atmospheric background blur: 100–200px blur radius on background elements only — never on interactive components
- Glow is earned, not default — apply it to one or two key accent moments per screen

### Flat depth (no shadows)

- Overlap elements to create depth (card floating halfway off a colored section background)
- Lighter color = closer to viewer; darker = further

---

## 10. Interaction States

Every interactive component must have all six states:

| State | Description |
|---|---|
| **Default** | Visually quiet baseline — emphasis reserved for interaction |
| **Hover** | Subtle brightness/border/underline shift; 80–150ms transition |
| **Focus** | Visible ring (2px min); must work keyboard-only; never just `outline:none` |
| **Active/Pressed** | Immediate tactile feedback — scale down or darken; ≤ 80ms |
| **Disabled** | Opacity 0.4; `cursor: not-allowed`; `pointer-events: none` |
| **Loading** | Skeleton, spinner, or shimmer; never block the full page for component-level loading |

Semantic states (add where applicable):

| State | Guidance |
|---|---|
| **Error** | Red/destructive; message below the field, never as tooltip; icon + text (not color alone) |
| **Success** | Green confirmation; auto-dismiss after 3–5s |
| **Empty** | Illustration or descriptive text + a clear primary CTA; never leave a container blank |

**Distinguish:** persistent selected states from transient active/pressed feedback — they must not look the same.

---

## 11. Charts & Data Visualization

*Source: ui-ux-pro-max (25 chart types, 10 dashboard styles)*

### Chart selection by data shape

| Data shape | Best chart |
|---|---|
| Trend over time | Line or area chart |
| Category comparison | Horizontal bar (labels fit; easier to read) |
| Part-to-whole (≤ 5 segments) | Donut chart |
| Correlation | Scatter plot |
| Distribution | Histogram or box plot |
| Progress toward a goal | Linear progress bar or gauge |
| High-density multi-metric dashboard | Data table with inline sparklines |
| Comparative multi-series over time | Grouped bar or multi-line chart |

### Non-negotiables for every chart

- Tooltip always (shows exact values on hover)
- Axis labels with units (never unlabelled axes)
- Legend for multi-series data
- Color pairs with ≥ 3-step lightness difference between adjacent series — no rainbow palettes
- Table alternative available for screen readers
- Charts must reflow at mobile breakpoints — remove detail before removing meaning

### Analytics dashboard design (ui-ux-pro-max)

- **Data-dense layout** is intentional — pair density with strong typographic hierarchy so the signal is obvious
- **Predictive/analytics dashboards:** lead with the signal (the insight), bury the supporting noise
- **Monospace font** for all numeric data — enables alignment, avoids jitter between refreshes
- **KPI cards:** one metric per card; use secondary text for context (delta, time range), not decoration

---

## 12. Anti-Patterns to Reject

*Source: impeccable (44 deterministic rules) + ux-ui-agent-skills taste doctrine + ui-aesthetics-skill*

### AI slop signals — reject immediately

- Default Inter for every project without intentional reasoning
- Purple-to-blue decorative gradient backgrounds
- Cards nested inside cards
- Bounce or elastic CSS easing
- Side-tab active-state borders (the left-border-only navigation indicator)
- Dark glow on every element
- Gradient badges and pill-shaped tags everywhere
- Equal-weight modules with no reading order — the eye has no path

### Composition failures

- **Scope inflation:** a component request becomes a full page without being asked
- **Narrow shell:** pages boxed into a centered 600px shell when full-width is appropriate
- **False asymmetry:** forced asymmetric layouts with no visual anchor
- **Column collapse:** mobile that merely stacks desktop columns without recomposing the layout

### Color/surface failures

- Warm whites (cream, beige) on dark surfaces — reads as broken dark mode
- Grey text placed on colored/accent backgrounds
- Pure `#000000` black or pure `#808080` grey — always tint toward the primary hue
- Overusing the accent color — one clear primary action per screen

### Typography failures

- Font sizes outside the hand-picked type scale
- Justified text without CSS hyphenation
- Centered text blocks longer than 3 lines
- `Label: Value` pairs when a natural phrase works

### Motion failures

- Animation that attracts attention rather than guiding it
- Selected states that look identical to pressed/click feedback
- Every layer floating at once in the depth system
- Decorative animations without a `prefers-reduced-motion` fallback

---

## 13. Finishing Touches

*Source: refactoring-ui/depth-and-polish.md*

- **Accent borders:** a 4px top-border in the brand color on a bland card or alert adds personality without graphic design skills
- **Empty states:** always provide an illustration (or icon) + primary CTA — never leave a container blank
- **Lists → icons:** replace default bullets with checkmarks or Lucide icons for the context
- **Link underlines:** offset and color-match them rather than leaving browser defaults
- **User-uploaded images:** always constrain aspect ratio with `object-fit: cover`; add a subtle inset shadow (`inset 0 0 0 1px rgba(0,0,0,.1)`) to prevent color bleed at the edges
- **Screenshot embedding:** never scale down full screenshots (text becomes illegible); crop to a detail view, or recreate as a simplified UI illustration

---

## 14. Style Reference (ui-ux-pro-max — 67 available styles)

When a project requires a defined aesthetic, pick one and be consistent. Common options:

**Minimal/clean:** Minimalism, Flat Design, Swiss Modernism 2.0, Exaggerated Minimalism
**Rich/textured:** Glassmorphism, Neumorphism, Claymorphism, Soft UI Evolution, Dimensional Layering
**Dark/tech:** Dark Mode, Cyberpunk UI, HUD/Sci-Fi FUI, Aurora UI, Retro-Futurism
**Analytics-specific:** Data-Dense Dashboard, Executive Dashboard, Real-Time Monitoring, Predictive Analytics, Comparative Analysis
**Expressive:** Neubrutalism, Bento Box Grid, Memphis Design, Kinetic Typography, Gen Z Maximalism
**Emerging:** AI-Native UI, Spatial UI (VisionOS), Voice-First Multimodal, Biomimetic/Organic

Mix deliberately — picking two compatible styles is fine; picking five is incoherence.

---

## 15. Self-Critique Checklist

Run this before delivering any UI output.

**Scope**
- [ ] Result stayed within the exact requested scope — no unrequested additions
- [ ] Primary message or action is obvious within 3 seconds

**Structure**
- [ ] Layout holds in grayscale (structure doesn't rely on color to make sense)
- [ ] All spacing uses only 4px-scale values
- [ ] All font sizes use only hand-picked type scale values

**Accessibility**
- [ ] Body text contrast ≥ 4.5:1 verified
- [ ] All interactive elements ≥ 44×44px
- [ ] Focus rings visible on all keyboard-navigable elements
- [ ] No emoji as structural icons; consistent SVG icon family used
- [ ] Status colors paired with icon or text label (not color alone)

**Polish**
- [ ] All 6 interaction states defined for interactive components
- [ ] No bounce/elastic easing; all motion ≤ 300ms
- [ ] Glow is rare — only one or two key accent states per screen
- [ ] Charts: tooltip, accessible color pairs, and axis labels all present
- [ ] Mobile viewport: primary content/action preserved; no horizontal scroll
- [ ] No AI-slop signals: no card-in-card, no default Inter, no purple gradient, no bounce easing, no side-tab borders

---

*Sources: [impeccable](https://github.com/pbakaus/impeccable) · [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) · [ui-aesthetics-skill](https://github.com/kasonye/ui-aesthetics-skill) · [refactoring-ui-skill](https://github.com/LovroPodobnik/refactoring-ui-skill) · [ux-ui-agent-skills](https://github.com/plugin87/ux-ui-agent-skills) · [designer-skills](https://github.com/Owl-Listener/designer-skills) · [xora](https://github.com/adrianhajdin/xora)*
