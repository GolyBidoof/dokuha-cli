/**
 * Render worker: reassembles and re-encodes one page.
 *
 * Kept as a tiny shim over `renderPage` so the worker path and the inline path
 * can never diverge in behaviour. The result's pixel buffer is transferred back
 * rather than copied.
 */
import { parentPort } from 'node:worker_threads';
import { renderPage } from './codec.js';

parentPort.on('message', (message) => {
  try {
    const rendered = renderPage(message.bytes, message, {
      format: message.format,
      quality: message.quality,
      subsample: message.subsample,
    });
    // Rebuild the bytes as an exact, zero-offset view before transferring.
    //
    // `rendered.data` is usually a Buffer taken from Node's shared pool, so both
    // `data.byteOffset` and the underlying `data.buffer` are wrong as a unit: the
    // buffer is a 64 KiB slab shared with unrelated allocations, and the image is
    // just a slice of it. Transferring that slab shipped the wrong byte range and
    // detached memory other buffers still pointed at, which surfaced
    // intermittently far from here as
    //   DataCloneError: Cannot transfer object of unsupported type.
    //
    // `Uint8Array.from` copies into a fresh, exact-length, zero-offset buffer, so
    // what is transferred is precisely the image and nothing else. Slicing the
    // slab instead is not enough: the view would keep its original byteOffset and
    // be rebuilt against the wrong base on the other side.
    const exact = Uint8Array.from(rendered.data);

    parentPort.postMessage(
      {
        result: {
          width: rendered.width,
          height: rendered.height,
          format: rendered.format,
          extension: rendered.extension,
          kind: rendered.kind,
          changed: rendered.changed,
          data: exact,
        },
      },
      // The transfer list takes the ArrayBuffer; `exact` is the view onto it.
      [exact.buffer],
    );
  } catch (error) {
    parentPort.postMessage({ error: error?.stack ?? String(error) });
  }
});
