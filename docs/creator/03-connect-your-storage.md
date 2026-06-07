# Connect Your Storage

> **Available today:** yes (local folder, your-domain URL, Google Drive)
> **Requires terminal:** yes

Curatoria can sell a product whose bytes live in one of three places. You pick the
source per product when you publish it. Only catalog metadata (name, price, tags)
ever lives in your repo — for URL and Google Drive sources, the file itself stays
where it is and is fetched on demand only after a buyer pays.

| Source | Use it when | Config needed |
| --- | --- | --- |
| **Local folder** | The file is small and you are happy to commit it | None |
| **Your domain / URL** | You already host files on your site, a CDN, or object storage | None |
| **Google Drive** | Your work already lives in Drive | None for public files; optional `GOOGLE_API_KEY` for private/large files |

All three are available today and use the same `npm run publish-design` and
`npm run publish-pack` commands — you just swap which source flag you pass.

## Option A — Local folder (default)

Keep the sellable file inside `design-systems/` and publish it by path:

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
  --price 0.10
```

This is the simplest path and needs no extra configuration. The server reads the
registry fresh from disk, so changes are live without restarting.

## Option B — Your own domain or a direct URL

If your files already live on a site you control, a CDN, or object storage with a
public link, register the URL instead of copying the file into the repo:

```bash
npm run publish-design -- \
  --id your-doc \
  --url https://files.yourdomain.com/your-doc.md \
  --name "Your Doc" \
  --price 0.05
```

```bash
npm run publish-pack -- \
  --id your-pack \
  --url https://files.yourdomain.com/your-pack.zip \
  --name "Your Pack" \
  --price 0.10
```

Rules for URL sources:

- The URL must be **`https://`** (plain `http://` is rejected).
- The host must be public — localhost, loopback, and private network addresses
  are blocked so the server can never be tricked into reading internal resources.
- The file is fetched only when a buyer has paid, with a timeout and a size limit
  (50 MB by default; tune with `STORAGE_MAX_BYTES` and `STORAGE_FETCH_TIMEOUT_MS`).
- Keep the URL reachable. If it returns an error at purchase time, the buyer's
  request fails with a server error (your URL is never exposed to them).

## Option C — Google Drive

Use a Google Drive file directly. Two setups:

**Public file (no config):** In Drive, set the file's sharing to
**"Anyone with the link can view"**, then publish with the file ID or the full
share link:

```bash
npm run publish-design -- \
  --id your-drive-doc \
  --gdrive-id "https://drive.google.com/file/d/1AbC...XYZ/view?usp=sharing" \
  --name "Your Drive Doc" \
  --price 0.05
```

You can pass either the raw file ID (`1AbC...XYZ`) or paste the whole share URL —
Curatoria extracts the ID for you.

**Private or large files (recommended for production):** Create a Google Cloud API
key with the **Drive API** enabled and set it in `.env`:

```bash
GOOGLE_API_KEY=your-google-api-key
```

With a key, Curatoria fetches via the Drive API (`alt=media`), which handles
private files shared with the key's project and large files reliably. Confirm the
connector is active at `GET /health` — look for
`storage.google_drive.api_key: true`.

> **Drive gotcha:** without an API key, very large Drive files return an HTML
> confirmation page instead of bytes. Curatoria detects this and returns a clear
> error telling you to make the file link-shareable or set `GOOGLE_API_KEY`.

## How publishing records the source

Each command writes one entry to `design-systems/.registry.json`. A URL or Drive
product stores a small `source` block instead of a committed file:

```json
{
  "id": "your-drive-doc",
  "file": "your-drive-doc.md",
  "source": { "type": "gdrive", "file_id": "1AbC...XYZ" },
  "name": "Your Drive Doc",
  "price_usd": "0.05",
  "tags": [],
  "active": true
}
```

Local products keep their original shape (`file` points at a committed file, no
`source` block), so existing catalogs keep working unchanged.

## Verify it works

After publishing, regardless of source:

1. `GET /.well-known/design-catalog.json` — your product is listed.
2. `GET /design-systems/<id>` (or `/packs/<id>/download`) returns **402** when
   unpaid.
3. After a successful x402 payment, the same route returns the file bytes. The
   response carries an `X-Storage-Source` header (`local`, `url`, or `gdrive`) so
   you can confirm which connector served it.

## Still planned

These are not built yet:

- **Dropbox and iCloud** connectors;
- **OAuth-based** Drive access for files you do not want to make link-shareable
  and cannot cover with a single API key;
- a **browser UI** for picking files and setting prices (no terminal);
- automatic upload to object storage from within Curatoria.

Until those land, the three sources above — local, URL, and Google Drive — are the
supported ways to connect storage.
