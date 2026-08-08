// camera.js — runs on each smartphone.
// 1. Gets the device camera/mic via getUserMedia
// 2. Joins the signaling room as role "camera"
// 3. When the operator requests it, creates an RTCPeerConnection and sends
//    an offer carrying the live video/audio track
// 4. Shows an "ON AIR" badge whenever the operator has switched to this camera
// 5. Keeps a synced timecode on screen using the server clock

const params = new URLSearchParams(window.location.search);
const roomId = params.get('room') || 'default';
const camName = params.get('name') || 'Camera';

// A short random id lets multiple cameras in the same room be told apart
// even if two people typed the same name.
const cameraId = camName + '-' + Math.random().toString(36).slice(2, 6);

document.getElementById('camTitle').textContent = camName || 'CAMERA';
document.getElementById('camLabel').textContent = camName;

const socket = io(SIGNALING_SERVER_URL);
const localVideo = document.getElementById('localVideo');
const statusDot = document.getElementById('statusDot');
const onAirBadge = document.getElementById('onAirBadge');
const timecodeEl = document.getElementById('timecode');

// STUN/TURN config. For shooting across different internet connections
// (not the same Wi-Fi), a TURN server is required for reliable connectivity
// through most home/mobile NATs — see README for how to configure one.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Example TURN entry (fill in your own TURN server, see README):
  // { urls: 'turn:your-turn-server:3478', username: 'user', credential: 'pass' }
];

let localStream = null;
const peerConnections = new Map(); // operatorSocketId -> RTCPeerConnection

async function start() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
    localVideo.srcObject = localStream;
  } catch (err) {
    alert('カメラ/マイクへのアクセスが必要です: ' + err.message);
    return;
  }

  socket.emit('join', { roomId, role: 'camera', cameraId, name: camName });
  statusDot.classList.add('connected');
}

async function createOfferTo(operatorSocketId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(operatorSocketId, pc);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { to: operatorSocketId, data: { kind: 'ice', candidate: e.candidate } });
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: operatorSocketId, data: { kind: 'offer', sdp: offer, cameraId, name: camName } });
}

socket.on('request-offer', ({ from }) => {
  createOfferTo(from);
});

socket.on('signal', async ({ from, data }) => {
  const pc = peerConnections.get(from);
  if (!pc) return;
  if (data.kind === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.kind === 'ice' && data.candidate) {
    try { await pc.addIceCandidate(data.candidate); } catch (e) { /* ignore */ }
  }
});

// Operator broadcasts which camera is currently "on air"
socket.on('switched', ({ cameraId: liveCameraId }) => {
  onAirBadge.classList.toggle('show', liveCameraId === cameraId);
});

// --- Timecode sync ---
let serverOffsetMs = 0;
socket.on('server-time', (serverNow) => {
  serverOffsetMs = serverNow - Date.now();
});

function formatTimecode(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  const f = String(Math.floor((ms % 1000) / (1000 / 30))).padStart(2, '0'); // 30fps frame count
  return `${h}:${m}:${s}:${f}`;
}

setInterval(() => {
  const synced = Date.now() + serverOffsetMs;
  timecodeEl.textContent = formatTimecode(synced);
}, 33);

start();
