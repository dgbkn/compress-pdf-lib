/**
 * compress.js
 *
 * Full, UI-less PDF compression library: worker-pool + parallel page
 * rendering + mozjpeg (WASM) encoding + pdf-lib rebuild.
 *
 * Pairs with pdf-compressor.worker.js (same folder).
 *
 * Usage:
 *   import { compressPDF } from 'compress-pdf-lib';
 *
 *   const { file, stats } = await compressPDF(pdfFile, {
 *     quality: 70,
 *     resolution: 1600,
 *   });
 *
 *   console.log(stats);
 *   // {
 *   //   pages, originalBytes, compressedBytes, savedBytes,
 *   //   reduction, elapsed, workersUsed, perPage: [...]
 *   // }
 */

import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument } from "pdf-lib";
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
   SAFE PDF PAGE CLEANUP
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

/* ============================================================
   INPUT NORMALIZATION
============================================================ */

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

/* ============================================================
   RENDER + COMPRESS ONE PAGE
============================================================ */

async function processPage(pdf, pool, pageNumber, totalPages, { quality, resolution }) {
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

    if (resolution === "original" || resolution === Infinity) {
      /*
       * No downscaling — render at the max allowed multiplier so page
       * quality is limited only by the JPEG quality setting, not by
       * resizing.
       */
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

/* ============================================================
   PARALLEL PAGE PIPELINE
============================================================ */

async function processPages(pdf, pool, totalPages, { quality, resolution, workers, onProgress }) {
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

      const result = await processPage(pdf, pool, pageNumber, totalPages, {
        quality,
        resolution,
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

/* ============================================================
   BUILD FINAL PDF
============================================================ */

async function buildPdf(compressedPages, { originalBytes, startedAt, workersUsed, onProgress }) {
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

    let jpegBytes;

    if (item.jpeg instanceof ArrayBuffer) {
      jpegBytes = new Uint8Array(item.jpeg);
    } else if (item.jpeg instanceof Uint8Array) {
      jpegBytes = item.jpeg;
    } else if (ArrayBuffer.isView(item.jpeg)) {
      jpegBytes = new Uint8Array(item.jpeg.buffer, item.jpeg.byteOffset, item.jpeg.byteLength);
    } else {
      throw new Error(`Invalid JPEG for page ${i + 1}`);
    }

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

/* ============================================================
   PUBLIC API
============================================================ */

/**
 * Compress a PDF using the same render -> mozjpeg WASM -> pdf-lib rebuild
 * pipeline as the original app, run across a parallel worker pool.
 *
 * @param {File|Blob|ArrayBuffer|ArrayBufferView} input
 * @param {Object} [options]
 * @param {number} [options.quality=65] - JPEG quality, 0-100
 * @param {number|"original"} [options.resolution=1600] - max px on the longest
 *   page side. Pass "original" (or Infinity) to skip downscaling entirely and
 *   rely on `quality` alone — renders at the max supported multiplier (3x).
 * @param {number} [options.workers] - override auto-detected worker count
 * @param {(update: object) => void} [options.onProgress] - optional progress callback
 * @returns {Promise<{file: File|Blob, stats: object}>}
 */
export async function compressPDF(input, options = {}) {
  const { quality = 65, resolution = 1600, workers: workerOverride, onProgress } = options;

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

    const compressedPages = await processPages(pdf, pool, totalPages, {
      quality,
      resolution,
      workers: workerCount,
      onProgress,
    });

    const { blob, stats } = await buildPdf(compressedPages, {
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
      console.warn("compressPDF: loading task cleanup skipped:", cleanupError);
    }

    pool.destroy();
  }
}