const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const convertForm = document.getElementById('convertForm');
const convertBtn = document.getElementById('convertBtn');
const statusEl = document.getElementById('status');
const qualityInput = document.getElementById('quality');
const qualityValue = document.getElementById('qualityValue');
const formatSelect = document.getElementById('format');

let selectedFiles = [];

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('drag-over');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

function addFiles(fileListLike) {
  for (const f of fileListLike) selectedFiles.push(f);
  renderFileList();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderFileList() {
  fileList.innerHTML = '';
  selectedFiles.forEach((file, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = file.name;
    const meta = document.createElement('span');
    meta.className = 'size';
    meta.textContent = formatBytes(file.size);
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.type = 'button';
    removeBtn.style.cssText = 'width:auto;padding:0 0.4rem;background:transparent;color:inherit;font-size:0.85rem;';
    removeBtn.addEventListener('click', () => {
      selectedFiles.splice(i, 1);
      renderFileList();
    });
    const right = document.createElement('span');
    right.style.cssText = 'display:flex;align-items:center;gap:0.5rem;';
    right.appendChild(meta);
    right.appendChild(removeBtn);
    li.appendChild(name);
    li.appendChild(right);
    fileList.appendChild(li);
  });
  convertBtn.disabled = selectedFiles.length === 0;
}

qualityInput.addEventListener('input', () => {
  qualityValue.textContent = qualityInput.value;
});

formatSelect.addEventListener('change', () => {
  const isPng = formatSelect.value === 'png';
  qualityInput.disabled = isPng;
});

// Splitting the batch across 2 simultaneous connections measurably speeds up
// the upload -- confirmed via load testing that a single connection doesn't
// use all the available uplink bandwidth (~30% faster with 2 parallel
// streams; going beyond 2 showed diminishing returns, so 2 is the sweet
// spot). Each half is sent as a fully independent /convert request and comes
// back as its own zip -- no server-side coordination needed to merge them.
const UPLOAD_STREAMS = 2;

function splitIntoGroups(files, groupCount) {
  if (files.length <= 1) return [files];
  const n = Math.min(groupCount, files.length);
  const groups = Array.from({ length: n }, () => []);
  files.forEach((file, i) => groups[i % n].push(file));
  return groups;
}

async function convertGroup(files, filename, format, quality, resizeWidth, resizeHeight) {
  // Fields are appended before files on purpose: the server streams this
  // upload and starts decoding+encoding each file as soon as it arrives, so
  // it needs format/quality/resize already in hand before the first file
  // shows up rather than waiting for the whole request to finish.
  const formData = new FormData();
  formData.append('format', format);
  formData.append('quality', quality);
  if (resizeWidth) formData.append('resizeWidth', resizeWidth);
  if (resizeHeight) formData.append('resizeHeight', resizeHeight);
  for (const file of files) formData.append('files', file);

  const res = await fetch('/convert', { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Conversion failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

convertForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedFiles.length) return;

  const format = formatSelect.value;
  const quality = qualityInput.value;
  const resizeWidth = document.getElementById('resizeWidth').value;
  const resizeHeight = document.getElementById('resizeHeight').value;

  const groups = splitIntoGroups(selectedFiles, UPLOAD_STREAMS);
  const filenames = groups.length === 1
    ? ['converted.zip']
    : groups.map((_, i) => `converted-part${i + 1}.zip`);

  convertBtn.disabled = true;
  statusEl.className = 'status';
  statusEl.textContent = groups.length > 1
    ? `Converting ${selectedFiles.length} file(s) across ${groups.length} parallel uploads... this can take a while for large batches.`
    : `Converting ${selectedFiles.length} file(s)... this can take a while for large batches.`;

  const results = await Promise.allSettled(
    groups.map((group, i) => convertGroup(group, filenames[i], format, quality, resizeWidth, resizeHeight))
  );
  const failures = results.filter((r) => r.status === 'rejected');

  if (failures.length === 0) {
    statusEl.className = 'status done';
    statusEl.textContent = groups.length > 1
      ? `Done — ${groups.length} zip files downloaded (your browser may have asked permission for multiple downloads). Check _errors.txt inside each if any files failed to decode.`
      : 'Done — zip downloaded. Check _errors.txt inside if any files failed to decode.';
  } else if (failures.length < results.length) {
    statusEl.className = 'status error';
    statusEl.textContent = `${results.length - failures.length} of ${results.length} batches downloaded; ${failures.length} failed: ${failures.map((f) => f.reason.message).join('; ')}`;
  } else {
    statusEl.className = 'status error';
    statusEl.textContent = `Error: ${failures[0].reason.message}`;
  }

  convertBtn.disabled = selectedFiles.length === 0;
});
