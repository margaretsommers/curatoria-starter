---
name: Curatoria Demo Design System
version: 1.0.0
description: A compact paid markdown demo for proving Curatoria catalog discovery and x402 delivery.
author: Curatoria
license: Demo license - single-project evaluation after purchase
brand:
  personality: "Precise, useful, agent-readable"
colors:
  primary: "#4F46E5"
  background: "#FFFFFF"
  surface: "#F8FAFC"
  text:
    primary: "#0F172A"
    secondary: "#334155"
  status:
    success: "#16A34A"
    warning: "#D97706"
typography:
  fontFamily: "Inter, system-ui, sans-serif"
  scale:
    small: "0.875rem"
    base: "1rem"
    heading: "1.5rem"
spacing:
  unit: "4px"
  rhythm: [1, 2, 3, 4, 6, 8]
radii:
  sm: "6px"
  md: "10px"
  lg: "14px"
---

## Design Principles

Build for fast comprehension. Agents and humans should both be able to infer the core interface rules from the token names, component notes, and examples.

## Color Usage

- Use `primary` for one decisive action per screen.
- Use `surface` for cards, empty states, and table headers.
- Keep status colors semantic; do not use them as decorative accents.

## Component Patterns

### Buttons

- Primary actions: filled `primary` background with white text.
- Secondary actions: neutral surface, subtle border, and `text.primary`.
- Destructive actions: explicit label plus confirmation when irreversible.

### Cards

- Use `md` radius and modest shadow.
- Keep nested cards rare; prefer section dividers for dense content.

### Forms

- Use single-column forms by default.
- Show validation copy next to the failing field, not in a global alert only.
