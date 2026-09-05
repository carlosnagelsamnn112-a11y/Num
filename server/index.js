const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 3001;

// ─── Game state ─────────────────────────────────────────────────
const rooms = {};

function generateRoomId() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  let id;
  do {
    id = letters[Math.floor(Math.random() * 26)]
       + letters[Math.floor(Math.random() * 26)]
       + digits[Math.floor(Math.random() * 10)]
       + digits[Math.floor(Math.random() * 10)];
  } while (rooms[id]);
  return id;
}

function generateNumbers(count, digits) {
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  const nums = [];
  while (nums.length < count) {
    const n = Math.floor(Math.random() * (max - min + 1)) + min;
    if (!nums.includes(n)) nums.push(n);
  }
  return nums;
}

function getRoom(roomId) {
  return rooms[roomId] || null;
}

function getPlayerRoom(socketId) {
  for (const [id, room] of Object.entries(rooms)) {
    if (room.players.find(p => p.id === socketId)) return { roomId: id, room };
  }
  return null;
}

function cleanUpRoom(roomId) {
  const room = rooms[roomId];
  if (room && room.players.length === 0) delete rooms[roomId];
}

function initGame(room) {
  const count = room.players.length;
  const numbers = generateNumbers(count, room.config.digits);
  room.game = {
    state: 'playing',
    numbers: {},
    attemptsLeft: {},
    currentRound: (room.game?.currentRound || 0) + 1,
    roundResults: {},
    roundWinner: null,
    roundOverEmitted: false,
  };
  room.players.forEach((p, i) => {
    room.game.numbers[p.id] = numbers[i];
    room.game.attemptsLeft[p.id] = 3;
    room.game.roundResults[p.id] = null;
  });
}

function emitRoomState(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const playerData = room.players.map(p => ({
    id: p.id, name: p.name, score: p.score, connected: p.connected,
  }));
  io.to(roomId).emit('room:state', {
    roomId,
    config: room.config,
    players: playerData,
    gameState: room.game?.state || 'waiting',
  });
}

function endRound(roomId, winnerId) {
  const room = getRoom(roomId);
  if (!room || room.game?.roundOverEmitted) return;
  room.game.roundOverEmitted = true;
  if (winnerId) {
    const wp = room.players.find(p => p.id === winnerId);
    if (wp) wp.score += 1;
    room.game.roundWinner = winnerId;
  }
  const results = {};
  room.players.forEach(p => {
    results[p.id] = room.game.roundResults[p.id] || 'loss';
  });
  const maxScore = Math.max(...room.players.map(p => p.score));
  const gameOver = maxScore >= 3;
  if (gameOver) room.game.state = 'gameover';
  const numbersMap = {};
  room.players.forEach(p => { numbersMap[p.id] = room.game.numbers[p.id]; });
  io.to(roomId).emit('round:over', {
    results,
    winnerId: winnerId || null,
    scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    gameOver,
    numbers: numbersMap,
  });
  if (gameOver) {
    const finalWinner = room.players.reduce((a, b) => a.score > b.score ? a : b);
    io.to(roomId).emit('game:over', {
      winner: { id: finalWinner.id, name: finalWinner.name, score: finalWinner.score },
      scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    });
  }
}

// ─── Socket handlers ────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Connected: ${socket.id}`);

  socket.on('room:create', ({ username, digits }) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      config: { digits: digits || 3 },
      players: [{ id: socket.id, name: username, score: 0, connected: true }],
      game: { state: 'waiting' },
    };
    socket.join(roomId);
    socket.data = { roomId, playerId: socket.id };
    socket.emit('room:created', {
      roomId,
      config: rooms[roomId].config,
      players: rooms[roomId].players.map(p => ({
        id: p.id, name: p.name, score: p.score, connected: p.connected,
      })),
      playerId: socket.id,
    });
  });

  socket.on('room:join', ({ roomId, username }) => {
    const room = getRoom(roomId);
    if (!room) return socket.emit('room:error', { message: 'Sala no encontrada' });
    if (room.game?.state === 'playing') {
      return socket.emit('room:error', { message: 'La partida ya está en curso' });
    }
    if (room.players.length >= 8) {
      return socket.emit('room:error', { message: 'La sala está llena (máx. 8)' });
    }
    if (room.players.find(p => p.name.toLowerCase() === username.toLowerCase())) {
      return socket.emit('room:error', { message: 'Ese nombre de usuario ya está en uso' });
    }
    room.players.push({ id: socket.id, name: username, score: 0, connected: true });
    socket.join(roomId);
    socket.data = { roomId, playerId: socket.id };
    socket.emit('room:joined', {
      roomId,
      config: room.config,
      players: room.players.map(p => ({
        id: p.id, name: p.name, score: p.score, connected: p.connected,
      })),
      playerId: socket.id,
    });
    emitRoomState(roomId);
  });

  socket.on('game:start', () => {
    const info = getPlayerRoom(socket.id);
    if (!info) return;
    const { roomId, room } = info;
    if (room.players.length < 2) return;
    if (room.game?.state === 'playing') return;
    room.game = { state: 'countdown' };
    io.to(roomId).emit('game:countdown');
    setTimeout(() => {
      initGame(room);
      room.players.forEach(p => {
        const nums = {};
        room.players.forEach(op => {
          if (op.id !== p.id) nums[op.id] = { name: op.name, number: room.game.numbers[op.id] };
        });
        io.to(p.id).emit('game:start', {
          numbers: nums,
          attemptsLeft: 3,
          round: room.game.currentRound,
          scores: room.players.map(pl => ({ id: pl.id, name: pl.name, score: pl.score })),
        });
      });
    }, 3500);
  });

  socket.on('game:guess', ({ guess }) => {
    const info = getPlayerRoom(socket.id);
    if (!info) return;
    const { roomId, room } = info;
    if (!room.game || room.game.state !== 'playing') return;
    const attempts = room.game.attemptsLeft[socket.id];
    if (attempts === undefined || attempts <= 0) return;
    room.game.attemptsLeft[socket.id] -= 1;
    const correct = guess === room.game.numbers[socket.id];
    if (correct) {
      room.game.roundResults[socket.id] = 'win';
      io.to(socket.id).emit('guess:correct', {
        number: room.game.numbers[socket.id],
        attemptsLeft: room.game.attemptsLeft[socket.id],
      });
      endRound(roomId, socket.id);
    } else {
      const remaining = room.game.attemptsLeft[socket.id];
      io.to(socket.id).emit('guess:wrong', {
        attemptsLeft: remaining,
        message: remaining === 0 ? '¡Sin intentos restantes!' : '¡Número incorrecto!',
      });
      if (remaining === 0) {
        room.game.roundResults[socket.id] = 'loss';
        const allDone = room.players.every(p =>
          p.id === socket.id
            || room.game.roundResults[p.id] !== null
            || room.game.attemptsLeft[p.id] <= 0
            || !p.connected
        );
        const anyWin = Object.values(room.game.roundResults).some(r => r === 'win');
        if (allDone && !anyWin) endRound(roomId, null);
      }
    }
  });

  socket.on('game:next_round', () => {
    const info = getPlayerRoom(socket.id);
    if (!info) return;
    const { roomId, room } = info;
    if (!room.game || room.game.state !== 'gameover') return;
    const maxScore = Math.max(...room.players.filter(p => p.connected).map(p => p.score));
    if (maxScore >= 3) return;
    const count = room.players.filter(p => p.connected).length;
    const numbers = generateNumbers(count, room.config.digits);
    const active = room.players.filter(p => p.connected);
    room.game = {
      state: 'playing',
      numbers: {},
      attemptsLeft: {},
      currentRound: (room.game?.currentRound || 0) + 1,
      roundResults: {},
      roundWinner: null,
      roundOverEmitted: false,
    };
    active.forEach((p, i) => {
      room.game.numbers[p.id] = numbers[i];
      room.game.attemptsLeft[p.id] = 3;
      room.game.roundResults[p.id] = null;
    });
    active.forEach(p => {
      const nums = {};
      active.forEach(op => {
        if (op.id !== p.id) nums[op.id] = { name: op.name, number: room.game.numbers[op.id] };
      });
      io.to(p.id).emit('game:start', {
        numbers: nums,
        attemptsLeft: 3,
        round: room.game.currentRound,
        scores: room.players.map(pl => ({ id: pl.id, name: pl.name, score: pl.score })),
      });
    });
  });

  socket.on('game:reset', () => {
    const info = getPlayerRoom(socket.id);
    if (!info) return;
    const { roomId, room } = info;
    room.players.forEach(p => { p.score = 0; });
    room.game = { state: 'waiting' };
    emitRoomState(roomId);
  });

  socket.on('room:leave', () => {
    handleDisconnect(socket);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });

  function handleDisconnect(s) {
    const info = getPlayerRoom(s.id);
    if (!info) return;
    const { roomId, room } = info;
    const player = room.players.find(p => p.id === s.id);
    if (room.game?.state === 'playing' || room.game?.state === 'gameover') {
      if (player) player.connected = false;
      const active = room.players.filter(p => p.connected);
      if (active.length < 2) {
        io.to(roomId).emit('game:cancelled', { message: 'Partida interrumpida, no hay suficientes jugadores' });
        room.players.forEach(p => { p.score = 0; });
        room.game = { state: 'waiting' };
      }
      emitRoomState(roomId);
    } else {
      room.players = room.players.filter(p => p.id !== s.id);
      emitRoomState(roomId);
    }
    s.leave(roomId);
    s.data = {};
    cleanUpRoom(roomId);
  }
});

// ─── Static frontend (built by client command) ─────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, rooms: Object.keys(rooms).length });
});

const distPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

server.listen(PORT, () => {
  console.log(`NUM server running on port ${PORT}`);
});
