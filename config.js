// config.js
// GitHub Pages only serves static files, so the Node.js signaling server
// (server.js) must be deployed elsewhere (Render, Railway, Fly.io, etc.).
// After deploying it, put its HTTPS URL here. Both camera.html and
// operator.html load this file before camera.js / operator.js.

const SIGNALING_SERVER_URL = 'https://your-signaling-server.onrender.com';
