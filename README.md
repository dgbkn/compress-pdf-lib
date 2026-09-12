# compress-pdf-lib

Client-side PDF compression. Renders each page with `pdf.js`, encodes it to
JPEG with mozjpeg (WASM, via `@jsquash/jpeg`) across a parallel `Worker`
pool, and rebuilds the PDF with `pdf-lib`. Nothing leaves the browser, and
there's no bundled UI — you call one function and get a compressed file back.

## Requirements

This package ships as **raw ESM source**, not a pre-bundled dist. It relies on
Vite-specific import syntax (`?url` asset imports, `new URL(..., import.meta.url)`
worker resolution), so it only works inside a **Vite-powered build**:

- ✅ React + Vite (`npm create vite@latest`)
- ✅ Astro (Astro's dev server and build are Vite under the hood)
- ✅ Any other Vite app (SvelteKit, Vue + Vite, plain Vite, etc.)
- ❌ Webpack / CRA / Next.js's default Webpack build (untested, likely needs
  worker-loader / asset-url tweaks)

It also only runs in the browser — it uses `Worker`, `OffscreenCanvas`,
`createImageBitmap`, and `navigator.*`, so call it from client-side code
(a React event handler, a browser `<script>` in Astro, etc.), never during
SSR.

## Install

```bash
npm install compress-pdf-lib
```

Or, straight from GitHub without publishing to npm:

```bash
npm install github:dgbkn/compress-pdf-lib
```

## Usage

```js
import { compressPDF } from "compress-pdf-lib";

const { file, stats } = await compressPDF(pdfFile, {
  quality: 70,       // JPEG quality, 0-100
  resolution: 1600,  // max px on a page's longest side
});

console.log(stats);
// {
//   pages, originalBytes, compressedBytes, savedBytes,
//   reduction,   // percent
//   elapsed,     // ms
//   workersUsed,
//   perPage: [{ pageNumber, renderedWidth, renderedHeight, jpegBytes }, ...]
// }
```

`compressPDF(input, options)` accepts a `File`, `Blob`, `ArrayBuffer`, or
typed array, and returns `{ file, stats }` where `file` is a `File` (or
`Blob` if `File` isn't available) you can upload, download, or inspect.

### React + Vite

```jsx
import { compressPDF } from "compress-pdf-lib";

function Uploader() {
  async function handleChange(event) {
    const original = event.target.files[0];
    const { file, stats } = await compressPDF(original, { quality: 65 });

    console.log(`${stats.reduction.toFixed(1)}% smaller`);
    // upload `file`, or trigger a download, etc.
  }

  return <input type="file" accept="application/pdf" onChange={handleChange} />;
}
```

### Astro

Astro components render on the server by default, so run this inside a
client-side script or an interactive island (`client:load` etc.):

```astro
---
// src/pages/index.astro
---
<input type="file" id="pdf-input" accept="application/pdf" />
<pre id="stats"></pre>

<script>
  import { compressPDF } from "compress-pdf-lib";

  const input = document.getElementById("pdf-input");
  const statsEl = document.getElementById("stats");

  input.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const { file: compressed, stats } = await compressPDF(file, { quality: 70 });
    statsEl.textContent = JSON.stringify(stats, null, 2);
  });
</script>
```

(A React/Vue/Svelte island with `client:load` works the same way — just call
`compressPDF` inside a browser event handler.)

### Intercepting a fetch upload

```js
import { compressPDF } from "compress-pdf-lib";

const originalFetch = window.fetch;

window.fetch = async function (...args) {
  const [resource, config] = args;

  if (config?.body instanceof FormData) {
    const entries = [...config.body.entries()];
    const hasPdf = entries.some(
      ([, v]) => v instanceof File && v.type === "application/pdf"
    );

    if (hasPdf) {
      const newFormData = new FormData();

      for (const [key, value] of entries) {
        if (value instanceof File && value.type === "application/pdf") {
          const { file, stats } = await compressPDF(value, { quality: 70 });
          console.log(`Compressed ${value.name}:`, stats);
          newFormData.append(key, file, value.name);
        } else {
          newFormData.append(key, value);
        }
      }

      config.body = newFormData;
    }
  }

  return originalFetch.call(this, resource, config);
};
```

## API

### `compressPDF(input, options?)`

| Option       | Type     | Default | Description                                  |
|--------------|----------|---------|-----------------------------------------------|
| `quality`    | number   | `65`    | JPEG quality, 0–100                            |
| `resolution` | number   | `1600`  | Max px on a page's longest rendered side       |
| `workers`    | number   | auto    | Override the auto-detected worker count        |
| `onProgress` | function | —       | `(update) => void`, called with `{ stage, progress, ... }` |

Returns `Promise<{ file, stats }>`.

### `getClientPower()`

Returns `{ cores, memory, workers }` — the auto-detected hardware profile and
the worker count `compressPDF` would use by default.

### `CompressionPool`

The underlying worker-pool class, exported in case you want to manage the
pool's lifecycle yourself across multiple compressions instead of letting
`compressPDF` create/destroy one per call.

## Publishing this package

### Option A — npm registry

```bash
cd compress-pdf-lib
npm login
npm publish
```

(`publishConfig.access: public` is already set in `package.json`, needed if
you ever scope the package name like `@you/compress-pdf-lib`.)

Bump `version` in `package.json` before each subsequent `npm publish`
(`npm version patch|minor|major` does this for you and tags git).

### Option B — GitHub only (no npm publish)

1. Push this folder as a repo, e.g. `github.com/YOUR_USERNAME/compress-pdf-lib`.
2. Consumers install with:
   ```bash
   npm install github:YOUR_USERNAME/compress-pdf-lib
   # or a specific tag/branch:
   npm install github:YOUR_USERNAME/compress-pdf-lib#v1.0.0
   ```

Either way, update the `repository`/`homepage`/`bugs` URLs in `package.json`
to your actual GitHub username first.

## License

MIT
