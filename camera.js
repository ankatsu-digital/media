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
const cameraSelect = document.getElementById('cameraSelect');

async function listCameras(selectedDeviceId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  console.log('[camera] enumerateDevices videoinputs:', videoInputs);

  cameraSelect.innerHTML = '';

  if (videoInputs.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'カメラが見つかりません';
    cameraSelect.appendChild(opt);
    return;
  }

  videoInputs.forEach((device, i) => {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    // Labels are only populated once permission has been granted.
    opt.textContent = device.label || `カメラ ${i + 1}`;
    if (device.deviceId === selectedDeviceId) opt.selected = true;
    cameraSelect.appendChild(opt);
  });
}

async function openCamera(deviceId) {
  // Stop whatever we had before switching.
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  const videoConstraint = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: 'environment' }; // sensible default: back camera on phones

  localStream = await navigator.mediaDevices.getUserMedia({
    video: { ...videoConstraint, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true
  });
  localVideo.srcObject = localStream;

  // Swap the live track into every peer connection already sending to the operator,
  // so switching cameras mid-shoot doesn't require reconnecting.
  const newVideoTrack = localStream.getVideoTracks()[0];
  const newAudioTrack = localStream.getAudioTracks()[0];
  peerConnections.forEach((pc) => {
    pc.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === 'video' && newVideoTrack) {
        sender.replaceTrack(newVideoTrack);
      } else if (sender.track && sender.track.kind === 'audio' && newAudioTrack) {
        sender.replaceTrack(newAudioTrack);
      }
    });
  });

  // Now that permission is granted, device labels become available — refresh the list.
  const activeId = localStream.getVideoTracks()[0]?.getSettings().deviceId;
  await listCameras(activeId);
}

cameraSelect.addEventListener('change', () => {
  openCamera(cameraSelect.value).catch((err) => {
    alert('カメラの切り替えに失敗しました: ' + err.message);
  });
});

navigator.mediaDevices.addEventListener?.('devicechange', () => {
  const activeId = localStream?.getVideoTracks()[0]?.getSettings().deviceId;
  listCameras(activeId).catch(() => {});
});

async function start() {
  try {
    await openCamera(); // default camera first (back camera on phones)
  } catch (err) {
    console.error('[camera] getUserMedia failed:', err);
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
