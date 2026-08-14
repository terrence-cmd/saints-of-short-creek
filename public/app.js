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

convertForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedFiles.length) return;

  // Fields are appended before files on purpose: the server streams this
  // upload and starts decoding+encoding each file as soon as it arrives, so
  // it needs format/quality/resize already in hand before the first file
  // shows up rather than waiting for the whole request to finish.
  const formData = new FormData();
  formData.append('format', formatSelect.value);
  formData.append('quality', qualityInput.value);

  const resizeWidth = document.getElementById('resizeWidth').value;
  const resizeHeight = document.getElementById('resizeHeight').value;
  if (resizeWidth) formData.append('resizeWidth', resizeWidth);
  if (resizeHeight) formData.append('resizeHeight', resizeHeight);

  for (const file of selectedFiles) formData.append('files', file);

  convertBtn.disabled = true;
  statusEl.className = 'status';
  statusEl.textContent = `Converting ${selectedFiles.length} file(s)... this can take a while for large batches.`;

  try {
    const res = await fetch('/convert', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Conversion failed');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'converted.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    statusEl.className = 'status done';
    statusEl.textContent = 'Done — zip downloaded. Check _errors.txt inside if any files failed to decode.';
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    convertBtn.disabled = selectedFiles.length === 0;
  }
});
