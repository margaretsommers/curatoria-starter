# Connect Your Storage

> **Available today:** partial
> **Requires terminal:** yes

Storage connectors are planned, not built yet. Today, Curatoria reads sellable files from the local `design-systems/` folder inside your repo.

This means you can publish products now, but you need to copy or generate the files into the project before registering them.

## Today

Use `design-systems/` as your source of truth for published products:

```text
design-systems/
|-- .registry.json
|-- example-minimal.md
|-- your-design-system.md
`-- your-bundle.zip
```

The server uses two things:

- the product file, such as `your-design-system.md` or `your-bundle.zip`;
- a registry entry in `design-systems/.registry.json`.

The easiest path is to publish with the CLI:

```bash
npm run publish-design -- \
  --id your-product-id \
  --file design-systems/your-design-system.md \
  --name "Your Product Name" \
  --price 0.05 \
  --desc "Short description" \
  --tags design,tokens
```

For a zip bundle:

```bash
npm run publish-pack -- \
  --id your-bundle-id \
  --zip design-systems/your-bundle.zip \
  --name "Your Bundle Name" \
  --price 0.10 \
  --desc "Short bundle description" \
  --tags assets,bundle
```

The server reads the registry fresh from disk, so changes are available without restarting the dev server.

## Current Workaround

If your files live in Google Drive, Dropbox, iCloud Drive, Notion exports, or another system, use this workflow for now:

1. Export or copy the finished file to your local machine.
2. Place the sellable `.md` or `.zip` file under `design-systems/`.
3. Publish it with `npm run publish-design` or `npm run publish-pack`.
4. Confirm the product appears in `/.well-known/design-catalog.json`.
5. Confirm the paid route returns `402` when unpaid.

For repeat publishing, keep a simple local staging folder and copy only final products into `design-systems/`. Avoid pointing the registry at temporary downloads, personal cloud sync paths, or files outside the repo.

## Planned

The planned storage path is to let creators connect existing storage without manually moving files into the repo. Candidate connectors include:

- Google Drive;
- Dropbox;
- iCloud Drive;
- creator-owned domains or hosted folders;
- object storage for larger catalogs.

When storage connectors ship, this chapter should change from "copy files into `design-systems/`" to "connect a folder, choose products, set prices, and publish."

## What Not To Assume Yet

The starter does not currently:

- sync from Google Drive, Dropbox, or iCloud;
- watch arbitrary folders outside `design-systems/`;
- upload files to object storage automatically;
- provide a browser UI for selecting files;
- register cloud-hosted files directly as paid Curatoria products.

Until those features exist, `design-systems/` is the supported storage location.
