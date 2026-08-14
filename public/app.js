/* ══════════════════════════════════════════════════════════════
   1 SECOND EVERYDAY — Frontend Logic
   Part A: State, helpers, calendar, timeline, navigation
══════════════════════════════════════════════════════════════ */

'use strict';

// ─── Global State ───────────────────────────────────────────────
const state = {
  viewDate: new Date(),        // month currently shown
  clips: {},                   // { 'YYYY-MM-DD': clipObject }
  allClips: [],                // full list for stats/mashup
  selectedDate: null,          // date being added/edited
  trimmedBlob: null,           // the final 1-sec blob to upload
  mediaStream: null,           // camera stream
  mediaRecorder: null,
  recordedChunks: [],
  mashupBlobUrl: null,
};

// ─── Utility: date helpers ──────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function toISO(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function prettyMonth(date) {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ─── DOM shortcuts ──────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── API calls ──────────────────────────────────────────────────
async function apiGetMonth(date) {
  const res = await fetch(`/api/clips?month=${monthKey(date)}`);
  return res.ok ? res.json() : [];
}
async function apiGetAll() {
  const res = await fetch('/api/clips');
  return res.ok ? res.json() : [];
}
async function apiGetRange(start, end) {
  const res = await fetch(`/api/clips?start=${start}&end=${end}`);
  return res.ok ? res.json() : [];
}
async function apiUpload(iso, blob, caption) {
  const fd = new FormData();
  fd.append('clip_date', iso);
  fd.append('caption', caption || '');
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  fd.append('video', blob, `clip.${ext}`);
  const res = await fetch('/api/clips', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}
async function apiDelete(iso) {
  const res = await fetch(`/api/clips/${iso}`, { method: 'DELETE' });
  return res.ok;
}

// ─── Load data & refresh UI ─────────────────────────────────────
async function refreshData() {
  const [monthClips, allClips] = await Promise.all([
    apiGetMonth(state.viewDate),
    apiGetAll(),
  ]);

  state.clips = {};
  monthClips.forEach((c) => { state.clips[c.clip_date] = c; });
  state.allClips = allClips;

  renderCalendar();
  renderStats();
  renderTimeline();
}

// ─── Stats ──────────────────────────────────────────────────────
function renderStats() {
  $('#statTotal').textContent = state.allClips.length;

  const mKey = monthKey(state.viewDate);
  const thisMonth = state.allClips.filter((c) => c.clip_date.startsWith(mKey)).length;
  $('#statMonth').textContent = thisMonth;

  // Compute current streak (consecutive days ending today or yesterday)
  const dateSet = new Set(state.allClips.map((c) => c.clip_date));
  let streak = 0;
  let cursor = new Date();
  // allow streak to count if today OR yesterday has a clip
  if (!dateSet.has(toISO(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!dateSet.has(toISO(cursor))) { streak = 0; cursor = null; }
  }
  while (cursor && dateSet.has(toISO(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  $('#statStreak').textContent = streak;
}

// ─── Calendar rendering ─────────────────────────────────────────
function renderCalendar() {
  $('#monthLabel').textContent = prettyMonth(state.viewDate);

  const cal = $('#calendar');
  cal.innerHTML = '';

  const year = state.viewDate.getFullYear();
  const month = state.viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();       // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayISO = toISO(new Date());

  // leading empty slots
  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement('div');
    empty.className = 'day empty-slot';
    cal.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${pad(month + 1)}-${pad(d)}`;
    const clip = state.clips[iso];
    const isFuture = iso > todayISO;

    const cell = document.createElement('div');
    cell.className = 'day';
    if (clip) cell.classList.add('has-clip');
    if (iso === todayISO) cell.classList.add('today');
    if (isFuture) cell.classList.add('future');
    cell.dataset.date = iso;

    cell.innerHTML = `
      <span class="day-num">${d}</span>
      ${clip ? `<video class="clip-thumb" src="${clip.file_path}#t=0.1" muted playsinline preload="metadata"></video>
                <div class="day-play-overlay"><span>▶</span></div>`
             : `<div class="day-add">+</div>`}
    `;

    if (!isFuture) {
      cell.addEventListener('click', () => {
        if (clip) openPlayback(iso);
        else openCapture(iso);
      });
    }
    cal.appendChild(cell);
  }
}

// ─── Timeline rendering ─────────────────────────────────────────
function renderTimeline() {
  const tl = $('#timeline');
  tl.innerHTML = '';

  if (state.allClips.length === 0) {
    tl.innerHTML = `
      <div class="tl-empty">
        <div>🎬</div>
        <p>No clips yet. Tap a day to record your first second!</p>
      </div>`;
    return;
  }

  // newest first
  const sorted = [...state.allClips].sort((a, b) => b.clip_date.localeCompare(a.clip_date));

  sorted.forEach((clip) => {
    const item = document.createElement('div');
    item.className = 'tl-item';
    item.innerHTML = `
      <div class="tl-thumb">
        <video src="${clip.file_path}#t=0.1" muted playsinline preload="metadata"></video>
        <div class="tl-play">▶</div>
      </div>
      <div class="tl-info">
        <div class="tl-date">${prettyDate(clip.clip_date)}</div>
        <div class="tl-caption ${clip.caption ? '' : 'no-cap'}">
          ${clip.caption ? escapeHtml(clip.caption) : 'No caption'}
        </div>
      </div>`;
    item.addEventListener('click', () => openPlayback(clip.clip_date));
    tl.appendChild(item);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── View / nav switching ───────────────────────────────────────
function switchView(viewId) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === viewId));
  // Month nav only makes sense on the calendar
  $('#monthNav').style.display = viewId === 'calendarView' ? 'flex' : 'none';
}

$$('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// Month navigation
$('#prevMonth').addEventListener('click', () => {
  state.viewDate.setMonth(state.viewDate.getMonth() - 1);
  refreshData();
});
$('#nextMonth').addEventListener('click', () => {
  state.viewDate.setMonth(state.viewDate.getMonth() + 1);
  refreshData();
});
$('#todayBtn').addEventListener('click', () => {
  state.viewDate = new Date();
  switchView('calendarView');
  refreshData();
});
/* ══════════════════════════════════════════════════════════════
   Part B: Modals, camera capture, trimmer, playback, mashup
══════════════════════════════════════════════════════════════ */

// ─── Modal open/close helpers ───────────────────────────────────
function openOverlay(id) { $('#' + id).classList.add('open'); }
function closeOverlay(id) { $('#' + id).classList.remove('open'); }

// Close buttons + handle + backdrop click
$$('[data-close]').forEach((el) => {
  el.addEventListener('click', () => closeAndCleanup(el.dataset.close));
});
$$('.overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => {
    if (e.target === ov) closeAndCleanup(ov.id);
  });
});

function closeAndCleanup(id) {
  closeOverlay(id);
  if (id === 'captureOverlay') stopCamera();
  if (id === 'playOverlay') {
    const v = $('#playVideo');
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

// ─── CAPTURE MODAL ──────────────────────────────────────────────
function openCapture(iso) {
  state.selectedDate = iso;
  state.trimmedBlob = null;
  $('#captureTitle').textContent = `Add · ${prettyDate(iso)}`;
  $('#captureOptions').style.display = 'flex';
  $('#recorderWrap').style.display = 'none';
  $('#trimmerWrap').classList.remove('show');
  $('#captionInput').value = '';
  openOverlay('captureOverlay');
}

// Upload path
$('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadIntoTrimmer(file);
  e.target.value = ''; // reset so same file can be reselected
});

// Record path
$('#recordBtn').addEventListener('click', startCamera);

async function startCamera() {
  try {
    $('#captureOptions').style.display = 'none';
    $('#recorderWrap').style.display = 'block';
    $('#recHint').textContent = 'Tap to record a few seconds';

    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
      audio: true,
    });
    const live = $('#liveVideo');
    live.srcObject = state.mediaStream;
  } catch (err) {
    alert('Could not access camera: ' + err.message + '\nTry the Upload option instead.');
    $('#captureOptions').style.display = 'flex';
    $('#recorderWrap').style.display = 'none';
  }
}

function stopCamera() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    try { state.mediaRecorder.stop(); } catch (_) {}
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }
  const live = $('#liveVideo');
  if (live) live.srcObject = null;
}

// Recording toggle
$('#recToggle').addEventListener('click', () => {
  if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
    beginRecording();
  } else {
    state.mediaRecorder.stop();
  }
});

function pickMimeType() {
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function beginRecording() {
  state.recordedChunks = [];
  const mimeType = pickMimeType();
  try {
    state.mediaRecorder = new MediaRecorder(state.mediaStream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    alert('Recording not supported on this device: ' + err.message);
    return;
  }

  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
  };
  state.mediaRecorder.onstop = () => {
    const blob = new Blob(state.recordedChunks, { type: mimeType || 'video/webm' });
    stopCamera();
    $('#recorderWrap').style.display = 'none';
    loadIntoTrimmer(blob);
  };

  state.mediaRecorder.start();
  $('#recToggle').textContent = '■ Stop Recording';
  $('#recHint').textContent = 'Recording… tap to stop';
}

// ─── TRIMMER ────────────────────────────────────────────────────
let trimObjectUrl = null;

function loadIntoTrimmer(fileOrBlob) {
  if (trimObjectUrl) URL.revokeObjectURL(trimObjectUrl);
  trimObjectUrl = URL.createObjectURL(fileOrBlob);

  const preview = $('#trimPreview');
  preview.src = trimObjectUrl;
  preview._sourceBlob = fileOrBlob;

  $('#trimmerWrap').classList.add('show');
  $('#captureOptions').style.display = 'none';

  preview.onloadedmetadata = () => {
    let dur = preview.duration;
    if (!isFinite(dur) || isNaN(dur)) dur = 5; // fallback for some webm streams
    const maxStart = Math.max(0, dur - 1);
    const slider = $('#trimSlider');
    slider.max = maxStart.toFixed(1);
    slider.value = 0;
    slider.step = 0.1;
    preview.currentTime = 0;
    updateTrimTime(0);
  };

  preview.onloadeddata = () => { try { preview.currentTime = 0; } catch (_) {} };
}

$('#trimSlider').addEventListener('input', (e) => {
  const start = parseFloat(e.target.value);
  const preview = $('#trimPreview');
  preview.currentTime = start;
  updateTrimTime(start);
});

function updateTrimTime(start) {
  $('#trimTime').textContent = `${start.toFixed(1)}s → ${(start + 1).toFixed(1)}s`;
}

// ─── SAVE CLIP (trim to exactly 1 second via MediaRecorder) ─────
$('#saveClipBtn').addEventListener('click', async () => {
  const btn = $('#saveClipBtn');
  btn.disabled = true;
  btn.textContent = 'Processing…';
  try {
    const start = parseFloat($('#trimSlider').value) || 0;
    const trimmed = await trimToOneSecond($('#trimPreview')._sourceBlob, start);
    const caption = $('#captionInput').value.trim();
    await apiUpload(state.selectedDate, trimmed, caption);
    closeAndCleanup('captureOverlay');
    await refreshData();
  } catch (err) {
    alert('Failed to save clip: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save This Second';
  }
});

/**
 * Trims a video blob to exactly 1 second starting at `startTime`
 * by playing it into a canvas and re-recording via MediaRecorder.
 */
function trimToOneSecond(sourceBlob, startTime) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(sourceBlob);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      const w = video.videoWidth || 480;
      const h = video.videoHeight || 480;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');

      const stream = canvas.captureStream(30);
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        URL.revokeObjectURL(url);
        resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
      };

      video.currentTime = startTime;
      video.onseeked = () => {
        recorder.start();
        const endTime = startTime + 1;
        video.play();

        const drawFrame = () => {
          if (video.currentTime >= endTime || video.ended) {
            recorder.stop();
            video.pause();
            return;
          }
          ctx.drawImage(video, 0, 0, w, h);
          requestAnimationFrame(drawFrame);
        };
        drawFrame();

        // Safety stop after 1.3s
        setTimeout(() => {
          if (recorder.state !== 'inactive') recorder.stop();
        }, 1300);
      };
    };

    video.onerror = () => reject(new Error('Could not process video'));
  });
}

// ─── PLAYBACK MODAL ─────────────────────────────────────────────
function openPlayback(iso) {
  const clip = state.clips[iso] || state.allClips.find((c) => c.clip_date === iso);
  if (!clip) return;

  state.selectedDate = iso;
  $('#playDate').textContent = prettyDate(iso);
  $('#playCaption').textContent = clip.caption || '';
  const v = $('#playVideo');
  v.src = clip.file_path;
  v.load();
  openOverlay('playOverlay');
}

$('#deleteClipBtn').addEventListener('click', async () => {
  if (!confirm('Delete this clip? This cannot be undone.')) return;
  await apiDelete(state.selectedDate);
  closeAndCleanup('playOverlay');
  await refreshData();
});

$('#replaceClipBtn').addEventListener('click', () => {
  const iso = state.selectedDate;
  closeAndCleanup('playOverlay');
  openCapture(iso);
});

// ─── MASHUP GENERATOR ───────────────────────────────────────────
let selectedRange = { type: '30' };

$('#rangePresets').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-btn');
  if (!btn) return;
  $$('.range-btn').forEach((b) => b.classList.remove('sel'));
  btn.classList.add('sel');
  selectedRange = { type: btn.dataset.range };
  $('#customRange').style.display = btn.dataset.range === 'custom' ? 'flex' : 'none';
});

function resolveRange() {
  const today = new Date();
  const end = toISO(today);
  if (selectedRange.type === 'custom') {
    return { start: $('#rangeStart').value, end: $('#rangeEnd').value };
  }
  if (selectedRange.type === 'all') return { start: '0000-01-01', end };
  if (selectedRange.type === 'year') return { start: `${today.getFullYear()}-01-01`, end };
    const days = parseInt(selectedRange.type, 10);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  return { start: toISO(startDate), end };
}

// Generate the mashup by playing each clip into a shared canvas and recording
$('#generateBtn').addEventListener('click', async () => {
  const btn = $('#generateBtn');
  const { start, end } = resolveRange();

  if (!start || !end) {
    alert('Please choose a valid date range.');
    return;
  }

  btn.disabled = true;
  const clips = await apiGetRange(start, end);

  if (!clips.length) {
    alert('No clips found in that range.');
    btn.disabled = false;
    return;
  }

  // Sort chronologically
  clips.sort((a, b) => a.clip_date.localeCompare(b.clip_date));

  // Show progress UI
  $('#mashupProgress').classList.add('show');
  $('#mashupResult').classList.remove('show');
  setProgress(0, 'Preparing…');

  try {
    const blob = await buildMashup(clips);
    if (state.mashupBlobUrl) URL.revokeObjectURL(state.mashupBlobUrl);
    state.mashupBlobUrl = URL.createObjectURL(blob);

    $('#mashupVideo').src = state.mashupBlobUrl;
    $('#mashupProgress').classList.remove('show');
    $('#mashupResult').classList.add('show');
  } catch (err) {
    alert('Mashup failed: ' + err.message);
    $('#mashupProgress').classList.remove('show');
  } finally {
    btn.disabled = false;
  }
});

function setProgress(pct, label) {
  $('#progBar').style.width = pct + '%';
  $('#progLabel').textContent = label;
}

/**
 * Plays each 1-second clip sequentially onto a canvas and records
 * the canvas + audio into a single continuous video.
 */
function buildMashup(clips) {
  return new Promise((resolve, reject) => {
    const W = 480, H = 480;
    const canvas = $('#mashupCanvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Fill black initially
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const canvasStream = canvas.captureStream(30);

    // Set up audio mixing via a single AudioContext destination
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    const audioDest = audioCtx.createMediaStreamDestination();

    // Combine canvas video track + mixed audio track
    const mixedStream = new MediaStream();
    canvasStream.getVideoTracks().forEach((t) => mixedStream.addTrack(t));
    audioDest.stream.getAudioTracks().forEach((t) => mixedStream.addTrack(t));

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      audioCtx.close();
      resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    };

    recorder.start();

    let index = 0;

    // Draw a text label (date) over the frame
    function drawLabel(dateISO) {
      ctx.font = 'bold 22px -apple-system, sans-serif';
      ctx.textBaseline = 'bottom';
      const text = prettyLabelDate(dateISO);
      const tw = ctx.measureText(text).width;
      // shadow strip
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, H - 44, tw + 32, 44);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, 16, H - 12);
    }

    function playNext() {
      if (index >= clips.length) {
        // small delay to flush last frames
        setTimeout(() => {
          if (recorder.state !== 'inactive') recorder.stop();
        }, 200);
        return;
      }

      const clip = clips[index];
      const pct = Math.round((index / clips.length) * 100);
      setProgress(pct, `Stitching ${index + 1} / ${clips.length}…`);

      const video = document.createElement('video');
      video.src = clip.file_path;
      video.crossOrigin = 'anonymous';
      video.muted = false;
      video.playsInline = true;

      video.onloadeddata = () => {
        // Route this clip's audio into the mixed destination
        try {
          const srcNode = audioCtx.createMediaElementSource(video);
          srcNode.connect(audioDest);
        } catch (_) { /* some clips may have no audio */ }

        video.play().catch(() => {});

        const draw = () => {
          if (video.ended || video.currentTime >= 1.05) {
            index++;
            playNext();
            return;
          }
          // letterbox draw (cover)
          const vw = video.videoWidth || W;
          const vh = video.videoHeight || H;
          const scale = Math.max(W / vw, H / vh);
          const dw = vw * scale, dh = vh * scale;
          const dx = (W - dw) / 2, dy = (H - dh) / 2;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);
          ctx.drawImage(video, dx, dy, dw, dh);
          drawLabel(clip.clip_date);
          requestAnimationFrame(draw);
        };
        draw();
      };

      video.onerror = () => { index++; playNext(); };

      // Safety timeout per clip (1.5s max)
      setTimeout(() => {
        if (!video.ended && index < clips.length && clips[index] === clip) {
          // move on if a clip stalls
        }
      }, 1500);
    }

    playNext();
  });
}

function prettyLabelDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Download mashup
$('#downloadMashup').addEventListener('click', () => {
  if (!state.mashupBlobUrl) return;
  const a = document.createElement('a');
  a.href = state.mashupBlobUrl;
  a.download = `mashup_${toISO(new Date())}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// Close mashup result
$('#closeMashup').addEventListener('click', () => {
  $('#mashupResult').classList.remove('show');
  const v = $('#mashupVideo');
  v.pause();
});

// ─── INIT ───────────────────────────────────────────────────────
switchView('calendarView');
refreshData();