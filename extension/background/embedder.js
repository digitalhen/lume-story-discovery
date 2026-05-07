import {
  pipeline,
  env,
} from "../lib/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = browser.runtime.getURL("lib/");
env.backends.onnx.wasm.numThreads = 1;

const MODEL = "Xenova/all-MiniLM-L6-v2";
const DIM = 384;

let extractor = null;
let warmingPromise = null;
let warmStartedAt = 0;

export function modelName() { return MODEL; }
export function modelDim() { return DIM; }
export function isReady() { return extractor !== null; }

export function warmUp() {
  if (extractor) return Promise.resolve();
  if (warmingPromise) return warmingPromise;
  warmStartedAt = performance.now();
  console.log(`[disco] warming model ${MODEL}…`);
  warmingPromise = pipeline("feature-extraction", MODEL, {
    progress_callback: (p) => {
      if (p.status === "progress" && p.total) {
        const pct = ((p.loaded / p.total) * 100).toFixed(0);
        console.log(`[disco] model: ${p.file} ${pct}%`);
      } else if (p.status === "ready") {
        console.log(`[disco] model ready (${(performance.now() - warmStartedAt).toFixed(0)} ms)`);
      }
    },
  }).then((ex) => {
    extractor = ex;
    return ex;
  }).catch((err) => {
    warmingPromise = null;
    console.error("[disco] model load failed:", err);
    throw err;
  });
  return warmingPromise;
}

export async function embed(text) {
  if (!extractor) await warmUp();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(out.data);
}

export async function embedBatch(texts) {
  if (!extractor) await warmUp();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  // out.data is a flat Float32Array of length texts.length * DIM
  const result = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(out.data.slice(i * DIM, (i + 1) * DIM));
  }
  return result;
}
