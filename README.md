# compress-pdf-lib

Client-side PDF compression for **Vite-powered apps** (React + Vite, Astro, SvelteKit, plain Vite, etc.).

Extracts every embedded raster image from the PDF, recompresses it individually using the
browser's hardware-accelerated JPEG encoder (`OffscreenCanvas.convertToBlob` → libjpeg-turbo),
and writes the result back into the exact same PDF object slot with `pdf-lib`.
Text, fonts, and vector drawing are **never touched** — text-only PDFs are safe and won't bloat.

**Zero WASM · zero server · nothing leaves the browser · no bundled UI.**

---

## Requirements

This package ships as **raw ESM source**, not a pre-bundled dist. It relies on
Vite-specific import syntax (`new URL(..., import.meta.url)` worker resolution),
so it only works inside a **Vite-powered build**:

| Environment | Works? |
|---|---|
| React + Vite (`npm create vite@latest`) | ✅ |
| Astro | ✅ |
| SvelteKit, Vue + Vite, plain Vite | ✅ |
| Webpack / CRA / Next.js default Webpack | ❌ (needs worker-loader tweaks) |

It also only runs **in the browser** — it uses `Worker`, `OffscreenCanvas`, `createImageBitmap`,
and `navigator.*`, so always call it from client-side code, never during SSR.

> **Vite config note:** If Vite complains that `pdf-lib`'s CJS sub-modules can't be resolved,
> add this alias to your `vite.config.js`:
> ```js
> resolve: {
>   alias: {
>     "pdf-lib": new URL(
>       "./node_modules/pdf-lib/dist/pdf-lib.esm.js",
>       import.meta.url
>     ).pathname,
>   },
> }
> ```

---

## Install

```bash
npm install compress-pdf-lib
```

Or directly from GitHub (no npm publish needed):

```bash
npm install github:dgbkn/compress-pdf-lib
# pin to a tag:
npm install github:dgbkn/compress-pdf-lib#v1.0.4
```

---

## Quick Start

```js
import { compressPDF } from "compress-pdf-lib";

const { file, stats } = await compressPDF(pdfFile, {
  quality: 80,       // JPEG quality 0–100  (default 75)
  scale:   1,        // image resize factor  (default 1 = keep native size)
});

console.log(`Saved ${stats.reduction.toFixed(1)}% (${stats.savedBytes} bytes)`);
// download or upload `file` — it's a File/Blob
```

---

## API

### `compressPDF(input, options?)` — ⭐ recommended

Extracts each embedded raster image from the PDF, recompresses it, and rebuilds the PDF in place.
Text and vectors are untouched.

**input** — `File | Blob | ArrayBuffer | TypedArray`

| Option | Type | Default | Description |
|---|---|---|---|
| `quality` | `number` | `75` | JPEG quality, 0–100. Higher = better quality, larger file. |
| `scale` | `number` | `1` | Resize factor applied to each image's **own** pixel dimensions. `1` = keep native size, just recompress. `0.5` = halve width & height. Clamped to 0.05–1. |
| `minImageBytes` | `number` | `2048` | Skip images already smaller than this many bytes — not worth re-encoding overhead. |
| `onlyIfSmaller` | `boolean` | `true` | If the recompressed JPEG would be **larger** than the original stream, keep the original. |
| `workers` | `number` | auto | Override the auto-detected worker count. Pass `0` or omit for auto. |
| `onProgress` | `function` | — | `(update) => void`. Called with `{ stage, progress, imageIndex, totalImages, completed }` as compression proceeds. `progress` is 0–100. |

**Returns** `Promise<{ file: File|Blob, stats }>`

```js
stats = {
  pages,            // number of pages in the PDF
  imagesFound,      // total image XObjects discovered
  imagesCompressed, // images successfully recompressed
  imagesSkipped,    // images skipped (too small, unsupported codec, already smaller, etc.)
  originalBytes,    // input file size in bytes
  compressedBytes,  // output file size in bytes
  savedBytes,       // originalBytes - compressedBytes  (≥ 0)
  reduction,        // (savedBytes / originalBytes) * 100  — percent
  elapsed,          // wall-clock ms
  workersUsed,      // number of Worker threads used (0 = direct / no worker pool)
  perImage: [       // one entry per image XObject
    {
      ref,              // PDF object reference string
      skipped,          // null if compressed; reason string if skipped
      width, height,    // original pixel dimensions
      newWidth, newHeight,
      originalBytes,
      compressedBytes,
      format,           // "jpeg" | "flate+smask"
    },
    // ...
  ],
}
```

---

### `rasterizePDF(input, options?)` — legacy

Renders **every page** to a full-page bitmap and rebuilds the PDF from those images.
This **discards text and vector content** (replaces them with pictures of them).
Prefer `compressPDF` unless the document is already purely scanned images.

| Option | Type | Default | Description |
|---|---|---|---|
| `quality` | `number` | `65` | JPEG quality, 0–100 |
| `resolution` | `number \| "original"` | `1600` | Max px on a page's longest side. `"original"` keeps full render scale. |
| `scale` | `number` | — | Direct render multiplier (overrides `resolution` when set). Clamped 0.25–3. |
| `workers` | `number` | auto | Worker count override |
| `engine` | `string` | `"native"` | Encoder engine hint (passed to worker) |
| `onProgress` | `function` | — | Same shape as `compressPDF` |

**Returns** `Promise<{ file: File|Blob, stats }>`

---

### `getClientPower()`

Returns `{ cores, memory, workers }` — the auto-detected hardware profile and
recommended worker count that `compressPDF` would use by default.

```js
import { getClientPower } from "compress-pdf-lib";

const { cores, memory, workers } = getClientPower();
console.log(`Using ${workers} workers on ${cores}-core / ${memory}GB RAM machine`);
```

---

### `CompressionPool`

The underlying worker-pool class. Exported for advanced use cases where you want
to manage pool lifecycle across multiple compressions (e.g. keep workers alive
between calls instead of creating/destroying per-call).

```js
import { CompressionPool, getClientPower } from "compress-pdf-lib";

const pool = new CompressionPool();
pool.init(getClientPower().workers);

// ... compress multiple PDFs reusing the same pool ...

pool.destroy();
```

---

## Examples

### React + Vite

```jsx
import { compressPDF } from "compress-pdf-lib";

function Uploader() {
  async function handleChange(e) {
    const original = e.target.files[0];

    const { file, stats } = await compressPDF(original, {
      quality: 80,
      onProgress: ({ progress, stage }) =>
        console.log(stage, `${progress}%`),
    });

    console.log(`${stats.reduction.toFixed(1)}% smaller in ${(stats.elapsed/1000).toFixed(2)}s`);
    // upload `file`, trigger a download, etc.
  }

  return <input type="file" accept="application/pdf" onChange={handleChange} />;
}
```

### Astro

```astro
---
// src/pages/index.astro
---
<input type="file" id="pdf-input" accept="application/pdf" />
<pre id="out"></pre>

<script>
  import { compressPDF } from "compress-pdf-lib";

  document.getElementById("pdf-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const { file: compressed, stats } = await compressPDF(file, { quality: 75 });
    document.getElementById("out").textContent = JSON.stringify(stats, null, 2);
  });
</script>
```

### Intercept fetch uploads

Auto-compress any PDF before it leaves the browser:

```js
import { compressPDF } from "compress-pdf-lib";

const _fetch = window.fetch;
window.fetch = async function(...args) {
  const [url, config] = args;
  if (config?.body instanceof FormData) {
    const next = new FormData();
    for (const [key, val] of config.body.entries()) {
      if (val instanceof File && val.type === "application/pdf") {
        const { file } = await compressPDF(val, { quality: 75 });
        next.append(key, file, val.name);
      } else {
        next.append(key, val);
      }
    }
    config.body = next;
  }
  return _fetch.call(this, url, config);
};
```

### With progress bar

```js
const { file, stats } = await compressPDF(pdfFile, {
  quality: 80,
  scale: 0.85,
  onlyIfSmaller: true,

  onProgress({ stage, progress, imageIndex, totalImages }) {
    progressBar.style.width = `${progress}%`;
    statusEl.textContent =
      stage === "compressing"
        ? `Compressing image ${imageIndex} / ${totalImages}…`
        : stage;
  },
});
```

---

## License

MIT
