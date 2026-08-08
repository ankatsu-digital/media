// server.js
// Signaling server for the multi-camera live switcher.
// Responsibilities:
//   1. Serve the static client (public/)
//   2. Let clients join a "room" as either role: "camera" (with a camera number)
//      or "operator" (the PC/browser doing the switching).
//   3. Relay WebRTC SDP offers/answers and ICE candidates between a camera and
//      the operator (server never touches media, only signaling messages).
//   4. Broadcast a shared server clock so every client can compute a synced
//      timecode, and relay REC START/STOP + "switch to camera N" events so
//      everyone agrees on what happened and when.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(__dirname));

// rooms[roomId] = { cameras: Map<socketId, {cameraId, name}>, operatorId: string|null }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { cameras: new Map(), operatorId: null };
  }
  return rooms[roomId];
}

function cameraList(room) {
  return Array.from(room.cameras.entries()).map(([socketId, info]) => ({
    socketId,
    cameraId: info.cameraId,
    name: info.name
  }));
}

io.on('connection', (socket) => {
  let joinedRoom = null;
  let role = null;

  // --- Broadcast server clock every second for timecode sync ---
  const clockInterval = setInterval(() => {
    socket.emit('server-time', Date.now());
  }, 1000);

  socket.on('join', ({ roomId, role: joinRole, cameraId, name }) => {
    joinedRoom = roomId;
    role = joinRole;
    const room = getRoom(roomId);
    socket.join(roomId);

    if (joinRole === 'camera') {
      room.cameras.set(socket.id, { cameraId, name: name || `Camera ${cameraId}` });
      // Tell the operator (if present) a new camera showed up
      if (room.operatorId) {
        io.to(room.operatorId).emit('camera-joined', {
          socketId: socket.id,
          cameraId,
          name: name || `Camera ${cameraId}`
        });
      }
    } else if (joinRole === 'operator') {
      room.operatorId = socket.id;
      // Send the operator the current list of connected cameras
      socket.emit('camera-list', cameraList(room));
    }
  });

  // --- WebRTC signaling relay (offer/answer/ice) ---
  // payload: { to: socketId, data: <sdp or ice candidate> }
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Operator asks a specific camera to (re)initiate a WebRTC offer.
  // Used right after the operator learns a camera exists (either already
  // in the room, or one that just joined).
  socket.on('request-offer', ({ to }) => {
    io.to(to).emit('request-offer', { from: socket.id });
  });

  // --- Switcher control: operator tells everyone which camera is "on air" ---
  socket.on('switch-camera', ({ roomId, cameraSocketId, cameraId }) => {
    io.to(roomId).emit('switched', { cameraSocketId, cameraId, at: Date.now() });
  });

  // --- Recording state broadcast (so camera UIs can show REC indicator too) ---
  socket.on('rec-state', ({ roomId, recording }) => {
    io.to(roomId).emit('rec-state', { recording, at: Date.now() });
  });

  socket.on('disconnect', () => {
    clearInterval(clockInterval);
    if (!joinedRoom) return;
    const room = rooms[joinedRoom];
    if (!room) return;

    if (role === 'camera') {
      room.cameras.delete(socket.id);
      if (room.operatorId) {
        io.to(room.operatorId).emit('camera-left', { socketId: socket.id });
      }
    } else if (role === 'operator' && room.operatorId === socket.id) {
      room.operatorId = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Multicam switcher signaling server running on port ${PORT}`);
});
