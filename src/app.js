const MAX_FILE_BYTES = 100 * 1024 * 1024;

const elements = {
  canvasStage: document.querySelector('#canvasStage'),
  clearCovers: document.querySelector('#clearCovers'),
  coverCanvas: document.querySelector('#coverCanvas'),
  coverCount: document.querySelector('#coverCount'),
  downloadButton: document.querySelector('#downloadButton'),
  dropZone: document.querySelector('#dropZone'),
  editorSection: document.querySelector('#editorSection'),
  editorStatus: document.querySelector('#editorStatus'),
  fileInput: document.querySelector('#fileInput'),
  formatSelect: document.querySelector('#formatSelect'),
  inputScan: document.querySelector('#inputScan'),
  maxEdgeSelect: document.querySelector('#maxEdgeSelect'),
  outputPreview: document.querySelector('#outputPreview'),
  outputReport: document.querySelector('#outputReport'),
  outputSection: document.querySelector('#outputSection'),
  outputStatus: document.querySelector('#outputStatus'),
  previewCanvas: document.querySelector('#previewCanvas'),
  qualityField: document.querySelector('#qualityField'),
  qualityOutput: document.querySelector('#qualityOutput'),
  qualityRange: document.querySelector('#qualityRange'),
  resetButton: document.querySelector('#resetButton'),
  runtimeNote: document.querySelector('#runtimeNote'),
  scrubButton: document.querySelector('#scrubButton'),
  shareButton: document.querySelector('#shareButton'),
  sourceFacts: document.querySelector('#sourceFacts'),
  undoCover: document.querySelector('#undoCover'),
  uploadStatus: document.querySelector('#uploadStatus'),
};

const state = {
  activePointerId: null,
  busy: false,
  covers: [],
  draftCover: null,
  expiresAt: 0,
  generation: 0,
  jobId: null,
  output: null,
  previewHeight: 0,
  previewImage: null,
  previewWidth: 0,
  source: null,
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function clearCanvas(canvas) {
  const context = canvas.getContext('2d');
  context?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
}

function setBusy(busy) {
  state.busy = busy;
  elements.fileInput.disabled = busy;
  elements.dropZone.classList.toggle('busy', busy);
  for (const control of elements.editorSection.querySelectorAll('button, input, select')) {
    control.disabled = busy;
  }
  if (!busy) renderCovers();
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('The FrameRinse server returned an unreadable response.');
    }
  }
  if (!response.ok) throw new Error(body.error || `The FrameRinse server returned ${response.status}.`);
  return body;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('The server preview could not be displayed.')), { once: true });
    image.src = url;
  });
}

function cleanupOutput() {
  state.output = null;
  elements.outputPreview.removeAttribute('src');
  elements.outputSection.hidden = true;
  elements.outputReport.replaceChildren();
}

function clearLocalState() {
  cleanupOutput();
  state.activePointerId = null;
  state.covers = [];
  state.draftCover = null;
  state.expiresAt = 0;
  state.jobId = null;
  state.previewImage = null;
  state.previewHeight = 0;
  state.previewWidth = 0;
  state.source = null;
  elements.editorSection.hidden = true;
  clearCanvas(elements.previewCanvas);
  clearCanvas(elements.coverCanvas);
  renderCovers();
}

async function deleteServerJob(id) {
  if (!id) return;
  try {
    await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
  } catch {
    // The server also removes expired jobs automatically.
  }
}

function drawSourcePreview() {
  const width = state.previewImage.naturalWidth;
  const height = state.previewImage.naturalHeight;
  state.previewWidth = width;
  state.previewHeight = height;
  elements.previewCanvas.width = width;
  elements.previewCanvas.height = height;
  elements.coverCanvas.width = width;
  elements.coverCanvas.height = height;
  elements.canvasStage.style.setProperty('--photo-ratio', String(width / height));

  const context = elements.previewCanvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(state.previewImage, 0, 0, width, height);
  renderCovers();
}

function pointOnCoverCanvas(event) {
  const bounds = elements.coverCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
}

function normalizedRectangle(start, end) {
  return {
    height: Math.abs(end.y - start.y),
    width: Math.abs(end.x - start.x),
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
  };
}

function paintCover(context, cover, draft = false) {
  const x = cover.x * state.previewWidth;
  const y = cover.y * state.previewHeight;
  const width = cover.width * state.previewWidth;
  const height = cover.height * state.previewHeight;
  context.fillStyle = draft ? 'rgba(217, 255, 103, 0.72)' : '#050706';
  context.fillRect(x, y, width, height);
  if (draft) {
    context.lineWidth = Math.max(2, state.previewWidth / 400);
    context.strokeStyle = '#17231f';
    context.strokeRect(x, y, width, height);
  }
}

function renderCovers() {
  const context = elements.coverCanvas.getContext('2d');
  context.clearRect(0, 0, elements.coverCanvas.width, elements.coverCanvas.height);
  for (const cover of state.covers) paintCover(context, cover);
  if (state.draftCover) paintCover(context, state.draftCover, true);
  const count = state.covers.length;
  elements.coverCount.textContent = count ? `${count} solid ${count === 1 ? 'cover' : 'covers'} added` : 'No covers added';
  elements.undoCover.disabled = state.busy || count === 0;
  elements.clearCovers.disabled = state.busy || count === 0;
}

function beginCover(event) {
  if (!state.jobId || state.busy || state.activePointerId !== null) return;
  event.preventDefault();
  state.activePointerId = event.pointerId;
  elements.coverCanvas.setPointerCapture?.(event.pointerId);
  const point = pointOnCoverCanvas(event);
  state.draftCover = { height: 0, width: 0, x: point.x, y: point.y, start: point };
  renderCovers();
}

function moveCover(event) {
  if (!state.draftCover || event.pointerId !== state.activePointerId) return;
  event.preventDefault();
  state.draftCover = { ...normalizedRectangle(state.draftCover.start, pointOnCoverCanvas(event)), start: state.draftCover.start };
  renderCovers();
}

function finishCover(event) {
  if (!state.draftCover || event.pointerId !== state.activePointerId) return;
  event.preventDefault();
  const cover = normalizedRectangle(state.draftCover.start, pointOnCoverCanvas(event));
  state.draftCover = null;
  state.activePointerId = null;
  if (cover.width >= 0.006 && cover.height >= 0.006) {
    state.covers.push(cover);
    cleanupOutput();
    setStatus(elements.editorStatus, 'Cover added. Scrub again when the preview looks right.');
  }
  renderCovers();
}

function cancelCover(event) {
  if (!state.draftCover || (event && event.pointerId !== state.activePointerId)) return;
  state.draftCover = null;
  state.activePointerId = null;
  renderCovers();
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function describeCover(cover) {
  return `Left ${Math.round(cover.x * 100)}%, top ${Math.round(cover.y * 100)}%, width ${Math.round(cover.width * 100)}%, height ${Math.round(cover.height * 100)}%.`;
}

function changeCoverFromKeyboard(event) {
  if (!state.jobId || state.busy) return;
  const handled = ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'Delete', 'Backspace'];
  if (!handled.includes(event.key)) return;
  event.preventDefault();

  if (event.key === 'Enter' || event.key === ' ') {
    state.covers.push({ x: 0.35, y: 0.4, width: 0.3, height: 0.2 });
  } else {
    const cover = state.covers.at(-1);
    if (!cover) {
      setStatus(elements.editorStatus, 'Press Enter on the photo to add a cover first.');
      return;
    }
    const step = event.shiftKey ? 0.05 : 0.01;
    if (event.key === 'ArrowLeft') cover.x = clamp(cover.x - step, 0, 1 - cover.width);
    if (event.key === 'ArrowRight') cover.x = clamp(cover.x + step, 0, 1 - cover.width);
    if (event.key === 'ArrowUp') cover.y = clamp(cover.y - step, 0, 1 - cover.height);
    if (event.key === 'ArrowDown') cover.y = clamp(cover.y + step, 0, 1 - cover.height);
    if (['+', '=', '-', '_'].includes(event.key)) {
      const delta = (event.shiftKey ? 0.08 : 0.03) * (event.key === '+' || event.key === '=' ? 1 : -1);
      const centerX = cover.x + cover.width / 2;
      const centerY = cover.y + cover.height / 2;
      cover.width = clamp(cover.width + delta, 0.03, 1);
      cover.height = clamp(cover.height + delta, 0.03, 1);
      cover.x = clamp(centerX - cover.width / 2, 0, 1 - cover.width);
      cover.y = clamp(centerY - cover.height / 2, 0, 1 - cover.height);
    }
    if (event.key === 'Delete' || event.key === 'Backspace') state.covers.pop();
  }

  cleanupOutput();
  renderCovers();
  const cover = state.covers.at(-1);
  setStatus(elements.editorStatus, cover ? `Keyboard cover adjusted. ${describeCover(cover)}` : 'Keyboard cover removed.');
}

function outputReport(output) {
  const labels = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' };
  const reports = [
    'The server rebuilt the image without known EXIF, GPS, XMP, IPTC, comment, text, or embedded-time blocks.',
    `Neutral filename “framerinse.${output.format === 'jpeg' ? 'jpg' : output.format}” replaces the source name.`,
    `${labels[output.format]} output: ${output.width} × ${output.height} (${formatBytes(output.size)}).`,
  ];
  if (output.coverCount) reports.push(`${output.coverCount} solid ${output.coverCount === 1 ? 'cover was' : 'covers were'} painted into the output.`);
  reports.push('The original and output stay in the temporary server job until you clear it or it expires.');
  elements.outputReport.replaceChildren(
    ...reports.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }),
  );
}

async function selectFile(file) {
  if (!file || state.busy) return;
  if (file.size > MAX_FILE_BYTES) {
    setStatus(elements.uploadStatus, 'That photo is over the 100 MB server limit.', true);
    return;
  }
  if (file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name)) {
    setStatus(elements.uploadStatus, 'Choose a raster photo, not an SVG.', true);
    return;
  }

  state.generation += 1;
  const generation = state.generation;
  const previousJob = state.jobId;
  clearLocalState();
  setBusy(true);
  setStatus(elements.uploadStatus, 'Uploading to your FrameRinse server and making a small preview…');
  if (previousJob) await deleteServerJob(previousJob);

  let createdJob = null;
  try {
    const result = await apiJson('/api/jobs', {
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      method: 'POST',
    });
    createdJob = result.id;
    if (generation !== state.generation) {
      await deleteServerJob(createdJob);
      return;
    }
    const previewImage = await loadImage(result.previewUrl);
    if (generation !== state.generation) {
      await deleteServerJob(createdJob);
      return;
    }

    state.expiresAt = result.expiresAt;
    state.jobId = result.id;
    state.previewImage = previewImage;
    state.source = result.source;
    drawSourcePreview();
    elements.sourceFacts.textContent = `${result.source.format.toUpperCase()} · ${result.source.width} × ${result.source.height} · ${formatBytes(result.source.bytes)}`;
    elements.inputScan.textContent =
      result.source.metadataStatus === 'not-fully-checked'
        ? 'Source metadata not fully inspected; output will still be rebuilt'
        : result.source.metadataDetected
          ? 'Embedded metadata detected'
          : 'No common metadata reported';
    elements.editorSection.hidden = false;
    setStatus(elements.uploadStatus, 'Server preview ready. The phone only decoded this smaller copy.');
    setStatus(elements.editorStatus, 'Add solid covers if needed, then ask the server to scrub the photo.');
    const minutes = Math.max(1, Math.ceil((result.expiresAt - Date.now()) / 60000));
    elements.runtimeNote.textContent = `Temporary job stored on your server; automatic cleanup in about ${minutes} minutes.`;
    elements.editorSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (createdJob) await deleteServerJob(createdJob);
    setStatus(elements.uploadStatus, error?.message || 'The server could not prepare that photo.', true);
    elements.fileInput.value = '';
  } finally {
    if (generation === state.generation) setBusy(false);
  }
}

async function scrubPhoto() {
  if (!state.jobId || state.busy) return;
  const generation = state.generation;
  setBusy(true);
  cleanupOutput();
  setStatus(elements.editorStatus, 'Your server is rebuilding and checking the photo…');
  try {
    const output = await apiJson(`/api/jobs/${state.jobId}/scrub`, {
      body: JSON.stringify({
        covers: state.covers.map((cover) => ({ ...cover })),
        format: elements.formatSelect.value,
        maxEdge: Number(elements.maxEdgeSelect.value),
        quality: Number(elements.qualityRange.value),
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (generation !== state.generation) return;
    state.output = output;
    elements.outputPreview.src = `${output.outputUrl}?v=${Date.now()}`;
    outputReport(output);
    elements.outputSection.hidden = false;
    setStatus(elements.editorStatus, 'Server-side scrub complete.');
    setStatus(elements.outputStatus, 'On iPhone, open the image, press and hold it, then choose “Save to Photos”.');
    elements.runtimeNote.textContent = `Cleaned ${output.format.toUpperCase()} ready (${formatBytes(output.size)}).`;
    elements.outputSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus(elements.editorStatus, error?.message || 'The server could not scrub the photo.', true);
  } finally {
    if (generation === state.generation) setBusy(false);
  }
}

function openOutput() {
  if (!state.output) return;
  const link = document.createElement('a');
  link.href = state.output.outputUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setStatus(elements.outputStatus, 'Opened the full image. On iPhone, press and hold it and choose “Save to Photos”.');
}

function downloadOutput() {
  if (!state.output) return;
  const link = document.createElement('a');
  link.href = state.output.downloadUrl;
  link.download = '';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setStatus(elements.outputStatus, 'Cleaned-file download started.');
}

async function resetEverything() {
  const jobId = state.jobId;
  state.generation += 1;
  setBusy(true);
  clearLocalState();
  elements.fileInput.value = '';
  await deleteServerJob(jobId);
  setBusy(false);
  setStatus(elements.uploadStatus, 'Temporary server files cleared. Choose another photo when ready.');
  setStatus(elements.editorStatus, '');
  elements.runtimeNote.textContent = 'No photo is stored in the current session.';
  elements.dropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function invalidateOutput() {
  if (!state.output) return;
  cleanupOutput();
  setStatus(elements.editorStatus, 'Settings changed. Ask the server to scrub again.');
}

elements.fileInput.addEventListener('change', () => selectFile(elements.fileInput.files?.[0]));
elements.dropZone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  elements.dropZone.classList.add('dragging');
});
elements.dropZone.addEventListener('dragover', (event) => event.preventDefault());
elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('dragging'));
elements.dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove('dragging');
  selectFile(event.dataTransfer?.files?.[0]);
});

elements.coverCanvas.addEventListener('pointerdown', beginCover);
elements.coverCanvas.addEventListener('pointermove', moveCover);
elements.coverCanvas.addEventListener('pointerup', finishCover);
elements.coverCanvas.addEventListener('pointercancel', cancelCover);
elements.coverCanvas.addEventListener('lostpointercapture', cancelCover);
elements.coverCanvas.addEventListener('keydown', changeCoverFromKeyboard);
elements.undoCover.addEventListener('click', () => {
  state.covers.pop();
  cleanupOutput();
  renderCovers();
  setStatus(elements.editorStatus, 'Last cover removed.');
});
elements.clearCovers.addEventListener('click', () => {
  state.covers = [];
  cleanupOutput();
  renderCovers();
  setStatus(elements.editorStatus, 'All covers removed.');
});
elements.formatSelect.addEventListener('change', () => {
  elements.qualityField.hidden = elements.formatSelect.value === 'png';
  invalidateOutput();
});
elements.maxEdgeSelect.addEventListener('change', invalidateOutput);
elements.qualityRange.addEventListener('input', () => {
  elements.qualityOutput.value = `${elements.qualityRange.value}%`;
  invalidateOutput();
});
elements.scrubButton.addEventListener('click', scrubPhoto);
elements.shareButton.addEventListener('click', openOutput);
elements.downloadButton.addEventListener('click', downloadOutput);
elements.resetButton.addEventListener('click', resetEverything);
