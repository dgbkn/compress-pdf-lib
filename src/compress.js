/**
 * compress.js
 *
 * PDF compression library with two strategies:
 *
 *   compressPDF(input, options)   — RECOMMENDED. Extracts each embedded raster
 *                                    image from the PDF, decodes it, resizes
 *                                    and recompresses it on its own (via the
 *                                    worker pool + mozjpeg WASM), and writes
 *                                    the result back into the exact same PDF
 *                                    object slot. Text, fonts, and vector
 *                                    drawing are never touched, so text-based
 *                                    PDFs are not bloated by rasterization.
 *
 *   rasterizePDF(input, options)  — the older approach: renders every page to
 *                                    a full-page image and rebuilds the PDF
 *                                    from those images. Useful only for
 *                                    PDFs that are already just scans (one
 *                                    image per page) where per-image
 *                                    extraction wouldn't find anything.
 *
 * Both use the same CompressionPool / pdf-compressor.worker.js for the
 * actual JPEG encoding.
 *
 * Usage:
 *   import { compressPDF } from 'compress-pdf-lib';
 *
 *   const { file, stats } = await compressPDF(pdfFile, {
 *     quality: 75,
 *     scale: 1, // 1 = keep each image's native pixel size, just recompress
 *   });
 *
 *   console.log(stats);
 *   // {
 *   //   pages, imagesFound, imagesCompressed, imagesSkipped,
 *   //   originalBytes, compressedBytes, savedBytes, reduction, elapsed,
 *   //   workersUsed, perImage: [...]
 *   // }
 */

import * as pdfjsLib from "pdfjs-dist";
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFDict,
  PDFArray,
  PDFNumber,
  decodePDFRawStream,
} from "pdf-lib";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/* ============================================================
   CLIENT POWER DETECTION
============================================================ */

export function getClientPower() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;

  /*
   * Conservative worker count.
   * We don't want one worker per core because
   * WASM JPEG encoding is CPU intensive.
   */

  let workers;

  if (cores <= 2) {
    workers = 1;
  } else if (cores <= 4) {
    workers = 2;
  } else if (cores <= 8) {
    workers = 3;
  } else if (cores <= 12) {
    workers = 4;
  } else {
    workers = 6;
  }

  /* Memory protection */

  if (memory <= 2) {
    workers = Math.min(workers, 1);
  } else if (memory <= 4) {
    workers = Math.min(workers, 2);
  } else if (memory <= 8) {
    workers = Math.min(workers, 4);
  }

  /* Never create ridiculous amounts of workers */

  workers = Math.max(1, Math.min(workers, Math.max(1, cores - 1), 6));

  return { cores, memory, workers };
}

/* ============================================================
   WORKER POOL
============================================================ */

export class CompressionPool {
  constructor() {
    this.workers = [];
    this.idle = [];
    this.jobs = new Map();
    this.queue = [];
    this.nextId = 1;
  }

  init(count) {
    this.destroy();

    for (let i = 0; i < count; i++) {
      const worker = new Worker(
        new URL("./pdf-compressor.worker.js", import.meta.url),
        { type: "module" }
      );

      const slot = { worker, busy: false };

      worker.onmessage = (event) => {
        const data = event.data;

        if (data.type === "image-complete") {
          const jobId = data.jobId;
          const job = this.jobs.get(jobId);

          if (!job) return;

          this.jobs.delete(jobId);
          slot.busy = false;
          this.idle.push(slot);

          job.resolve(data);
          this.pump();
        } else if (data.type === "error") {
          const jobId = data.jobId;
          const job = this.jobs.get(jobId);

          if (!job) return;

          this.jobs.delete(jobId);
          slot.busy = false;
          this.idle.push(slot);

          job.reject(new Error(data.message || "Worker compression failed"));
          this.pump();
        }
      };

      worker.onerror = (error) => {
        console.error("Worker error:", error);
        slot.busy = false;

        for (const [id, job] of this.jobs) {
          if (job.slot === slot) {
            this.jobs.delete(id);
            job.reject(new Error("Compression worker crashed"));
          }
        }

        this.pump();
      };

      this.workers.push(slot);
      this.idle.push(slot);
    }
  }

  run(payload, transferables = []) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;

      this.queue.push({ id, payload, transferables, resolve, reject });

      this.pump();
    });
  }

  pump() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const slot = this.idle.shift();
      if (!slot) return;

      const job = this.queue.shift();
      slot.busy = true;
      job.slot = slot;

      this.jobs.set(job.id, job);

      slot.worker.postMessage({ ...job.payload, jobId: job.id }, job.transferables);
    }
  }

  async drain() {
    while (this.queue.length > 0 || this.jobs.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  destroy() {
    for (const slot of this.workers) {
      try {
        slot.worker.terminate();
      } catch {}
    }

    this.workers = [];
    this.idle = [];
    this.jobs.clear();
    this.queue = [];
  }
}

/* ============================================================
   SHARED HELPERS
============================================================ */

function safePageCleanup(page) {
  try {
    if (page && typeof page.cleanup === "function") {
      page.cleanup();
    }
  } catch (error) {
    console.warn("Page cleanup skipped:", error);
  }
}

async function normalizeInput(input) {
  let arrayBuffer;
  let fileName = "document.pdf";
  let fileType = "application/pdf";

  if (typeof File !== "undefined" && input instanceof File) {
    fileName = input.name || fileName;
    fileType = input.type || fileType;
    arrayBuffer = await input.arrayBuffer();
  } else if (input instanceof Blob) {
    fileType = input.type || fileType;
    arrayBuffer = await input.arrayBuffer();
  } else if (input instanceof ArrayBuffer) {
    arrayBuffer = input;
  } else if (ArrayBuffer.isView(input)) {
    arrayBuffer = input.buffer.slice(
      input.byteOffset,
      input.byteOffset + input.byteLength
    );
  } else {
    throw new Error("compressPDF: unsupported input type");
  }

  return { arrayBuffer, fileName, fileType, originalBytes: arrayBuffer.byteLength };
}

function jpegResultToBytes(item) {
  if (item.jpeg instanceof ArrayBuffer) {
    return new Uint8Array(item.jpeg);
  }
  if (item.jpeg instanceof Uint8Array) {
    return item.jpeg;
  }
  if (ArrayBuffer.isView(item.jpeg)) {
    return new Uint8Array(item.jpeg.buffer, item.jpeg.byteOffset, item.jpeg.byteLength);
  }
  throw new Error("Invalid JPEG encoder output");
}

/* ============================================================================
   STRATEGY 1 (RECOMMENDED): EXTRACT EMBEDDED IMAGES, COMPRESS, REPLACE IN PLACE
============================================================================ */

/*
 * ---- PDF filter name plumbing --------------------------------------------
 */

function filterNamesOf(context, dict) {
  const filter = context.lookup(dict.get(PDFName.of("Filter")));

  if (!filter) return [];

  if (filter instanceof PDFName) {
    return [filter.asString().replace(/^\//, "")];
  }

  if (filter instanceof PDFArray) {
    return filter.asArray().map((f) => {
      const resolved = context.lookup(f);
      return resolved instanceof PDFName ? resolved.asString().replace(/^\//, "") : "";
    }).filter(Boolean);
  }

  return [];
}

/*
 * ---- ColorSpace resolution --------------------------------------------
 * Returns { kind, components, palette?, paletteComponents? }
 */

function resolveColorSpace(context, csObj, depth = 0) {
  if (depth > 4 || !csObj) {
    return { kind: "rgb", components: 3 };
  }

  const resolved = csObj instanceof PDFDict || csObj instanceof PDFArray || csObj instanceof PDFName
    ? csObj
    : context.lookupMaybe(csObj, PDFName) ||
      context.lookupMaybe(csObj, PDFArray) ||
      context.lookupMaybe(csObj, PDFDict) ||
      csObj;

  if (resolved instanceof PDFName) {
    const name = resolved.asString().replace(/^\//, "");

    if (name === "DeviceGray" || name === "CalGray" || name === "G") {
      return { kind: "gray", components: 1 };
    }
    if (name === "DeviceCMYK" || name === "CMYK") {
      return { kind: "cmyk", components: 4 };
    }
    // DeviceRGB, CalRGB, Lab (approximated as RGB), and anything unknown
    return { kind: "rgb", components: 3 };
  }

  if (resolved instanceof PDFArray) {
    const items = resolved.asArray();
    const familyName = items[0] instanceof PDFName ? items[0].asString().replace(/^\//, "") : "";

    if (familyName === "ICCBased") {
      const stream = context.lookup(items[1]);
      const n = stream?.dict?.get(PDFName.of("N"));
      const components = n instanceof PDFNumber ? n.asNumber() : 3;

      if (components === 1) return { kind: "gray", components: 1 };
      if (components === 4) return { kind: "cmyk", components: 4 };
      return { kind: "rgb", components: 3 };
    }

    if (familyName === "Indexed") {
      const base = resolveColorSpace(context, items[1], depth + 1);
      const lookupObj = context.lookup(items[2]) ?? items[2];

      let paletteBytes;

      if (lookupObj instanceof PDFRawStream || (lookupObj && lookupObj.dict && lookupObj.contents)) {
        paletteBytes = decodePDFRawStream(lookupObj).decode();
      } else if (lookupObj && typeof lookupObj.asBytes === "function") {
        paletteBytes = lookupObj.asBytes();
      } else if (lookupObj && typeof lookupObj.value === "string") {
        paletteBytes = Uint8Array.from(lookupObj.value, (c) => c.charCodeAt(0));
      } else {
        paletteBytes = new Uint8Array(0);
      }

      return {
        kind: "indexed",
        components: 1,
        palette: paletteBytes,
        paletteComponents: base.components,
        baseKind: base.kind,
      };
    }

    if (familyName === "DeviceN" || familyName === "Separation") {
      // Rare, hard to interpret correctly — fall back to gray-ish approximation
      return { kind: "gray", components: 1 };
    }

    if (familyName === "CalRGB" || familyName === "Lab") {
      return { kind: "rgb", components: 3 };
    }

    if (familyName === "CalGray") {
      return { kind: "gray", components: 1 };
    }
  }

  return { kind: "rgb", components: 3 };
}

/*
 * ---- Raw sample bit-reader ------------------------------------------------
 * PDF image rows are byte-aligned: each row starts on a new byte even if the
 * previous row didn't end on one.
 */

function readSamples(rawBytes, width, height, bitsPerComponent, numComponents) {
  const bitsPerPixel = bitsPerComponent * numComponents;
  const rowBytes = Math.ceil((bitsPerPixel * width) / 8);
  const samples = new Uint16Array(width * height * numComponents);

  const maxVal = (1 << bitsPerComponent) - 1;

  let sampleIndex = 0;

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    let bitPos = 0;

    for (let x = 0; x < width * numComponents; x++) {
      if (bitsPerComponent === 8) {
        samples[sampleIndex++] = rawBytes[rowStart + x] || 0;
      } else if (bitsPerComponent === 16) {
        const byteOffset = rowStart + x * 2;
        samples[sampleIndex++] =
          ((rawBytes[byteOffset] || 0) << 8) | (rawBytes[byteOffset + 1] || 0);
      } else {
        // 1, 2, or 4 bits per component
        const byteIndex = rowStart + (bitPos >> 3);
        const bitOffsetInByte = bitPos & 7;
        const byte = rawBytes[byteIndex] || 0;

        const shift = 8 - bitOffsetInByte - bitsPerComponent;
        const value = (byte >> Math.max(shift, 0)) & maxVal;

        samples[sampleIndex++] = value;
        bitPos += bitsPerComponent;
      }
    }
  }

  return { samples, maxVal };
}

function scaleSample(value, maxVal) {
  return maxVal === 255 ? value : Math.round((value / maxVal) * 255);
}

/*
 * ---- Convert decoded samples -> RGBA Uint8ClampedArray --------------------
 */

function samplesToRGBA(rawBytes, width, height, bitsPerComponent, colorSpaceInfo) {
  const { kind, components } = colorSpaceInfo;
  const { samples, maxVal } = readSamples(rawBytes, width, height, bitsPerComponent, components);

  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let i = 0, s = 0; i < width * height; i++, s += components) {
    let r, g, b;

    if (kind === "gray") {
      const v = scaleSample(samples[s], maxVal);
      r = g = b = v;
    } else if (kind === "cmyk") {
      const c = samples[s] / maxVal;
      const m = samples[s + 1] / maxVal;
      const y = samples[s + 2] / maxVal;
      const k = samples[s + 3] / maxVal;

      r = 255 * (1 - c) * (1 - k);
      g = 255 * (1 - m) * (1 - k);
      b = 255 * (1 - y) * (1 - k);
    } else if (kind === "indexed") {
      const index = samples[s];
      const { palette, paletteComponents, baseKind } = colorSpaceInfo;
      const base = index * paletteComponents;

      if (baseKind === "gray") {
        r = g = b = palette[base] ?? 0;
      } else if (baseKind === "cmyk") {
        const c = (palette[base] ?? 0) / 255;
        const m = (palette[base + 1] ?? 0) / 255;
        const y = (palette[base + 2] ?? 0) / 255;
        const k = (palette[base + 3] ?? 0) / 255;
        r = 255 * (1 - c) * (1 - k);
        g = 255 * (1 - m) * (1 - k);
        b = 255 * (1 - y) * (1 - k);
      } else {
        r = palette[base] ?? 0;
        g = palette[base + 1] ?? 0;
        b = palette[base + 2] ?? 0;
      }
    } else {
      // rgb
      r = scaleSample(samples[s], maxVal);
      g = scaleSample(samples[s + 1], maxVal);
      b = scaleSample(samples[s + 2], maxVal);
    }

    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }

  return rgba;
}

/*
 * ---- Decode one PDF Image XObject into an ImageBitmap ---------------------
 * Returns null if the image uses a codec we don't support (JPX/CCITT/JBIG2),
 * is a stencil mask, or otherwise can't be safely handled.
 */

async function decodeImageXObject(context, ref) {
  const stream = context.lookup(ref);

  if (!stream || !(stream instanceof PDFRawStream)) return null;

  const dict = stream.dict;

  const subtype = dict.get(PDFName.of("Subtype"));
  if (!subtype || subtype.asString().replace(/^\//, "") !== "Image") return null;

  const isMask = dict.get(PDFName.of("ImageMask"));
  if (isMask && isMask.constructor?.name === "PDFBool" && isMask.asBoolean?.()) return null;

  // Color-key / stencil Mask (not SMask) changes meaning based on exact pixel
  // values — recompressing would break it, so skip these entirely.
  if (dict.get(PDFName.of("Mask"))) return null;

  const filterNames = filterNamesOf(context, dict);
  
  // Skip explicitly unhandled compression formats natively
  const unsupported = filterNames.find(f => f === "JPXDecode" || f === "CCITTFaxDecode" || f === "JBIG2Decode");
  if (unsupported) {
    return { unsupported: true, reason: unsupported };
  }

  const width = dict.get(PDFName.of("Width"))?.asNumber?.();
  const height = dict.get(PDFName.of("Height"))?.asNumber?.();

  if (!width || !height) return null;

  const originalBytes = stream.contents.length;

  let bitmap;
  let hasAlpha = false;

  if (filterNames.includes("DCTDecode")) {
    // pdf-lib's decodePDFRawStream throws on DCTDecode because it natively lacks a 
    // mechanism to decode JPEGs to raw samples. We must extract the bytes dynamically 
    // whilst bypassing the "DCTDecode" step inside its pipeline filter.
    let jpegBytes;
    const originalFilterVal = dict.get(PDFName.of("Filter"));
    const filterObj = context.lookup(originalFilterVal);

    if (filterNames.length > 1 && filterObj instanceof PDFArray) {
      const filtered = filterObj.asArray().filter((f) => {
        const resolved = context.lookup(f);
        return resolved instanceof PDFName && resolved.asString() !== "/DCTDecode";
      });

      if (filtered.length === 0) {
        jpegBytes = stream.contents;
      } else {
        dict.set(PDFName.of("Filter"), context.obj(filtered));
        try {
          jpegBytes = decodePDFRawStream(stream).decode();
        } finally {
          dict.set(PDFName.of("Filter"), originalFilterVal);
        }
      }
    } else {
      // It's just a raw DCTDecode stream (most common).
      jpegBytes = stream.contents;
    }

    const blob = new Blob([jpegBytes], { type: "image/jpeg" });
    bitmap = await createImageBitmap(blob);
  } else {
    // Raw samples (typically FlateDecode) — decode manually.
    const bitsPerComponent = dict.get(PDFName.of("BitsPerComponent"))?.asNumber?.() || 8;
    const colorSpaceObj = dict.get(PDFName.of("ColorSpace"));
    const colorSpaceInfo = resolveColorSpace(context, colorSpaceObj);

    const rawBytes = decodePDFRawStream(stream).decode();
    const rgba = samplesToRGBA(rawBytes, width, height, bitsPerComponent, colorSpaceInfo);

    const imageData = new ImageData(rgba, width, height);
    bitmap = await createImageBitmap(imageData);
  }

  // Soft mask (alpha channel) — decode and merge in.
  const smaskRef = dict.get(PDFName.of("SMask"));

  if (smaskRef) {
    try {
      const smaskDecoded = await decodeImageXObject(context, smaskRef);

      if (smaskDecoded && !smaskDecoded.unsupported && smaskDecoded.bitmap) {
        hasAlpha = true;

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");

        // Draw color image
        ctx.drawImage(bitmap, 0, 0, width, height);
        const base = ctx.getImageData(0, 0, width, height);

        // Draw alpha mask resized to match
        const alphaCanvas = new OffscreenCanvas(width, height);
        const alphaCtx = alphaCanvas.getContext("2d");
        alphaCtx.drawImage(smaskDecoded.bitmap, 0, 0, width, height);
        const alphaData = alphaCtx.getImageData(0, 0, width, height);

        for (let i = 0; i < width * height; i++) {
          base.data[i * 4 + 3] = alphaData.data[i * 4]; // gray channel -> alpha
        }

        bitmap.close();
        bitmap = await createImageBitmap(base);
      }
    } catch (smaskError) {
      console.warn("compressPDF: SMask decode failed, ignoring alpha:", smaskError);
    }
  }

  return { bitmap, width, height, hasAlpha, originalBytes };
}

/*
 * ---- Deflate (zlib) bytes using the native Compression Streams API --------
 */

async function deflateBytes(bytes) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("CompressionStream API unavailable — cannot write alpha/PNG-style images");
  }

  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();

  const buffer = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

/*
 * ---- Replace one image object in place ------------------------------------
 */

async function replaceImageWithJpeg(context, ref, jpegBytes, width, height) {
  const dict = context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: width,
    Height: height,
    ColorSpace: "DeviceRGB",
    BitsPerComponent: 8,
    Filter: "DCTDecode",
  });

  context.assign(ref, PDFRawStream.of(dict, jpegBytes));
}

async function replaceImageWithFlateRGBA(context, ref, rgbaBitmap, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(rgbaBitmap, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);

  const rgbBytes = new Uint8Array(width * height * 3);
  const alphaBytes = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    rgbBytes[i * 3] = imageData.data[i * 4];
    rgbBytes[i * 3 + 1] = imageData.data[i * 4 + 1];
    rgbBytes[i * 3 + 2] = imageData.data[i * 4 + 2];
    alphaBytes[i] = imageData.data[i * 4 + 3];
  }

  const [rgbDeflated, alphaDeflated] = await Promise.all([
    deflateBytes(rgbBytes),
    deflateBytes(alphaBytes),
  ]);

  const smaskDict = context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: width,
    Height: height,
    ColorSpace: "DeviceGray",
    BitsPerComponent: 8,
    Filter: "FlateDecode",
  });

  const smaskRef = context.register(PDFRawStream.of(smaskDict, alphaDeflated));

  const mainDict = context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: width,
    Height: height,
    ColorSpace: "DeviceRGB",
    BitsPerComponent: 8,
    Filter: "FlateDecode",
    SMask: smaskRef,
  });

  context.assign(ref, PDFRawStream.of(mainDict, rgbDeflated));

  return rgbDeflated.length + alphaDeflated.length;
}

/*
 * ---- Find every Image XObject in the document ----------------------------
 */

function findImageRefs(pdfDoc) {
  const refs = [];

  for (const [ref, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;

    const subtype = obj.dict.get(PDFName.of("Subtype"));
    if (subtype && subtype.asString?.().replace(/^\//, "") === "Image") {
      refs.push(ref);
    }
  }

  return refs;
}

/*
 * ---- compressPDF: the public, recommended API -----------------------------
 */

/**
 * Compress a PDF by extracting each embedded raster image, resizing and
 * recompressing it individually (via a parallel worker pool running mozjpeg
 * WASM), and writing the result back into the same PDF object slot. Text,
 * fonts, and vector drawing instructions are left completely untouched.
 *
 * @param {File|Blob|ArrayBuffer|ArrayBufferView} input
 * @param {Object} [options]
 * @param {number} [options.quality=75] - JPEG quality, 0-100 (only applies to
 *   opaque images; images with transparency are re-encoded losslessly as
 *   Flate-compressed raw pixels + an SMask, since JPEG has no alpha channel)
 * @param {number} [options.scale=1] - resize factor applied to each image's
 *   OWN native pixel dimensions (not the page). 1 = keep native size and only
 *   recompress; 0.5 = half width/height; etc. Clamped to 0.05–1.
 * @param {number} [options.minImageBytes=2048] - skip images already smaller
 *   than this (not worth the re-encode overhead)
 * @param {boolean} [options.onlyIfSmaller=true] - keep the original image
 *   bytes if the recompressed version would end up bigger
 * @param {number} [options.workers] - override auto-detected worker count
 * @param {(update: object) => void} [options.onProgress] - progress callback
 * @returns {Promise<{file: File|Blob, stats: object}>}
 */
export async function compressPDF(input, options = {}) {
  const {
    quality = 75,
    scale = 1,
    minImageBytes = 2048,
    onlyIfSmaller = true,
    workers: workerOverride,
    onProgress,
  } = options;

  const clampedScale = Math.max(0.05, Math.min(scale, 1));

  const startedAt = performance.now();

  const { arrayBuffer, fileName, fileType, originalBytes } = await normalizeInput(input);

  const pdfDoc = await PDFDocument.load(arrayBuffer, {
    updateMetadata: false,
    ignoreEncryption: true,
  });

  const context = pdfDoc.context;
  const imageRefs = findImageRefs(pdfDoc);

  const power = getClientPower();
  const workerCount = workerOverride || power.workers;

  const pool = new CompressionPool();
  pool.init(workerCount);

  const perImage = [];
  let imagesCompressed = 0;
  let imagesSkipped = 0;

  try {
    let nextIndex = 0;
    let completed = 0;

    async function runner() {
      while (true) {
        const index = nextIndex++;
        if (index >= imageRefs.length) return;

        const ref = imageRefs[index];

        let entry = {
          ref: ref.toString(),
          skipped: null,
        };

        try {
          const decoded = await decodeImageXObject(context, ref);

          if (!decoded) {
            entry.skipped = "unreadable-or-stencil";
            imagesSkipped++;
          } else if (decoded.unsupported) {
            entry.skipped = `unsupported-codec:${decoded.reason}`;
            imagesSkipped++;
          } else if (decoded.originalBytes < minImageBytes) {
            decoded.bitmap.close();
            entry.skipped = "below-min-size";
            entry.originalBytes = decoded.originalBytes;
            imagesSkipped++;
          } else {
            const { bitmap, width, height, hasAlpha, originalBytes: origImgBytes } = decoded;

            const newWidth = Math.max(1, Math.round(width * clampedScale));
            const newHeight = Math.max(1, Math.round(height * clampedScale));

            entry.width = width;
            entry.height = height;
            entry.newWidth = newWidth;
            entry.newHeight = newHeight;
            entry.originalBytes = origImgBytes;

            let resizedBitmap = bitmap;

            if (newWidth !== width || newHeight !== height) {
              const resizeCanvas = new OffscreenCanvas(newWidth, newHeight);
              const resizeCtx = resizeCanvas.getContext("2d");
              resizeCtx.drawImage(bitmap, 0, 0, newWidth, newHeight);
              bitmap.close();
              resizedBitmap = await createImageBitmap(resizeCanvas);
            }

            if (hasAlpha) {
              const newBytes = await replaceImageWithFlateRGBA(
                context,
                ref,
                resizedBitmap,
                newWidth,
                newHeight
              );

              resizedBitmap.close();

              entry.format = "flate+smask";
              entry.compressedBytes = newBytes;
              imagesCompressed++;
            } else {
              const compressed = await pool.run(
                {
                  type: "compress-image",
                  bitmap: resizedBitmap,
                  quality,
                  pageNumber: index + 1,
                  totalPages: imageRefs.length,
                },
                [resizedBitmap]
              );

              const jpegBytes = jpegResultToBytes(compressed);

              if (onlyIfSmaller && jpegBytes.length >= origImgBytes) {
                entry.skipped = "recompressed-not-smaller";
                entry.compressedBytes = origImgBytes;
                imagesSkipped++;
              } else {
                await replaceImageWithJpeg(context, ref, jpegBytes, newWidth, newHeight);
                entry.format = "jpeg";
                entry.compressedBytes = jpegBytes.length;
                imagesCompressed++;
              }
            }
          }
        } catch (error) {
          console.warn(`compressPDF: skipping image (${ref.toString()}):`, error);
          entry.skipped = "error";
          entry.error = error?.message || String(error);
          imagesSkipped++;
        }

        perImage.push(entry);
        completed++;

        if (typeof onProgress === "function") {
          onProgress({
            stage: "compressing",
            imageIndex: index + 1,
            totalImages: imageRefs.length,
            completed,
            progress: imageRefs.length
              ? Math.round((completed / imageRefs.length) * 90)
              : 90,
          });
        }
      }
    }

    const concurrency = Math.max(1, Math.min(workerCount, 4));
    const runnerCount = Math.min(concurrency, Math.max(imageRefs.length, 1));

    await Promise.all(Array.from({ length: runnerCount }, () => runner()));

    if (typeof onProgress === "function") {
      onProgress({ stage: "saving", progress: 95 });
    }

    const pdfBytes = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false,
    });

    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const compressedBytes = blob.size;
    const savedBytes = Math.max(0, originalBytes - compressedBytes);
    const reduction = originalBytes > 0 ? (savedBytes / originalBytes) * 100 : 0;
    const elapsed = performance.now() - startedAt;

    const stats = {
      pages: pdfDoc.getPageCount(),
      imagesFound: imageRefs.length,
      imagesCompressed,
      imagesSkipped,
      originalBytes,
      compressedBytes,
      savedBytes,
      reduction,
      elapsed,
      workersUsed: workerCount,
      perImage,
    };

    if (typeof onProgress === "function") {
      onProgress({ stage: "complete", progress: 100 });
    }

    const file =
      typeof File !== "undefined"
        ? new File([blob], fileName, { type: fileType })
        : blob;

    return { file, stats };
  } finally {
    pool.destroy();
  }
}

/* ============================================================================
   STRATEGY 2 (LEGACY): FULL-PAGE RASTERIZATION
   Kept for cases where the whole page really is a single scanned image and
   there's nothing for compressPDF's per-image extraction to find separately.
============================================================================ */

async function rasterizeProcessPage(pdf, pool, pageNumber, totalPages, { quality, resolution, scale: fixedScale }) {
  let page = null;
  let canvas = null;
  let bitmap = null;

  try {
    page = await pdf.getPage(pageNumber);

    const baseViewport = page.getViewport({ scale: 1 });
    const pdfWidth = baseViewport.width;
    const pdfHeight = baseViewport.height;

    const largestDimension = Math.max(pdfWidth, pdfHeight);

    let scale;

    if (typeof fixedScale === "number") {
      scale = Math.max(0.25, Math.min(fixedScale, 3));
    } else if (resolution === "original" || resolution === Infinity) {
      scale = 3;
    } else {
      scale = resolution / largestDimension;
      scale = Math.max(scale, 0.25);
      scale = Math.min(scale, 3);
    }

    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);

    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false,
    });

    if (!ctx) {
      throw new Error(`Canvas unavailable for page ${pageNumber}`);
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    await page.render({
      canvasContext: ctx,
      viewport,
      background: "white",
    }).promise;

    bitmap = await createImageBitmap(canvas);

    canvas.width = 1;
    canvas.height = 1;

    const compressed = await pool.run(
      {
        type: "compress-image",
        bitmap,
        pageNumber,
        totalPages,
        quality,
        pdfWidth,
        pdfHeight,
      },
      [bitmap]
    );

    bitmap = null;

    return compressed;
  } finally {
    if (canvas) {
      try {
        canvas.width = 1;
        canvas.height = 1;
      } catch {}
    }

    if (bitmap) {
      try {
        bitmap.close();
      } catch {}
    }

    safePageCleanup(page);
  }
}

async function rasterizeProcessPages(pdf, pool, totalPages, { quality, resolution, scale, workers, onProgress }) {
  const results = new Array(totalPages);

  const renderConcurrency = Math.max(1, Math.min(workers, 4));

  let nextPage = 1;
  let completed = 0;

  async function runner() {
    while (true) {
      const pageNumber = nextPage++;

      if (pageNumber > totalPages) {
        return;
      }

      const result = await rasterizeProcessPage(pdf, pool, pageNumber, totalPages, {
        quality,
        resolution,
        scale,
      });

      results[pageNumber - 1] = result;
      completed++;

      if (typeof onProgress === "function") {
        onProgress({
          stage: "compressing",
          pageNumber,
          totalPages,
          completed,
          progress: Math.round((completed / totalPages) * 90),
        });
      }
    }
  }

  const runners = Math.min(renderConcurrency, totalPages);

  await Promise.all(Array.from({ length: runners }, () => runner()));

  return results;
}

async function rasterizeBuildPdf(compressedPages, { originalBytes, startedAt, workersUsed, onProgress }) {
  if (typeof onProgress === "function") {
    onProgress({ stage: "building", progress: 92 });
  }

  const outputPdf = await PDFDocument.create();

  const perPage = [];

  for (let i = 0; i < compressedPages.length; i++) {
    const item = compressedPages[i];

    if (!item) {
      throw new Error(`Missing compressed page ${i + 1}`);
    }

    const jpegBytes = jpegResultToBytes(item);

    const image = await outputPdf.embedJpg(jpegBytes);

    const page = outputPdf.addPage([item.pdfWidth, item.pdfHeight]);

    page.drawImage(image, {
      x: 0,
      y: 0,
      width: item.pdfWidth,
      height: item.pdfHeight,
    });

    perPage.push({
      pageNumber: i + 1,
      renderedWidth: item.width,
      renderedHeight: item.height,
      jpegBytes: item.jpegBytes,
    });

    item.jpeg = null;

    if (typeof onProgress === "function") {
      onProgress({
        stage: "building",
        progress: 92 + Math.round(((i + 1) / compressedPages.length) * 7),
      });
    }
  }

  if (typeof onProgress === "function") {
    onProgress({ stage: "finalizing", progress: 99 });
  }

  const pdfBytes = await outputPdf.save({
    useObjectStreams: true,
    addDefaultPage: false,
    objectsPerTick: 50,
  });

  const blob = new Blob([pdfBytes], { type: "application/pdf" });

  const compressedBytes = blob.size;
  const savedBytes = Math.max(0, originalBytes - compressedBytes);
  const reduction = originalBytes > 0 ? (savedBytes / originalBytes) * 100 : 0;
  const elapsed = performance.now() - startedAt;

  const stats = {
    pages: compressedPages.length,
    originalBytes,
    compressedBytes,
    savedBytes,
    reduction,
    elapsed,
    workersUsed,
    perPage,
  };

  if (typeof onProgress === "function") {
    onProgress({ stage: "complete", progress: 100 });
  }

  return { blob, stats };
}

/**
 * Legacy full-page rasterization strategy. Renders every page to a bitmap and
 * rebuilds the PDF from those images — this DOES discard text/vector content
 * in favor of pictures of it, so prefer compressPDF() unless you specifically
 * want this (e.g. flattening a document, or it's already scan-only).
 *
 * Same options as before: quality, resolution ("original" to skip
 * downscaling), scale (direct render multiplier, overrides resolution),
 * workers, onProgress.
 *
 * @returns {Promise<{file: File|Blob, stats: object}>}
 */
export async function rasterizePDF(input, options = {}) {
  const {
    quality = 65,
    resolution = 1600,
    scale,
    workers: workerOverride,
    onProgress,
  } = options;

  const startedAt = performance.now();

  const { arrayBuffer, fileName, fileType, originalBytes } = await normalizeInput(input);

  const power = getClientPower();
  const workerCount = workerOverride || power.workers;

  const pool = new CompressionPool();
  pool.init(workerCount);

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer.slice(0)),
    useSystemFonts: true,
    isEvalSupported: true,
  });

  try {
    const pdf = await loadingTask.promise;
    const totalPages = pdf.numPages;

    const compressedPages = await rasterizeProcessPages(pdf, pool, totalPages, {
      quality,
      resolution,
      scale,
      workers: workerCount,
      onProgress,
    });

    const { blob, stats } = await rasterizeBuildPdf(compressedPages, {
      originalBytes,
      startedAt,
      workersUsed: workerCount,
      onProgress,
    });

    const file =
      typeof File !== "undefined"
        ? new File([blob], fileName, { type: fileType })
        : blob;

    return { file, stats };
  } finally {
    try {
      if (loadingTask && typeof loadingTask.destroy === "function") {
        await loadingTask.destroy();
      }
    } catch (cleanupError) {
      console.warn("rasterizePDF: loading task cleanup skipped:", cleanupError);
    }

    pool.destroy();
  }
}
