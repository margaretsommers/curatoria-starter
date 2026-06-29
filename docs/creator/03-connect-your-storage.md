# Connect Your Storage

> **Available today:** yes (local folder, your-domain URL, Google Drive, Dropbox Mode A link-share, Dropbox Mode B with OAuth creds)
> **Requires terminal:** yes

Curatoria can sell a product whose bytes live in one of four places. You pick the
source per product when you publish it. Only catalog metadata (name, price, tags)
ever lives in your repo — for URL, Google Drive, and Dropbox sources, the file itself stays
where it is and is fetched on demand only after a buyer pays.

| Source | Use it when | Config needed |
| --- | --- | --- |
| **Local folder** | The file is small and you are happy to commit it | None |
| **Your domain / URL** | You already host files on your site, a CDN, or object storage | None |
| **Google Drive** | Your work already lives in Drive | None for public files; optional `GOOGLE_API_KEY` for private/large files |
| **Dropbox** | You want link-share now (Mode A) or private-file access (Mode B) | Mode A: none. Mode B: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` |

All source options above are available today and use the same `npm run publish-design` and
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

## Option D — Dropbox (Mode A link-share + Mode B OAuth/private path)

Dropbox Mode A works with a normal share link and does not require API keys.
Publish with `--dropbox-url`:

```bash
npm run publish-design -- \
  --id your-dropbox-doc \
  --dropbox-url "https://www.dropbox.com/s/abc123/your-doc.md?dl=0" \
  --name "Your Dropbox Doc" \
  --price 0.05
```

```bash
npm run publish-pack -- \
  --id your-dropbox-pack \
  --dropbox-url "https://www.dropbox.com/s/abc123/your-pack.zip?dl=0" \
  --name "Your Dropbox Pack" \
  --price 0.10
```

Curatoria validates Dropbox hosts and rewrites share links from `?dl=0` to
`?dl=1` at fetch time so paid buyers receive file bytes directly.

### Mode B (private files with OAuth)

If you cannot use public share links, publish a Dropbox file path instead:

```bash
npm run publish-design -- \
  --id your-dropbox-private-doc \
  --dropbox-path "/Design Systems/your-doc.md" \
  --name "Your Private Dropbox Doc" \
  --price 0.05
```

```bash
npm run publish-pack -- \
  --id your-dropbox-private-pack \
  --dropbox-path "/Design Systems/your-pack.zip" \
  --name "Your Private Dropbox Pack" \
  --price 0.10
```

Set these env vars in `.env` before using `--dropbox-path`:

```bash
DROPBOX_APP_KEY=...
DROPBOX_APP_SECRET=...
DROPBOX_REFRESH_TOKEN=...
```

One-time setup to get `DROPBOX_REFRESH_TOKEN`:

1. In Dropbox App Console, create a scoped app and enable scopes:
   `files.content.read` and `files.metadata.read`.
2. In app settings, add redirect URI `http://localhost:53682/callback`.
3. Open this URL in your browser (replace `YOUR_APP_KEY`):
   `https://www.dropbox.com/oauth2/authorize?client_id=YOUR_APP_KEY&response_type=code&token_access_type=offline&redirect_uri=http://localhost:53682/callback`
4. After approving, copy the `code=` value from the callback URL.
5. Exchange the code for a refresh token:

```bash
curl https://api.dropboxapi.com/oauth2/token \
  -d code=PASTE_AUTH_CODE_HERE \
  -d grant_type=authorization_code \
  -d client_id=YOUR_APP_KEY \
  -d client_secret=YOUR_APP_SECRET \
  -d redirect_uri=http://localhost:53682/callback
```

6. Copy `refresh_token` from the JSON response into `DROPBOX_REFRESH_TOKEN`.

On `/health`, Mode B is active when you see `storage.dropbox.oauth: true`.

## How publishing records the source

Each command writes one entry to `design-systems/.registry.json`. A URL, Drive, or Dropbox
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

After publishing, regardless of source, confirm discovery and paywalls match your track. See [`01-before-you-start.md`](01-before-you-start.md). **Track A (default)** is what the starter ships.

### Track A — free full catalog (default)

1. `GET /.well-known/design-catalog.json` — full `design_systems[]` with metadata and `access_url`. No storage paths or connector secrets.
2. `GET /catalog` — same free listing (alias).
3. `GET /design-systems/<id>` (or `/packs/<id>/download`) — **402** when unpaid (per-product asset fee).
4. After successful x402 payment on an asset route, the same route returns file bytes. The response carries an `X-Storage-Source` header.

```bash
curl http://localhost:3000/.well-known/design-catalog.json
curl http://localhost:3000/catalog
curl -v http://localhost:3000/design-systems/your-product-id
```

### Track B — paid catalog (optional)

Set `CATALOG_PAYWALL_ENABLED=1` in `.env`, restart, then:

1. Well-known returns teaser only (`owner`, `total`, `paid_catalog_url`).
2. `GET /catalog` returns **402** when unpaid (catalog access fee; default `$0.001` USDC per fetch).
3. Asset routes unchanged — **402** when unpaid.

Optional dev only: `CATALOG_PAYWALL_BYPASS=1` skips the paywall on `/catalog` locally — never in production.

Storage URLs and connector secrets never appear in catalog JSON on either track — only metadata and paid `access_url` values after the agent reaches the full listing.

## Public share links and paywall security

Curatoria hides your storage URLs from catalog and API responses. Buyers receive file bytes only after x402 payment on the asset route (`/design-systems/:id` or `/packs/:id/download`).

**Public Drive and Dropbox link-share URLs are bearer secrets.** Anyone who has the link can download the file directly, bypassing Curatoria. Leaking a link in docs, screenshots, or chat gives unpaid access — treat file IDs and share URLs like passwords.

Stronger options when you need real access control:

- **Dropbox Mode B** — private file path + OAuth (`--dropbox-path`)
- **Google Drive with `GOOGLE_API_KEY`** — private files via the Drive API
- **Your domain** — still a bearer URL, but you control rotation and access logs

On Track A or Track B, per-product asset payment is unchanged; the catalog never exposes storage URLs either way.

## Why not iCloud API yet?

iCloud is the obvious question for macOS creators, so here is the honest answer.

### What works today (macOS symlink workaround)

iCloud Drive syncs files to your Mac's local filesystem. You can sell them right
now using the **local folder** connector — no iCloud API needed:

1. In Finder, right-click your iCloud file and choose **Keep Downloaded** so
   macOS ensures the file is on disk (not a placeholder).
2. Symlink it into `design-systems/`:

```bash
ln -s ~/Library/Mobile\ Documents/com~apple~CloudDocs/my-system.md \
  design-systems/my-system.md
```

3. Publish with `--file design-systems/my-system.md`.

Windows creators using iCloud for Windows can do the same: find your iCloud sync
folder under `C:\Users\<you>\iCloudDrive\` (or wherever iCloud installed it) and
symlink or copy the file into `design-systems/`.

**What to watch:** if you move the file in iCloud, the symlink breaks. Keep the
file in the same iCloud location, or re-symlink after moving.

### Why public iCloud share links do not work

When you right-click a file in iCloud Drive and click **Share → Copy Link**, what
you get is an `icloud.com` web page — not a direct file download URL. Those links
open a preview in a browser; they cannot be fetched as raw bytes by a server. That
is why Curatoria cannot support them the same way it supports Dropbox or Google
Drive share links.

### What full iCloud API (CloudKit) would actually require

A proper server-side iCloud connector would use Apple's **CloudKit** or the
**CloudKit Web Services** API. Here is what that entails:

| Requirement | Details |
| --- | --- |
| **Apple Developer Program** | $99/year membership, required to access CloudKit server-to-server APIs |
| **Server-to-server auth keys** | A per-app EC private key generated in App Store Connect; each creator would need to create their own app record |
| **Per-creator container setup** | Each creator's files live in their own iCloud container; there is no shared "grant Curatoria read access" OAuth flow like Dropbox or Google Drive |
| **Apple-platform restriction** | CloudKit Web Services is designed for apps already in the Apple ecosystem; it is not a general-purpose cloud storage API |
| **Zero public download primitive** | CloudKit has no concept of a signed public download URL equivalent to `dl=1` (Dropbox) or `alt=media` (Google Drive); every fetch requires authenticated API calls |

In short: every creator would need their own Apple Developer account, their own
CloudKit container, and Curatoria would need to manage per-creator key pairs. That
is significantly more setup friction than Google Drive or Dropbox.

### When full iCloud API support might arrive

Curatoria will build a proper CloudKit connector when creator demand clearly
justifies the setup cost. The symlink workaround covers most macOS-first workflows
in the meantime. If you need CloudKit support, email the interest list so it gets
weighted in the roadmap.

## Still planned

These are not built yet:

- full **iCloud CloudKit** connector (see above for why it's deferred);
- **OAuth-based** Drive access for files you do not want to make link-shareable
  and cannot cover with a single API key;
- a **browser UI** for picking files and setting prices (no terminal);
- automatic upload to object storage from within Curatoria.

Until those land, the supported storage paths are local, URL, Google Drive, and Dropbox.
