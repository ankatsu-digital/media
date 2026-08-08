// operator.js — runs on the PC/browser that acts as the vision switcher.
// 1. Joins the room as role "operator"
// 2. For every camera in the room, requests a WebRTC offer and answers it,
//    receiving that camera's live video+audio track
// 3. Renders every camera as a clickable tile; clicking makes it "live"
// 4. Continuously draws the live camera's video frames onto a canvas (the
//    "program" output) and routes the live camera's audio through a shared
//    Web Audio graph, so both video and audio cut cleanly on switch
// 5. MediaRecorder records that canvas+audio program stream; stopping saves
//    a single .webm file containing exactly what was switched, live

const params = new URLSearchParams(window.location.search);
const roomId = params.get('room') || 'default';
document.getElementById('roomLabel').textContent = roomId;
document.getElementById('roomInfo').textContent = roomId;

const socket = io(SIGNALING_SERVER_URL);
const grid = document.getElementById('grid');
const emptyHint = document.getElementById('emptyHint');
const camCountEl = document.getElementById('camCount');
const liveInfoEl = document.getElementById('liveInfo');
const logEl = document.getElementById('log');
const recBtn = document.getElementById('recBtn');
const timecodeEl = document.getElementById('timecode');
const pgmCanvas = document.getElementById('pgmCanvas');
const ctx = pgmCanvas.getContext('2d');

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' }
  // Add your TURN server here too — see README.
];

function log(msg) {
  const div = document.createElement('div');
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(div);
}

// cameras: socketId -> { cameraId, name, pc, videoEl, tileEl, audioSourceNode, gainNode }
const cameras = new Map();
let liveSocketId = null;

socket.emit('join', { roomId, role: 'operator' });

socket.on('camera-list', (list) => {
  list.forEach((cam) => addCameraTile(cam.socketId, cam.cameraId, cam.name));
  list.forEach((cam) => socket.emit('request-offer', { to: cam.socketId }));
});

socket.on('camera-joined', (cam) => {
  addCameraTile(cam.socketId, cam.cameraId, cam.name);
  socket.emit('request-offer', { to: cam.socketId });
  log(`${cam.name} が接続しました`);
});

socket.on('camera-left', ({ socketId }) => {
  const cam = cameras.get(socketId);
  if (!cam) return;
  cam.tileEl.remove();
  if (cam.pc) cam.pc.close();
  cameras.delete(socketId);
  if (liveSocketId === socketId) liveSocketId = null;
  updateCounts();
  log(`カメラが切断されました`);
});

function addCameraTile(socketId, cameraId, name) {
  if (cameras.has(socketId)) return;

  const tile = document.createElement('div');
  tile.className = 'cam-tile';
  tile.innerHTML = `
    <video autoplay playsinline muted></video>
    <div class="tile-live-tag">● LIVE</div>
    <div class="tile-label">${name}</div>
  `;
  const videoEl = tile.querySelector('video');
  tile.onclick = () => switchTo(socketId);
  grid.appendChild(tile);
  emptyHint.style.display = 'none';

  cameras.set(socketId, { cameraId, name, pc: null, videoEl, tileEl: tile, gainNode: null, sourceNode: null });
  updateCounts();
}

function updateCounts() {
  camCountEl.textContent = cameras.size;
  emptyHint.style.display = cameras.size === 0 ? 'block' : 'none';
}

// --- WebRTC: answer offers coming from cameras ---
socket.on('signal', async ({ from, data }) => {
  let cam = cameras.get(from);

  if (data.kind === 'offer') {
    if (!cam) {
      addCameraTile(from, data.cameraId, data.name);
      cam = cameras.get(from);
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    cam.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('signal', { to: from, data: { kind: 'ice', candidate: e.candidate } });
    };

    pc.ontrack = (e) => {
      cam.videoEl.srcObject = e.streams[0];
      attachAudioGraph(cam, e.streams[0]);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { kind: 'answer', sdp: answer } });
  } else if (data.kind === 'ice' && data.candidate && cam?.pc) {
    try { await cam.pc.addIceCandidate(data.candidate); } catch (e) { /* ignore */ }
  }
});

// --- Shared Web Audio graph: only the live camera's gain is opened ---
let audioCtx = null;
let destinationNode = null;

function ensureAudioGraph() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    destinationNode = audioCtx.createMediaStreamDestination();
  }
}

function attachAudioGraph(cam, stream) {
  ensureAudioGraph();
  if (stream.getAudioTracks().length === 0) return;
  const source = audioCtx.createMediaStreamSource(stream);
  const gain = audioCtx.createGain();
  gain.gain.value = 0; // muted until this camera goes live
  source.connect(gain).connect(destinationNode);
  cam.sourceNode = source;
  cam.gainNode = gain;
}

// --- Switching ---
function switchTo(socketId) {
  if (!cameras.has(socketId)) return;
  liveSocketId = socketId;

  cameras.forEach((cam, id) => {
    cam.tileEl.classList.toggle('live', id === socketId);
    if (cam.gainNode) cam.gainNode.gain.value = id === socketId ? 1 : 0;
  });

  const cam = cameras.get(socketId);
  liveInfoEl.textContent = cam.name;
  socket.emit('switch-camera', { roomId, cameraSocketId: socketId, cameraId: cam.cameraId });
  log(`ON AIR → ${cam.name}`);
}

// --- Draw the live feed onto the program canvas every frame ---
function drawLoop() {
  if (liveSocketId && cameras.has(liveSocketId)) {
    const cam = cameras.get(liveSocketId);
    if (cam.videoEl.readyState >= 2) {
      ctx.drawImage(cam.videoEl, 0, 0, pgmCanvas.width, pgmCanvas.height);
    }
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, pgmCanvas.width, pgmCanvas.height);
    ctx.fillStyle = '#555';
    ctx.font = '28px sans-serif';
    ctx.fillText('カメラを選択してください', 40, pgmCanvas.height / 2);
  }
  requestAnimationFrame(drawLoop);
}
requestAnimationFrame(drawLoop);

// --- Recording the program output ---
let mediaRecorder = null;
let recordedChunks = [];
let recording = false;

recBtn.onclick = () => {
  if (!recording) startRecording();
  else stopRecording();
};

function startRecording() {
  ensureAudioGraph();
  const canvasStream = pgmCanvas.captureStream(30);
  const audioTrack = destinationNode.stream.getAudioTracks()[0];
  const combined = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...(audioTrack ? [audioTrack] : [])
  ]);

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(combined, { mimeType: 'video/webm;codecs=vp9,opus' });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = saveRecording;
  mediaRecorder.start(1000);

  recording = true;
  recBtn.textContent = '■ 録画停止';
  recBtn.classList.add('recording');
  socket.emit('rec-state', { roomId, recording: true });
  log('録画開始');
}

function stopRecording() {
  if (mediaRecorder) mediaRecorder.stop();
  recording = false;
  recBtn.textContent = '● 録画開始';
  recBtn.classList.remove('recording');
  socket.emit('rec-state', { roomId, recording: false });
  log('録画停止');
}

function saveRecording() {
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `switched-${roomId}-${stamp}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  log(`保存しました: ${a.download}`);
}

// --- Timecode sync (same server clock the cameras use) ---
let serverOffsetMs = 0;
socket.on('server-time', (serverNow) => { serverOffsetMs = serverNow - Date.now(); });

function formatTimecode(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  const f = String(Math.floor((ms % 1000) / (1000 / 30))).padStart(2, '0');
  return `${h}:${m}:${s}:${f}`;
}
setInterval(() => {
  timecodeEl.textContent = formatTimecode(Date.now() + serverOffsetMs);
}, 33);
