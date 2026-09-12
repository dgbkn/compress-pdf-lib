/**
 * pdf-compressor.worker.js
 *
 * Worker used by CompressionPool in compress.js.
 * Takes a transferred ImageBitmap, draws it to an OffscreenCanvas (handling
 * any scaling in a single native GPU/canvas draw call), encodes it directly
 * to JPEG using browser-native OffscreenCanvas.convertToBlob(), and transfers
 * the resulting JPEG bytes back to the main thread.
 *
 * 100% native C++ libjpeg-turbo with SIMD hardware acceleration.
 * Zero WASM, zero external dependencies, zero JS heap memory overhead.
 */

self.onmessage = async (event) => {
  const data = event.data;

  if (data?.type !== "compress-image") {
    return;
  }

  const {
    jobId,
    bitmap,
    targetWidth,
    targetHeight,
    pageNumber,
    totalPages,
    quality = 75,
    pdfWidth,
    pdfHeight,
  } = data;

  try {
    if (!bitmap) {
      throw new Error("ImageBitmap missing");
    }

    const width = targetWidth || bitmap.width;
    const height = targetHeight || bitmap.height;

    /* ================================================
       OFFSCREEN CANVAS (SINGLE-PASS DRAW & RESIZE)
    ================================================ */

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });

    if (!ctx) {
      bitmap.close();
      throw new Error("OffscreenCanvas unavailable");
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // Draw and resize in a single hardware-accelerated operation
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    /* ================================================
       DIRECT NATIVE JPEG ENCODING
    ================================================ */

    const q = Math.max(0.01, Math.min(Number(quality) / 100, 1.0));
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: q,
    });

    const jpegBuffer = await blob.arrayBuffer();

    if (!jpegBuffer || jpegBuffer.byteLength === 0) {
      throw new Error("Empty JPEG output");
    }

    // Immediately free canvas memory
    canvas.width = 1;
    canvas.height = 1;

    /* ================================================
       TRANSFER BACK
    ================================================ */

    self.postMessage(
      {
        type: "image-complete",
        jobId,
        pageNumber,
        totalPages,
        jpeg: jpegBuffer,
        jpegBytes: jpegBuffer.byteLength,
        width,
        height,
        pdfWidth,
        pdfHeight,
      },
      [jpegBuffer]
    );
  } catch (error) {
    try {
      bitmap?.close();
    } catch {}

    self.postMessage({
      type: "error",
      jobId,
      pageNumber,
      totalPages,
      message: error?.message || String(error),
    });
  }
};
