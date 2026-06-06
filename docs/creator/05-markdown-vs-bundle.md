# 05 - Markdown Vs Bundle

> **Available today:** yes
> **Requires terminal:** yes

Curatoria supports two sellable formats today. Use a Markdown product when the value is mostly structured knowledge. Use a bundle when the buyer needs files.

## Markdown Products

Markdown products are served as text after payment. They work well for:

- Design token documentation.
- Brand or component guidelines.
- Promptable implementation rules.
- Research summaries or frameworks.
- Agent-readable creative direction.

Markdown is usually the best first product because agents can read it directly and apply it in the same workflow.

Minimum useful shape:

```markdown
---
name: Starter Demo Design System
version: 1.0.0
colors:
  primary: "#2563EB"
  background: "#FFFFFF"
typography:
  fontFamily: "Inter, sans-serif"
spacing:
  unit: "4px"
---

## Design Principles

Explain when and why to use this system.

## Component Patterns

Describe buttons, forms, cards, layouts, and interaction choices.
```

Publish Markdown with:

```bash
npm run publish-design -- \
  --id starter-demo \
  --file design-systems/starter-demo.md \
  --name "Starter Demo Design System" \
  --price 0.01 \
  --desc "Starter demo product" \
  --tags demo,starter
```

## Bundle Products

Bundle products are zip downloads after payment. They work well for:

- Icon sets.
- Figma exports or template files.
- Image assets.
- Multi-file starter kits.
- A Markdown guide plus supporting files.

Keep bundles predictable:

- Use clear folder names.
- Include a `README.md`.
- Include a `LICENSE.md` or usage terms.
- Avoid surprise file types.
- Keep filenames deterministic so support is easier.

Publish bundles with:

```bash
npm run publish-pack -- \
  --id starter-bundle \
  --zip design-systems/starter-bundle.zip \
  --name "Starter Bundle" \
  --price 0.03 \
  --desc "Starter demo bundle" \
  --tags demo,bundle
```

## Which Should I Choose?

| Choose | When |
| --- | --- |
| Markdown | The buyer or agent needs instructions, tokens, rationale, or reusable knowledge. |
| Bundle | The buyer needs actual files, templates, exports, or assets. |
| Both | The paid experience needs a guide plus a downloadable asset set. |

If you are unsure, start with Markdown. It is easier to inspect, easier for agents to use, and easier to revise quickly.

## Route Differences

Markdown products use:

```text
GET /design-systems/:id
```

Bundle products use:

```text
GET /packs/:id/download
```

Both routes issue a `402 Payment Required` response when unpaid, then return the content after a valid `X-PAYMENT` header is verified and settled.
