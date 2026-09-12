/**
 * pdf-compressor.worker.js
 *
 * Same worker used by CompressionPool in compressPDFLIB.js.
 * Takes a transferred ImageBitmap, draws it to an OffscreenCanvas,
 * encodes it with mozjpeg (WASM) via @jsquash/jpeg, and transfers
 * the resulting JPEG bytes back to the main thread.
 */

import { encode as encodeJpeg } from "@jsquash/jpeg";

self.onmessage = async (event) => {
  const data = event.data;

  if (data?.type !== "compress-image") {
    return;
  }

  const {
    jobId,
    bitmap,
    pageNumber,
    totalPages,
    quality,
    pdfWidth,
    pdfHeight,
  } = data;

  try {
    if (!bitmap) {
      throw new Error("ImageBitmap missing");
    }

    const width = bitmap.width;
    const height = bitmap.height;

    /* ================================================
       OFFSCREEN CANVAS
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

    ctx.drawImage(bitmap, 0, 0, width, height);

    bitmap.close();

    /* ================================================
       GET PIXELS
    ================================================ */

    const imageData = ctx.getImageData(0, 0, width, height);

    /* ================================================
       MOZJPEG WASM
    ================================================ */

    const encoded = await encodeJpeg(imageData, {
      quality: Number(quality),
      progressive: true,
      optimize_coding: true,
    });

    /* ================================================
       NORMALIZE ARRAYBUFFER
    ================================================ */

    let jpegBuffer;

    if (encoded instanceof ArrayBuffer) {
      jpegBuffer = encoded;
    } else if (ArrayBuffer.isView(encoded)) {
      jpegBuffer = encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength
      );
    } else {
      throw new Error("Invalid JPEG encoder output");
    }

    if (jpegBuffer.byteLength === 0) {
      throw new Error("Empty JPEG");
    }

    /* ================================================
       TRANSFER
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

    canvas.width = 1;
    canvas.height = 1;
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
