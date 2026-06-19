---
name: Minimal SaaS Design System
version: 1.0.0
description: Clean, minimal design tokens for B2B SaaS products
author: Design Paywall Service
license: Proprietary — single-project use per purchase
colors:
  primary: "#2563EB"
  primary_hover: "#1D4ED8"
  primary_light: "#DBEAFE"
  secondary: "#64748B"
  secondary_hover: "#475569"
  background: "#FFFFFF"
  surface: "#F8FAFC"
  surface_raised: "#F1F5F9"
  border: "#E2E8F0"
  border_strong: "#CBD5E1"
  border_focus: "#2563EB"
  text:
    primary: "#0F172A"
    secondary: "#475569"
    muted: "#94A3B8"
    inverse: "#FFFFFF"
    link: "#2563EB"
    link_hover: "#1D4ED8"
  status:
    success: "#16A34A"
    success_bg: "#DCFCE7"
    warning: "#D97706"
    warning_bg: "#FEF3C7"
    error: "#DC2626"
    error_bg: "#FEE2E2"
    info: "#0284C7"
    info_bg: "#E0F2FE"
typography:
  fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
  fontFamilyMono: "JetBrains Mono, 'Fira Code', Menlo, monospace"
  scale:
    xs: "0.75rem"
    sm: "0.875rem"
    base: "1rem"
    lg: "1.125rem"
    xl: "1.25rem"
    2xl: "1.5rem"
    3xl: "1.875rem"
    4xl: "2.25rem"
    5xl: "3rem"
  weight:
    light: 300
    normal: 400
    medium: 500
    semibold: 600
    bold: 700
  lineHeight:
    tight: 1.25
    snug: 1.375
    normal: 1.5
    relaxed: 1.625
    loose: 2
  letterSpacing:
    tight: "-0.025em"
    normal: "0"
    wide: "0.025em"
    wider: "0.05em"
    widest: "0.1em"
spacing:
  unit: "4px"
  scale:
    px: "1px"
    0: "0"
    0.5: "2px"
    1: "4px"
    1.5: "6px"
    2: "8px"
    2.5: "10px"
    3: "12px"
    3.5: "14px"
    4: "16px"
    5: "20px"
    6: "24px"
    7: "28px"
    8: "32px"
    9: "36px"
    10: "40px"
    11: "44px"
    12: "48px"
    14: "56px"
    16: "64px"
    20: "80px"
    24: "96px"
    28: "112px"
    32: "128px"
borderRadius:
  none: "0"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  3xl: "24px"
  full: "9999px"
shadows:
  none: "none"
  xs: "0 1px 2px 0 rgba(0, 0, 0, 0.04)"
  sm: "0 1px 3px 0 rgba(0, 0, 0, 0.06), 0 1px 2px -1px rgba(0, 0, 0, 0.06)"
  md: "0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05)"
  lg: "0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -4px rgba(0, 0, 0, 0.05)"
  xl: "0 20px 25px -5px rgba(0, 0, 0, 0.08), 0 8px 10px -6px rgba(0, 0, 0, 0.05)"
  2xl: "0 25px 50px -12px rgba(0, 0, 0, 0.15)"
  inner: "inset 0 2px 4px 0 rgba(0, 0, 0, 0.05)"
animation:
  duration:
    instant: "50ms"
    fast: "100ms"
    normal: "200ms"
    slow: "300ms"
    slower: "500ms"
  easing:
    default: "cubic-bezier(0.4, 0, 0.2, 1)"
    in: "cubic-bezier(0.4, 0, 1, 1)"
    out: "cubic-bezier(0, 0, 0.2, 1)"
    spring: "cubic-bezier(0.34, 1.56, 0.64, 1)"
breakpoints:
  sm: "640px"
  md: "768px"
  lg: "1024px"
  xl: "1280px"
  2xl: "1536px"
zIndex:
  base: 0
  raised: 10
  dropdown: 100
  sticky: 200
  overlay: 300
  modal: 400
  toast: 500
  tooltip: 600
---

## Design Principles

**Clarity over cleverness.** Every UI element should communicate its purpose immediately. If a component needs explanation, it needs redesign.

**Density without crowding.** B2B users spend all day in the interface. Tight spacing preserves screen real estate while breathing room preserves focus. Aim for information density with visual rest.

**Trust through consistency.** Predictable patterns reduce cognitive load and build user confidence. Avoid creative deviations in functional components — save creativity for marketing surfaces.

**Accessibility is not optional.** All colour pairs meet WCAG AA (4.5:1 for body, 3:1 for large text). Never rely on colour alone to convey meaning.

---

## Colour Usage

### Primary (#2563EB)
Use for: primary buttons, active navigation states, links, focus rings, selected checkboxes and radio buttons, progress indicators.

Never use for: decorative backgrounds, text on white (use `text.link` instead), status indicators.

The `primary_light` (#DBEAFE) swatch is for hover backgrounds on secondary buttons and subtle selected-state fills.

### Secondary (#64748B)
Use for: secondary action buttons, icon fills, form labels, table column headers, tag backgrounds.

### Surface colours
- `background` (#FFFFFF) — page background, modal backgrounds
- `surface` (#F8FAFC) — card backgrounds, sidebar fills, table header rows
- `surface_raised` (#F1F5F9) — hover states on cards, secondary button backgrounds, code block backgrounds

### Text scale
- `text.primary` (#0F172A) — all body copy, headings, form values
- `text.secondary` (#475569) — supporting text, descriptions, captions, secondary labels
- `text.muted` (#94A3B8) — placeholder text, disabled values, empty states, timestamps
- `text.inverse` (#FFFFFF) — text on dark or coloured backgrounds

### Status colours
Always pair status backgrounds with their corresponding foreground:
- Success: `status.success` text on `status.success_bg` background
- Warning: `status.warning` text on `status.warning_bg` background
- Error: `status.error` text on `status.error_bg` background
- Info: `status.info` text on `status.info_bg` background

---

## Typography

### Hierarchy

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Page title | 3xl / 4xl | semibold | tight |
| Section heading | xl / 2xl | semibold | snug |
| Card title | lg | semibold | snug |
| Body copy | base | normal | normal |
| UI label | sm | medium | normal |
| Caption / helper | xs | normal | normal |
| Code | base (mono) | normal | relaxed |

### Font loading
Use the `Inter` variable font from Google Fonts or Fontsource. Load only weights 400, 500, 600, and 700 to limit download size. Use `font-display: swap` to avoid invisible text during load.

### Monospace
Use `fontFamilyMono` for: code blocks, terminal output, API keys, technical identifiers, version numbers, and any value that must be read character-by-character.

---

## Spacing System

Built on a 4px base unit. All spacing values are multiples of 4. Never use arbitrary pixel values — always reference a named scale token.

**Component internal padding:**
- Compact (table cells, tags): `spacing.2` to `spacing.3` (8–12px)
- Default (buttons, inputs): `spacing.3` to `spacing.4` (12–16px)  
- Comfortable (cards, modals): `spacing.5` to `spacing.6` (20–24px)

**Between related elements (sibling spacing):**
- Inline items (icon + label): `spacing.1.5` to `spacing.2` (6–8px)
- Form fields: `spacing.4` to `spacing.5` (16–20px)
- List items: `spacing.2` to `spacing.3` (8–12px)

**Between sections:**
- Within a card: `spacing.6` to `spacing.8` (24–32px)
- Between cards or major sections: `spacing.8` to `spacing.12` (32–48px)
- Page-level sections: `spacing.16` to `spacing.24` (64–96px)

**Page margins:**
- Mobile: `spacing.4` (16px)
- Tablet: `spacing.6` (24px)
- Desktop: `spacing.8` to `spacing.12` (32–48px)

---

## Component Patterns

### Buttons

**Primary:** `primary` background, `text.inverse` text, `borderRadius.md`, no border. Hover: `primary_hover`. Focus: `border_focus` ring (3px, offset 2px).

**Secondary:** `surface_raised` background, `text.primary` text, `border` border (1px), `borderRadius.md`. Hover: `surface` background, `border_strong` border.

**Ghost:** transparent background, `primary` text, no border. Hover: `primary_light` background. Use for tertiary actions in tight spaces.

**Danger:** `status.error` background, `text.inverse` text. Reserve for destructive, irreversible actions.

**Disabled state:** 50% opacity on all variants. Never change colour or shape — opacity alone signals disabled.

**Sizing:**
- sm: `spacing.2` vertical, `spacing.3` horizontal, `typography.sm`
- md (default): `spacing.2.5` vertical, `spacing.4` horizontal, `typography.base`
- lg: `spacing.3` vertical, `spacing.5` horizontal, `typography.lg`

### Form Inputs

Structure: label above (never placeholder-as-label), input, optional helper text below.

Input states:
- Default: `border` border (1px), `background` fill, `borderRadius.md`
- Focus: `border_focus` border, box-shadow `0 0 0 3px rgba(37, 99, 235, 0.15)`
- Error: `status.error` border, error message below in `status.error` colour
- Disabled: `surface` background, `border` border, `text.muted` text

Label: `typography.sm`, `weight.medium`, `text.secondary`, `spacing.1.5` below label.
Helper text: `typography.xs`, `text.muted`, `spacing.1.5` above helper text.

### Cards

```
background:    background (#FFFFFF)
border:        1px solid border (#E2E8F0)
border-radius: borderRadius.lg (8px)
box-shadow:    shadows.sm
padding:       spacing.6 (24px)
```

Use `surface` (#F8FAFC) for cards nested inside other cards (e.g. a highlighted section inside a settings card). Add `shadows.md` when the card is interactive (clickable).

### Data Tables

- Header row: `surface` background, `text.secondary` labels, `typography.sm`, `weight.semibold`
- Body rows: alternating `background` / `surface` (optional), `border` bottom divider
- Cell padding: `spacing.3` vertical, `spacing.4` horizontal
- Hover state: `primary_light` background tint on interactive rows
- Sticky header: `surface` background with `shadows.sm` bottom border

### Navigation (Sidebar)

- Container: `surface` background, `border` right border (1px)
- Item default: `text.secondary`, `typography.sm`, `weight.medium`, `borderRadius.md`, `spacing.2` vertical `spacing.3` horizontal
- Item hover: `surface_raised` background, `text.primary`
- Item active: `primary_light` background, `primary` text, `weight.semibold`
- Section headers: `text.muted`, `typography.xs`, `weight.semibold`, `letterSpacing.wider`, uppercase

### Modals / Dialogs

```
background:    background (#FFFFFF)
border-radius: borderRadius.xl (12px)
box-shadow:    shadows.2xl
padding:       spacing.8 (32px)
max-width:     480px (sm), 640px (md), 768px (lg)
backdrop:      rgba(15, 23, 42, 0.5) — text.primary at 50% opacity
```

Always trap focus inside open modals. Close on Escape. Provide a visible close button.

### Toast Notifications

Position: bottom-right, `spacing.6` from edges.
Width: 320px–400px.
Stack: newest on top, `spacing.2` gap between toasts.

```
border-radius: borderRadius.lg
box-shadow:    shadows.lg
padding:       spacing.4 spacing.5
border-left:   4px solid <status colour>
```

Auto-dismiss after 4 seconds (success/info). Persist until dismissed (error/warning).

### Badges / Tags

Inline status indicators: `typography.xs`, `weight.medium`, `borderRadius.full`, `spacing.1` vertical `spacing.2` horizontal.

Use status background + foreground colour pairs from the status colour tokens.

---

## Motion

Use animation sparingly — B2B users value predictability over delight.

- **Micro-interactions** (button press, checkbox toggle): `animation.duration.fast` (100ms), `animation.easing.default`
- **Panel transitions** (sidebar expand, accordion): `animation.duration.normal` (200ms), `animation.easing.out`
- **Modal enter/exit**: `animation.duration.slow` (300ms), `animation.easing.out` (enter) / `animation.easing.in` (exit)
- **Page transitions**: avoid — use skeleton loaders instead

Respect `prefers-reduced-motion`. When set, replace transitions with instant state changes.

---

## Layout

### Grid
12-column grid. Gutters: `spacing.4` (mobile), `spacing.6` (tablet), `spacing.8` (desktop).

### Container widths
- Narrow (forms, auth): max-width 480px
- Default (content pages): max-width 768px
- Wide (dashboards): max-width 1280px
- Full bleed (data-heavy): max-width 100%

### Z-index ladder
Use the named `zIndex` tokens. Never use arbitrary values like `z-index: 9999`.

| Layer | Token | Use |
|-------|-------|-----|
| Base | 0 | Default stacking |
| Raised | 10 | Cards, sticky table headers |
| Dropdown | 100 | Menus, autocomplete |
| Sticky | 200 | Sticky navbars |
| Overlay | 300 | Drawer overlays |
| Modal | 400 | Dialogs |
| Toast | 500 | Notification toasts |
| Tooltip | 600 | Tooltips |
