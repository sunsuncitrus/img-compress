/**
 * 本機圖片縮放與壓縮
 */

const ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200, 300, 400];
const PREVIEW_MAX_EDGE = 1200;

const state = {
  files: [],
  activeIndex: 0,
  format: "image/jpeg",
  quality: 0.92,
  scale: 100,
  targetWidth: 0,
  targetHeight: 0,
  naturalWidth: 0,
  naturalHeight: 0,
  lockAspect: true,
  colorPreserve: true,
  smoothEdges: true,
  compareMode: false,
  linkPanes: true,
  zoom: { single: 100, original: 100, output: 100 },
  pan: {
    single: { x: 0, y: 0 },
    original: { x: 0, y: 0 },
    output: { x: 0, y: 0 },
  },
  estimateToken: 0,
  updatingInputs: false,
  needsCentering: true,
};

const PANE_META = {
  single: { viewport: "singleViewport", inner: "singleInner", canvas: "singleCanvas" },
  original: { viewport: "originalViewport", inner: "originalInner", canvas: "originalCanvas" },
  output: { viewport: "outputViewport", inner: "outputInner", canvas: "outputCanvas" },
};

let previewRaf = null;
let estimateTimer = null;
let previewDebounce = null;
let dragState = null;

const $ = (id) => document.getElementById(id);

const dropzone = $("dropzone");
const fileInput = $("fileInput");
const fileList = $("fileList");
const fileListSection = $("fileListSection");
const scaleSlider = $("scaleSlider");
const scaleInput = $("scaleInput");
const widthInput = $("widthInput");
const heightInput = $("heightInput");
const lockAspectCheck = $("lockAspect");
const qualitySlider = $("qualitySlider");
const qualityValue = $("qualityValue");
const qualityRow = $("qualityRow");
const qualityHint = $("qualityHint");
const colorPreserveCheck = $("colorPreserve");
const smoothEdgesCheck = $("smoothEdges");
const btnSinglePreview = $("btnSinglePreview");
const btnComparePreview = $("btnComparePreview");
const linkPanesRow = $("linkPanesRow");
const linkPanesCheck = $("linkPanes");
const previewSingle = $("previewSingle");
const previewDual = $("previewDual");
const previewEmpty = $("previewEmpty");
const previewBadge = $("previewBadge");
const dimInfo = $("dimInfo");
const originalSize = $("originalSize");
const estimatedSize = $("estimatedSize");
const savings = $("savings");
const estimateHint = $("estimateHint");
const downloadTrigger = $("downloadTrigger");
const downloadMenu = $("downloadMenu");
const downloadSelectedBtn = $("downloadSelectedBtn");
const downloadZipBtn = $("downloadZipBtn");
const selectAllFilesCheck = $("selectAllFiles");
const fileSelectionCount = $("fileSelectionCount");
const singleToolbar = $("singleToolbar");
const originalPaneSize = $("originalPaneSize");
const outputPaneSize = $("outputPaneSize");

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

function extensionForMime(mime) {
  return (
    { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[mime] ||
    "bin"
  );
}

function createEntryId() {
  return crypto.randomUUID?.() ?? `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getActiveEntry() {
  return state.files[state.activeIndex] ?? null;
}

function getActiveFile() {
  return getActiveEntry()?.file ?? null;
}

function getSelectedEntries() {
  const selected = state.files.filter((e) => e.selected);
  return selected.length ? selected : state.files.slice();
}

function exportFileName(entry) {
  const base = entry.name.replace(/\.[^.]+$/, "");
  return `${base}.${extensionForMime(entry.format ?? state.format)}`;
}

function uniqueZipName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot + 1) : extensionForMime(state.format);
  let i = 2;
  let candidate = `${base} (${i}).${ext}`;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${base} (${i}).${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function updateDownloadMenuLabels() {
  const n = state.files.filter((e) => e.selected).length;
  const total = state.files.length;
  if (downloadSelectedBtn) {
    downloadSelectedBtn.textContent =
      n > 0 ? `下載勾選檔案 (${n})` : `下載勾選檔案（將下載全部 ${total}）`;
  }
  if (downloadZipBtn) {
    downloadZipBtn.textContent =
      n > 0 ? `下載 ZIP (${n})` : `下載 ZIP（全部 ${total}）`;
  }
  if (fileSelectionCount) {
    fileSelectionCount.textContent =
      total > 0 ? `已選 ${n || total} / 共 ${total}` : "";
  }
  if (selectAllFilesCheck && total > 0) {
    selectAllFilesCheck.checked = n === total;
    selectAllFilesCheck.indeterminate = n > 0 && n < total;
  }
}

function isFocused(el) {
  return document.activeElement === el;
}

function parsePositive(raw) {
  const s = String(raw).trim().replace(/,/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function aspectRatio() {
  return state.naturalHeight / state.naturalWidth || 1;
}

function dimensionsForImage(naturalW, naturalH, customScale) {
  if (!naturalW || !naturalH) return { w: 1, h: 1 };
  const scale = customScale !== undefined ? customScale : state.scale;
  if (state.lockAspect) {
    const ratio = scale / 100;
    return {
      w: Math.max(1, Math.round(naturalW * ratio)),
      h: Math.max(1, Math.round(naturalH * ratio)),
    };
  }
  const activeEntry = getActiveEntry();
  const isActive = activeEntry && activeEntry.naturalWidth === naturalW && activeEntry.naturalHeight === naturalH;
  if (isActive && state.targetWidth && state.targetHeight) {
    const scaleX = state.targetWidth / state.naturalWidth;
    const scaleY = state.targetHeight / state.naturalHeight;
    return {
      w: Math.max(1, Math.round(naturalW * scaleX)),
      h: Math.max(1, Math.round(naturalH * scaleY)),
    };
  }
  const ratio = scale / 100;
  return {
    w: Math.max(1, Math.round(naturalW * ratio)),
    h: Math.max(1, Math.round(naturalH * ratio)),
  };
}

function outputDimensions() {
  return dimensionsForImage(state.naturalWidth, state.naturalHeight);
}

function syncScaleFromDimensions() {
  if (!state.naturalWidth) return;
  state.scale = (state.targetWidth / state.naturalWidth) * 100;
  const entry = getActiveEntry();
  if (entry) {
    entry.scale = state.scale;
  }
}

function syncDimensionsFromScale() {
  if (!state.naturalWidth) return;
  const ratio = state.scale / 100;
  state.targetWidth = Math.max(1, Math.round(state.naturalWidth * ratio));
  state.targetHeight = Math.max(1, Math.round(state.naturalHeight * ratio));
}

function updateDimensionInputs() {
  state.updatingInputs = true;
  scaleSlider.value = state.scale;
  if (!isFocused(scaleInput)) {
    scaleInput.value = state.scale % 1 === 0 ? String(state.scale) : state.scale.toFixed(1);
  }
  if (!isFocused(widthInput)) {
    widthInput.value = state.targetWidth ? String(state.targetWidth) : "";
  }
  if (!isFocused(heightInput)) {
    heightInput.value = state.targetHeight ? String(state.targetHeight) : "";
  }
  state.updatingInputs = false;
}

function updateDimInfo() {
  const { w, h } = outputDimensions();
  dimInfo.textContent = `原始 ${state.naturalWidth}×${state.naturalHeight} → 輸出 ${w}×${h}（${state.scale.toFixed(1)}%）`;
  previewBadge.textContent = `${w} × ${h} px`;
  originalPaneSize.textContent = `${state.naturalWidth}×${state.naturalHeight}`;
  outputPaneSize.textContent = `${w}×${h}`;
}

async function ensureThumb(entry) {
  if (entry.thumbSource) return entry;

  let bitmap;
  if (state.colorPreserve && typeof createImageBitmap === "function") {
    try {
      bitmap = await createImageBitmap(entry.file, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
    } catch {
      bitmap = await loadImageElement(entry.file);
    }
  } else {
    bitmap = await loadImageElement(entry.file);
  }

  entry.naturalWidth = bitmap.width ?? bitmap.naturalWidth;
  entry.naturalHeight = bitmap.height ?? bitmap.naturalHeight;

  const maxDim = Math.max(entry.naturalWidth, entry.naturalHeight);
  const scale = Math.min(1, PREVIEW_MAX_EDGE / maxDim);
  entry.thumbWidth = Math.max(1, Math.round(entry.naturalWidth * scale));
  entry.thumbHeight = Math.max(1, Math.round(entry.naturalHeight * scale));

  if (scale < 1 && typeof createImageBitmap === "function" && bitmap instanceof ImageBitmap) {
    entry.thumbSource = await createImageBitmap(bitmap, {
      resizeWidth: entry.thumbWidth,
      resizeHeight: entry.thumbHeight,
      resizeQuality: "high",
      premultiplyAlpha: "none",
    });
    bitmap.close?.();
  } else if (scale < 1) {
    const c = document.createElement("canvas");
    c.width = entry.thumbWidth;
    c.height = entry.thumbHeight;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, entry.naturalWidth, entry.naturalHeight, 0, 0, entry.thumbWidth, entry.thumbHeight);
    entry.thumbSource = c;
  } else {
    entry.thumbSource = bitmap;
  }

  return entry;
}

async function ensureFullSource(entry) {
  if (entry.fullSource) return entry.fullSource;

  if (state.colorPreserve && typeof createImageBitmap === "function") {
    try {
      entry.fullSource = await createImageBitmap(entry.file, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
    } catch {
      entry.fullSource = await loadImageElement(entry.file);
    }
  } else {
    entry.fullSource = await loadImageElement(entry.file);
  }

  const w = entry.fullSource.width ?? entry.fullSource.naturalWidth;
  const h = entry.fullSource.height ?? entry.fullSource.naturalHeight;
  entry.naturalWidth = w;
  entry.naturalHeight = h;
  return entry.fullSource;
}

async function loadPreviewSource(entry) {
  await ensureThumb(entry);
  return {
    source: entry.thumbSource,
    width: entry.thumbWidth,
    height: entry.thumbHeight,
    naturalWidth: entry.naturalWidth,
    naturalHeight: entry.naturalHeight,
  };
}

async function loadImageSource(fileOrEntry) {
  const entry =
    fileOrEntry && fileOrEntry.file ? fileOrEntry : state.files.find((e) => e.file === fileOrEntry);
  if (!entry) throw new Error("找不到檔案");
  const source = await ensureFullSource(entry);
  return {
    source,
    width: entry.naturalWidth,
    height: entry.naturalHeight,
  };
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("無法讀取圖片"));
    };
    img.src = url;
  });
}

function getCanvasContext(canvas) {
  const opts = { alpha: true };
  if (state.colorPreserve) {
    try {
      return canvas.getContext("2d", { ...opts, colorSpace: "srgb" });
    } catch {
      /* fallback */
    }
  }
  return canvas.getContext("2d", opts);
}

function sourceSize(source) {
  return {
    w: source.width ?? source.naturalWidth,
    h: source.height ?? source.naturalHeight,
  };
}

function drawSource(ctx, source, w, h, fillWhite = false) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, w, h);
  if (fillWhite) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(source, 0, 0, w, h);
}

function drawScaled(ctx, source, srcW, srcH, dstW, dstH) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, dstW, dstH);
}

function softenCanvasEdges(canvas, srcW, scaleRatio) {
  if (!state.smoothEdges || scaleRatio >= 1) return;
  const w = canvas.width;
  const h = canvas.height;
  const blurPx = Math.min(0.8, Math.max(0.25, (1 - scaleRatio) * 0.9));
  const soft = document.createElement("canvas");
  soft.width = w;
  soft.height = h;
  const sctx = soft.getContext("2d");
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.filter = `blur(${blurPx}px)`;
  sctx.drawImage(canvas, 0, 0);
  const ctx = getCanvasContext(canvas);
  const mix = Math.min(0.4, Math.max(0.15, (1 - scaleRatio) * 0.45));
  ctx.globalAlpha = mix;
  ctx.drawImage(soft, 0, 0);
  ctx.globalAlpha = 1;
}

function resizeWithSteps(source, srcW, srcH, targetW, targetH, fillWhite) {
  let cur = source;
  let cw = srcW;
  let ch = srcH;
  let stepCanvas = null;

  if (targetW < cw || targetH < ch) {
    while (cw * 0.5 > targetW && ch * 0.5 > targetH) {
      const nw = Math.max(targetW, Math.floor(cw / 2));
      const nh = Math.max(targetH, Math.floor(ch / 2));
      stepCanvas = document.createElement("canvas");
      stepCanvas.width = nw;
      stepCanvas.height = nh;
      const sctx = getCanvasContext(stepCanvas);
      drawScaled(sctx, cur, cw, ch, nw, nh);
      cur = stepCanvas;
      cw = nw;
      ch = nh;
    }
  }

  const final = document.createElement("canvas");
  final.width = targetW;
  final.height = targetH;
  const ctx = getCanvasContext(final);
  if (fillWhite) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetW, targetH);
  }
  drawScaled(ctx, cur, cw, ch, targetW, targetH);
  softenCanvasEdges(final, srcW, targetW / srcW);
  return final;
}

async function resizeWithBitmap(source, targetW, targetH, fillWhite) {
  let bitmap = source;
  let closeBitmap = false;
  if (!(bitmap instanceof ImageBitmap)) {
    bitmap = await createImageBitmap(source);
    closeBitmap = true;
  }
  try {
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: targetW,
      resizeHeight: targetH,
      resizeQuality: "high",
      premultiplyAlpha: "none",
    });
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = getCanvasContext(canvas);
    if (fillWhite) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(resized, 0, 0);
    resized.close?.();
    const { w: srcW } = sourceSize(source);
    softenCanvasEdges(canvas, srcW, targetW / srcW);
    return canvas;
  } finally {
    if (closeBitmap) bitmap.close?.();
  }
}

async function renderToCanvas(source, w, h, format) {
  const { w: srcW, h: srcH } = sourceSize(source);
  const targetFormat = format !== undefined ? format : state.format;
  const fillWhite = targetFormat === "image/jpeg";
  if (srcW === w && srcH === h) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    drawSource(getCanvasContext(canvas), source, w, h, fillWhite);
    return canvas;
  }

  const shrinking = w < srcW || h < srcH;
  if (
    state.smoothEdges &&
    shrinking &&
    typeof createImageBitmap === "function"
  ) {
    try {
      return await resizeWithBitmap(source, w, h, fillWhite);
    } catch {
      /* fallback */
    }
  }

  return resizeWithSteps(source, srcW, srcH, w, h, fillWhite);
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    if (mime === "image/png") {
      canvas.toBlob((b) => resolve(b), mime);
    } else {
      canvas.toBlob((b) => resolve(b), mime, quality);
    }
  });
}

/** 將壓縮後的檔案解碼回畫面，讓預覽與實際匯出一致 */
async function decodeCompressedPreview(scaledCanvas) {
  if (state.format === "image/png") {
    return scaledCanvas;
  }
  const blob = await canvasToBlob(scaledCanvas, state.format, state.quality);
  if (!blob) return scaledCanvas;

  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("預覽解碼失敗"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function drawOutputPreview(pane, previewSource, w, h) {
  const scaled = await renderToCanvas(previewSource, w, h);
  const previewImage = await decodeCompressedPreview(scaled);
  const { canvas } = getPaneElements(pane);
  canvas.width = w;
  canvas.height = h;
  getCanvasContext(canvas).drawImage(previewImage, 0, 0, w, h);
  if (state.needsCentering) {
    centerPane(pane, true);
  } else {
    applyPaneTransform(pane);
  }
}

async function processImage(entry) {
  const source = await ensureFullSource(entry);
  const { w, h } = dimensionsForImage(entry.naturalWidth, entry.naturalHeight, entry.scale);
  const canvas = await renderToCanvas(source, w, h, entry.format);
  const blob = await canvasToBlob(canvas, entry.format, entry.quality);
  return { blob, width: w, height: h, canvas };
}

function invalidateCache() {
  state.files.forEach((entry) => {
    entry.fullSource?.close?.();
    entry.fullSource = null;
    entry.thumbSource?.close?.();
    entry.thumbSource = null;
    entry.thumbWidth = 0;
    entry.thumbHeight = 0;
  });
}

function nearestZoomIndex(value) {
  let best = 0;
  let diff = Math.abs(ZOOM_STEPS[0] - value);
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    const d = Math.abs(ZOOM_STEPS[i] - value);
    if (d < diff) {
      diff = d;
      best = i;
    }
  }
  return best;
}

function updateZoomLabels() {
  ["single", "original", "output"].forEach((p) => {
    const label = $(`${p}ZoomLabel`);
    if (label) label.textContent = `${Math.round(state.zoom[p])}%`;
  });
}

function isLinkedCompare() {
  return state.compareMode && state.linkPanes;
}

/** 螢幕上的顯示倍率（對照模式下輸出圖會放大到與原圖相同視覺尺寸） */
function getDisplayMultiplierForZoom(pane, zoomPercent) {
  const { canvas } = getPaneElements(pane);
  if (!canvas?.width) return zoomPercent / 100;

  let mult = zoomPercent / 100;
  if (state.compareMode && state.naturalWidth && canvas.width) {
    if (pane === "output" || pane === "original") {
      mult *= state.naturalWidth / canvas.width;
    }
  }
  return mult;
}

function getDisplayMultiplier(pane) {
  return getDisplayMultiplierForZoom(pane, state.zoom[pane]);
}

function getDisplaySize(pane) {
  const { canvas } = getPaneElements(pane);
  const m = getDisplayMultiplier(pane);
  return { w: canvas.width * m, h: canvas.height * m };
}

function imagePointUnderCursor(pane, clientX, clientY) {
  const { viewport, canvas } = getPaneElements(pane);
  if (!viewport || !canvas.width) return null;
  const rect = viewport.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const m = getDisplayMultiplier(pane);
  return {
    x: (mx - state.pan[pane].x) / m,
    y: (my - state.pan[pane].y) / m,
    mx,
    my,
  };
}

function syncOutputFromOriginal() {
  if (!isLinkedCompare()) return;
  const origW = state.naturalWidth;
  const origH = state.naturalHeight;
  const { w: outW, h: outH } = outputDimensions();
  if (!origW || !outW) return;

  const { viewport: origVp, canvas: origCanvas } = getPaneElements("original");
  const { viewport: outVp } = getPaneElements("output");
  if (!origVp || !outVp || !origCanvas) return;

  state.zoom.output = state.zoom.original;
  updateZoomLabels();

  const origM = getDisplayMultiplier("original");
  const outM = getDisplayMultiplier("output");

  const centerCanvasX = (origVp.clientWidth / 2 - state.pan.original.x) / origM;
  const centerCanvasY = (origVp.clientHeight / 2 - state.pan.original.y) / origM;
  const normX = centerCanvasX / origCanvas.width;
  const normY = centerCanvasY / origCanvas.height;

  state.pan.output = {
    x: outVp.clientWidth / 2 - normX * outW * outM,
    y: outVp.clientHeight / 2 - normY * outH * outM,
  };
  applyPaneTransform("output");
}

function syncOriginalFromOutput() {
  if (!isLinkedCompare()) return;
  const origW = state.naturalWidth;
  const origH = state.naturalHeight;
  const { w: outW, h: outH } = outputDimensions();
  if (!origW || !outW) return;

  const { viewport: origVp, canvas: origCanvas } = getPaneElements("original");
  const { viewport: outVp } = getPaneElements("output");
  if (!origVp || !outVp || !origCanvas) return;

  state.zoom.original = state.zoom.output;
  updateZoomLabels();

  const origM = getDisplayMultiplier("original");
  const outM = getDisplayMultiplier("output");

  const centerCanvasX = (outVp.clientWidth / 2 - state.pan.output.x) / outM;
  const centerCanvasY = (outVp.clientHeight / 2 - state.pan.output.y) / outM;
  const normX = centerCanvasX / outW;
  const normY = centerCanvasY / outH;

  state.pan.original = {
    x: origVp.clientWidth / 2 - normX * origCanvas.width * origM,
    y: origVp.clientHeight / 2 - normY * origCanvas.height * origM,
  };
  applyPaneTransform("original");
}

function syncLinkedFromPane(sourcePane) {
  if (!isLinkedCompare()) return;
  if (sourcePane === "original") syncOutputFromOriginal();
  else if (sourcePane === "output") syncOriginalFromOutput();
}

function setZoom(pane, value, resetPan = false) {
  const clamped = Math.min(400, Math.max(25, value));

  if (isLinkedCompare()) {
    const driver = pane === "output" ? "output" : "original";
    const prevZoom = state.zoom[driver];
    const prevM = getDisplayMultiplierForZoom(driver, prevZoom);
    const newM = getDisplayMultiplierForZoom(driver, clamped);

    state.zoom.original = clamped;
    state.zoom.output = clamped;
    updateZoomLabels();
    if (resetPan) {
      centerPane("original");
      syncOutputFromOriginal();
      return;
    }
    const { viewport } = getPaneElements(driver);
    if (viewport) {
      const cx = viewport.clientWidth / 2;
      const cy = viewport.clientHeight / 2;
      const imgX = (cx - state.pan[driver].x) / prevM;
      const imgY = (cy - state.pan[driver].y) / prevM;
      state.pan[driver].x = cx - imgX * newM;
      state.pan[driver].y = cy - imgY * newM;
    }
    applyPaneTransform("original");
    applyPaneTransform("output");
    syncLinkedFromPane(driver);
    return;
  }

  const prevZoom = state.zoom[pane];
  const prevM = getDisplayMultiplierForZoom(pane, prevZoom);
  const newM = getDisplayMultiplierForZoom(pane, clamped);

  state.zoom[pane] = clamped;
  updateZoomLabels();

  if (resetPan) {
    centerPane(pane);
    return;
  }

  const { viewport, canvas } = getPaneElements(pane);
  if (viewport && canvas.width) {
    const cx = viewport.clientWidth / 2;
    const cy = viewport.clientHeight / 2;
    const imgX = (cx - state.pan[pane].x) / prevM;
    const imgY = (cy - state.pan[pane].y) / prevM;
    state.pan[pane].x = cx - imgX * newM;
    state.pan[pane].y = cy - imgY * newM;
  }
  applyPaneTransform(pane);
}

function smoothZoomWheel(pane, e) {
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 18;
  if (e.deltaMode === 2) {
    const { viewport } = getPaneElements(pane);
    delta *= viewport?.clientHeight ?? 400;
  }

  const factor = Math.exp(-delta * 0.0011);
  const driver =
    isLinkedCompare() && pane === "output" ? "output" : isLinkedCompare() ? "original" : pane;
  const current = state.zoom[driver];
  const next = Math.min(400, Math.max(25, current * factor));
  if (Math.abs(next - current) < 0.08) return;

  const pt = imagePointUnderCursor(pane, e.clientX, e.clientY);
  if (!pt) return;

  if (isLinkedCompare()) {
    state.zoom.original = next;
    state.zoom.output = next;
    updateZoomLabels();
    const newM = getDisplayMultiplier(pane);
    state.pan[pane].x = pt.mx - pt.x * newM;
    state.pan[pane].y = pt.my - pt.y * newM;
    applyPaneTransform(pane);
    syncLinkedFromPane(pane);
  } else {
    state.zoom[pane] = next;
    updateZoomLabels();
    const newM = getDisplayMultiplier(pane);
    state.pan[pane].x = pt.mx - pt.x * newM;
    state.pan[pane].y = pt.my - pt.y * newM;
    applyPaneTransform(pane);
  }
}

function adjustZoom(pane, direction) {
  const driver =
    isLinkedCompare() && pane === "output" ? "output" : pane;
  const idx = nearestZoomIndex(state.zoom[driver]);
  const next =
    direction === "in"
      ? ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, idx + 1)]
      : ZOOM_STEPS[Math.max(0, idx - 1)];
  setZoom(driver, next);
}

function getPaneElements(pane) {
  const meta = PANE_META[pane];
  return {
    viewport: $(meta.viewport),
    inner: $(meta.inner),
    canvas: $(meta.canvas),
  };
}

function applyPaneTransform(pane) {
  const { inner, canvas } = getPaneElements(pane);
  if (!inner || !canvas.width) return;

  const { x, y } = state.pan[pane];
  const { w: displayW, h: displayH } = getDisplaySize(pane);

  canvas.style.width = `${displayW}px`;
  canvas.style.height = `${displayH}px`;
  inner.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function centerPane(pane, skipSync = false) {
  const { viewport, canvas } = getPaneElements(pane);
  if (!viewport || !canvas.width) return;

  const { w: displayW, h: displayH } = getDisplaySize(pane);
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;

  state.pan[pane] = {
    x: (vw - displayW) / 2,
    y: (vh - displayH) / 2,
  };
  applyPaneTransform(pane);
  if (!skipSync && !state.needsCentering && isLinkedCompare()) {
    if (pane === "original") syncOutputFromOriginal();
    else if (pane === "output") syncOriginalFromOutput();
  }
}

function resetAllPans() {
  centerPane("original");
  centerPane("output");
  centerPane("single");
  if (isLinkedCompare() && !state.needsCentering) syncOutputFromOriginal();
}

function drawToPane(pane, source, pixelW, pixelH, skipSync = false) {
  const { canvas } = getPaneElements(pane);
  canvas.width = pixelW;
  canvas.height = pixelH;
  canvas.style.width = `${pixelW}px`;
  canvas.style.height = `${pixelH}px`;
  drawSource(getCanvasContext(canvas), source, pixelW, pixelH, false);
  if (state.needsCentering) {
    centerPane(pane, skipSync);
  } else {
    applyPaneTransform(pane);
  }
}

function updatePreviewModeUI() {
  previewSingle.hidden = state.compareMode;
  previewDual.hidden = !state.compareMode;
  linkPanesRow.hidden = !state.compareMode;
  btnSinglePreview.classList.toggle("active", !state.compareMode);
  btnComparePreview.classList.toggle("active", state.compareMode);
}

function updateFileListUI() {
  fileList.innerHTML = "";
  state.files.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className = "file-item";
    li.classList.toggle("active", i === state.activeIndex);

    const checkLabel = document.createElement("label");
    checkLabel.className = "file-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = entry.selected;
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => {
      entry.selected = checkbox.checked;
      updateDownloadMenuLabels();
    });
    checkLabel.appendChild(checkbox);

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = `${entry.name} (${formatBytes(entry.size)})`;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "file-remove";
    removeBtn.setAttribute("aria-label", "移除");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFile(entry.id);
    });

    li.appendChild(checkLabel);
    li.appendChild(name);
    li.appendChild(removeBtn);
    li.addEventListener("click", () => selectFile(i));
    fileList.appendChild(li);
  });

  fileListSection.hidden = state.files.length === 0;
  if (downloadTrigger) downloadTrigger.disabled = state.files.length === 0;
  updateDownloadMenuLabels();
}

function removeFile(id) {
  const index = state.files.findIndex((e) => e.id === id);
  if (index < 0) return;

  const entry = state.files[index];
  entry.fullSource?.close?.();
  entry.thumbSource?.close?.();
  state.files.splice(index, 1);

  if (!state.files.length) {
    state.activeIndex = 0;
    state.naturalWidth = 0;
    state.naturalHeight = 0;
    updateFileListUI();
    previewEmpty.hidden = false;
    singleToolbar.hidden = true;
    if (downloadTrigger) downloadTrigger.disabled = true;
    return;
  }

  if (state.activeIndex >= state.files.length) {
    state.activeIndex = state.files.length - 1;
  } else if (index < state.activeIndex) {
    state.activeIndex -= 1;
  }

  updateFileListUI();
  selectFile(state.activeIndex);
}

async function selectFile(index) {
  state.activeIndex = index;
  const entry = getActiveEntry();
  if (!entry) return;

  await ensureThumb(entry);
  state.naturalWidth = entry.naturalWidth;
  state.naturalHeight = entry.naturalHeight;
  state.scale = entry.scale;
  state.format = entry.format;
  state.quality = entry.quality;

  syncDimensionsFromScale();
  updateDimensionInputs();
  updateFormatTabsUI();
  updateQualityUI();

  updateFileListUI();
  state.needsCentering = true;
  resetAllPans();
  schedulePreview(true);
  scheduleEstimate();
}

function schedulePreview(immediate = false) {
  clearTimeout(previewDebounce);
  if (immediate) {
    runPreview();
    return;
  }
  previewDebounce = setTimeout(() => {
    if (previewRaf) cancelAnimationFrame(previewRaf);
    previewRaf = requestAnimationFrame(() => runPreview());
  }, 80);
}

async function runPreview() {
  const entry = getActiveEntry();
  if (!entry) {
    previewEmpty.hidden = false;
    singleToolbar.hidden = true;
    return;
  }

  try {
    const { source, width, height, naturalWidth, naturalHeight } =
      await loadPreviewSource(entry);
    state.naturalWidth = naturalWidth;
    state.naturalHeight = naturalHeight;
    const { w, h } = outputDimensions();
    updateDimInfo();
    originalSize.textContent = formatBytes(entry.size);
    previewEmpty.hidden = true;
    singleToolbar.hidden = false;
    updatePreviewModeUI();

    if (state.compareMode) {
      drawToPane("original", source, width, height, true);  // skipSync = true
      await drawOutputPreview("output", source, w, h);
      if (isLinkedCompare() && !state.needsCentering) syncOutputFromOriginal();  // output 畫完後才 sync
    } else {
      await drawOutputPreview("single", source, w, h);
    }
    state.needsCentering = false;
  } catch (e) {
    console.error(e);
    previewBadge.textContent = "預覽失敗";
  }
}

function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(runEstimate, 200);
}

async function runEstimate() {
  const entry = getActiveEntry();
  if (!entry) {
    estimatedSize.textContent = "—";
    savings.textContent = "—";
    return;
  }

  const token = ++state.estimateToken;
  estimateHint.textContent = "試算中…";
  estimateHint.classList.add("computing");

  try {
    const { blob } = await processImage(entry);
    if (token !== state.estimateToken) return;

    const est = blob?.size ?? 0;
    estimatedSize.textContent = formatBytes(est);
    const diff = entry.size - est;
    const pct = entry.size > 0 ? ((diff / entry.size) * 100).toFixed(0) : 0;
    if (diff > 0) {
      savings.textContent = `約少 ${formatBytes(diff)}（${pct}%）`;
      savings.classList.add("positive");
    } else if (diff < 0) {
      savings.textContent = `約大 ${formatBytes(-diff)}`;
      savings.classList.remove("positive");
    } else {
      savings.textContent = "與原檔相近";
      savings.classList.remove("positive");
    }
    estimateHint.textContent = "依目前設定試編碼估算";
  } catch {
    estimatedSize.textContent = "—";
    estimateHint.textContent = "試算失敗";
  } finally {
    estimateHint.classList.remove("computing");
  }
}

async function exportOne(entry) {
  const { blob } = await processImage(entry);
  downloadBlob(blob, exportFileName(entry));
}

async function exportEntries(entries, asZip = false) {
  if (!entries.length) return;

  if (asZip) {
    if (typeof JSZip === "undefined") {
      alert("ZIP 功能載入失敗，請重新整理頁面。");
      return;
    }
    const zip = new JSZip();
    const used = new Set();
    downloadTrigger.disabled = true;
    downloadTrigger.textContent = "打包中…";

    for (let i = 0; i < entries.length; i++) {
      downloadTrigger.textContent = `打包中… (${i + 1}/${entries.length})`;
      const { blob } = await processImage(entries[i]);
      const name = uniqueZipName(exportFileName(entries[i]), used);
      zip.file(name, blob);
    }

    const zipBlob = await zip.generateAsync({ type: "blob" });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    downloadBlob(zipBlob, `images_${stamp}.zip`);
    downloadTrigger.textContent = "下載 ▾";
    downloadTrigger.disabled = state.files.length === 0;
    return;
  }

  downloadTrigger.disabled = true;
  for (let i = 0; i < entries.length; i++) {
    downloadTrigger.textContent = `下載中… (${i + 1}/${entries.length})`;
    await exportOne(entries[i]);
    if (entries.length > 1) await new Promise((r) => setTimeout(r, 250));
  }
  downloadTrigger.textContent = "下載 ▾";
  downloadTrigger.disabled = state.files.length === 0;
}

async function addFiles(fileListLike) {
  const incoming = Array.from(fileListLike).filter((f) =>
    f.type.startsWith("image/")
  );
  if (!incoming.length) return;

  const wasEmpty = state.files.length === 0;
  for (const file of incoming) {
    state.files.push({
      id: createEntryId(),
      file,
      name: file.name,
      size: file.size,
      selected: true,
      naturalWidth: 0,
      naturalHeight: 0,
      thumbWidth: 0,
      thumbHeight: 0,
      thumbSource: null,
      fullSource: null,
      scale: state.scale,
      format: state.format,
      quality: state.quality,
    });
  }

  if (wasEmpty) await selectFile(0);
  else {
    updateFileListUI();
    for (const entry of state.files.slice(-incoming.length)) {
      await ensureThumb(entry);
    }
  }
}

function applyScale(v, options = {}) {
  const { refreshPreview = true } = options;
  state.scale = Math.min(200, Math.max(5, v));
  const entry = getActiveEntry();
  if (entry) {
    entry.scale = state.scale;
  }
  syncDimensionsFromScale();
  updateDimensionInputs();
  updateDimInfo();
  if (refreshPreview) schedulePreview();
  scheduleEstimate();
}

function commitScaleInput() {
  const n = parsePositive(scaleInput.value);
  if (n === null) {
    updateDimensionInputs();
    return;
  }
  applyScale(n);
}

function commitWidthInput() {
  if (!state.naturalWidth) return;
  const n = parsePositive(widthInput.value);
  if (n === null) {
    updateDimensionInputs();
    return;
  }
  const w = Math.max(1, Math.round(n));
  state.targetWidth = w;
  if (state.lockAspect) {
    state.targetHeight = Math.max(1, Math.round(w * aspectRatio()));
  }
  syncScaleFromDimensions();
  updateDimensionInputs();
  updateDimInfo();
  schedulePreview();
  scheduleEstimate();
}

function commitHeightInput() {
  if (!state.naturalWidth) return;
  const n = parsePositive(heightInput.value);
  if (n === null) {
    updateDimensionInputs();
    return;
  }
  const h = Math.max(1, Math.round(n));
  state.targetHeight = h;
  if (state.lockAspect) {
    state.targetWidth = Math.max(1, Math.round(h / aspectRatio()));
  }
  syncScaleFromDimensions();
  updateDimensionInputs();
  updateDimInfo();
  schedulePreview();
  scheduleEstimate();
}

function bindNumericField(input, onCommit) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
  });
  input.addEventListener("blur", () => {
    if (state.updatingInputs) return;
    onCommit();
  });
}

function setupPaneInteraction(pane) {
  const { viewport } = getPaneElements(pane);
  if (!viewport) return;

  viewport.addEventListener(
    "wheel",
    (e) => {
      if (!getActiveFile()) return;
      e.preventDefault();
      smoothZoomWheel(pane, e);
    },
    { passive: false }
  );

  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !getActiveFile()) return;
    e.preventDefault();
    dragState = {
      pane,
      startX: e.clientX,
      startY: e.clientY,
      panX: state.pan[pane].x,
      panY: state.pan[pane].y,
    };
    viewport.classList.add("is-dragging");
  });
}

function onDragMove(e) {
  if (!dragState) return;
  const { pane, startX, startY, panX, panY } = dragState;
  state.pan[pane] = {
    x: panX + (e.clientX - startX),
    y: panY + (e.clientY - startY),
  };
  applyPaneTransform(pane);
  syncLinkedFromPane(pane);
}

function endDrag() {
  if (!dragState) return;
  const { viewport } = getPaneElements(dragState.pane);
  viewport?.classList.remove("is-dragging");
  dragState = null;
}

window.addEventListener("pointermove", onDragMove);
window.addEventListener("pointerup", endDrag);

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  addFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

scaleSlider.addEventListener("input", () => {
  if (state.updatingInputs) return;
  applyScale(Number(scaleSlider.value));
});

bindNumericField(scaleInput, commitScaleInput);
bindNumericField(widthInput, commitWidthInput);
bindNumericField(heightInput, commitHeightInput);

lockAspectCheck.addEventListener("change", () => {
  state.lockAspect = lockAspectCheck.checked;
  if (state.lockAspect) syncDimensionsFromScale();
  updateDimensionInputs();
});

document.querySelectorAll("[data-scale]").forEach((btn) => {
  btn.addEventListener("click", () => applyScale(Number(btn.dataset.scale)));
});

function updateQualityRowVisibility() {
  const show = state.format === "image/jpeg" || state.format === "image/webp";
  qualityRow.classList.toggle("hidden", !show);
  document.querySelector(".compress-presets")?.classList.toggle("hidden", !show);
  if (qualityHint) {
    if (state.format === "image/png") {
      qualityHint.textContent = "PNG 為無損，只能壓縮一定程度。";
    } else if (state.format === "image/webp") {
      qualityHint.textContent = "WebP 常比 JPEG 小 25～40%，色彩通常仍佳。";
    } else {
      const previewNote =
        state.format === "image/png"
          ? ""
          : "";
      qualityHint.textContent =
        state.quality >= 0.9
          ? `畫質優先${previewNote}`
          : state.quality >= 0.82
            ? `平衡${previewNote}`
            : `小檔案${previewNote}`;
    }
  }
}

function updateFormatTabsUI() {
  document.querySelectorAll(".format-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.format === state.format);
  });
}

function updateQualityUI() {
  const q = Math.round(state.quality * 100);
  qualitySlider.value = q;
  qualityValue.textContent = String(q);
  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.quality) === q);
  });
  updateQualityRowVisibility();
}

function setQuality(percent) {
  const q = Math.min(100, Math.max(60, percent));
  state.quality = q / 100;
  const entry = getActiveEntry();
  if (entry) {
    entry.quality = state.quality;
  }
  updateQualityUI();
  schedulePreview();
  scheduleEstimate();
}

document.querySelectorAll(".format-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".format-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.format = tab.dataset.format;
    const entry = getActiveEntry();
    if (entry) {
      entry.format = state.format;
    }
    updateQualityRowVisibility();
    schedulePreview();
    scheduleEstimate();
  });
});

document.querySelectorAll("[data-quality]").forEach((btn) => {
  btn.addEventListener("click", () => setQuality(Number(btn.dataset.quality)));
});

colorPreserveCheck.addEventListener("change", () => {
  state.colorPreserve = colorPreserveCheck.checked;
  invalidateCache();
  schedulePreview(true);
  scheduleEstimate();
});

smoothEdgesCheck.addEventListener("change", () => {
  state.smoothEdges = smoothEdgesCheck.checked;
  schedulePreview(true);
  scheduleEstimate();
});

function setPreviewMode(compare) {
  state.compareMode = compare;
  updatePreviewModeUI();
  state.needsCentering = true;
  resetAllPans();
  schedulePreview(true);
}

btnSinglePreview.addEventListener("click", () => setPreviewMode(false));
btnComparePreview.addEventListener("click", () => setPreviewMode(true));

linkPanesCheck.addEventListener("change", () => {
  state.linkPanes = linkPanesCheck.checked;
  if (state.linkPanes && state.compareMode) {
    syncOutputFromOriginal();
  }
});

qualitySlider.addEventListener("input", () => {
  setQuality(Number(qualitySlider.value));
});

updateQualityRowVisibility();
document.querySelector('[data-preset="high"]')?.classList.add("active");

document.querySelectorAll(".btn-zoom").forEach((btn) => {
  btn.addEventListener("click", () => {
    const pane = btn.dataset.pane;
    const action = btn.dataset.action;
    if (action === "fit") {
      setZoom(pane, 100, true);
    } else {
      adjustZoom(pane, action);
    }
  });
});

["single", "original", "output"].forEach(setupPaneInteraction);

function setDownloadMenuOpen(open) {
  if (!downloadMenu || !downloadTrigger) return;
  downloadMenu.hidden = !open;
  downloadTrigger.setAttribute("aria-expanded", open ? "true" : "false");
}

downloadTrigger?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (downloadTrigger.disabled) return;
  setDownloadMenuOpen(downloadMenu.hidden);
});

document.addEventListener("click", () => setDownloadMenuOpen(false));

downloadMenu?.addEventListener("click", (e) => e.stopPropagation());

downloadMenu?.querySelectorAll("[data-download]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    setDownloadMenuOpen(false);
    const mode = btn.dataset.download;
    const active = getActiveEntry();
    if (!active) return;

    try {
      if (mode === "current") {
        await exportOne(active);
      } else if (mode === "selected") {
        await exportEntries(getSelectedEntries(), false);
      } else if (mode === "all") {
        await exportEntries(state.files.slice(), false);
      } else if (mode === "zip") {
        await exportEntries(getSelectedEntries(), true);
      }
    } catch (e) {
      console.error(e);
      alert("下載失敗，請再試一次。");
    } finally {
      if (downloadTrigger) {
        downloadTrigger.textContent = "下載 ▾";
        downloadTrigger.disabled = state.files.length === 0;
      }
    }
  });
});

selectAllFilesCheck?.addEventListener("change", () => {
  const checked = selectAllFilesCheck.checked;
  state.files.forEach((e) => {
    e.selected = checked;
  });
  updateFileListUI();
});

updatePreviewModeUI();
