/// <reference lib="webworker" />

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

const workerScope = self as DedicatedWorkerGlobalScope;

prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => path.endsWith(".wasm") ? wasmUrl : prefix + path } });

workerScope.onmessage = async (event: MessageEvent<{ id: number; buffer: ArrayBuffer; width: number; height: number }>) => {
  const { id, buffer, width, height } = event.data;
  try {
    const image = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const results = await readBarcodes(image, { formats: ["QRCode"], maxNumberOfSymbols: 1 });
    const result = results.find((candidate) => candidate.isValid && candidate.bytes.length > 0);
    const bytes = result ? new Uint8Array(result.bytes) : null;
    workerScope.postMessage({ id, bytes }, bytes ? [bytes.buffer] : []);
  } catch {
    workerScope.postMessage({ id, bytes: null });
  }
};

void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] }).catch(() => undefined).then(() => workerScope.postMessage({ id: -1, bytes: null }));
