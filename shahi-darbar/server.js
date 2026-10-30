const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Authoritative Game Rooms
const rooms = new Map();
const BOT_NAMES = ["Birbal", "Tansen", "Maan Singh", "Bhairav", "Mangal"];

function fisherYatesShuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

io.on('connection', (socket) => {
  // CREATE ROOM
  socket.on('CREATE_ROOM', ({ playerName }) => {
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      hostId: socket.id,
      phase: 'LOBBY',
      round: 1,
      players: [
        { id: socket.id, name: playerName || "Host", isBot: false, score: 0 }
      ],
      roles: {}, // socket.id -> role (Private)
      roundCompleted: false
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.emit('ROOM_CREATED', { roomCode, isHost: true });
    io.to(roomCode).emit('LOBBY_UPDATE', { 
      players: room.players, 
      hostId: room.hostId 
    });
  });

  // JOIN ROOM
  socket.on('JOIN_ROOM', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      return socket.emit('ERROR_MSG', 'Galat Room Code! Room exist nahi karta.');
    }
    if (room.phase !== 'LOBBY') {
      return socket.emit('ERROR_MSG', 'Khel shuru ho chuka hai!');
    }
    if (room.players.length >= 5) {
      return socket.emit('ERROR_MSG', 'Room full hai (Max 5 players)!');
    }

    room.players.push({
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      isBot: false,
      score: 0
    });

    socket.join(code);
    socket.emit('JOIN_SUCCESS', { roomCode: code, isHost: false });
    io.to(code).emit('LOBBY_UPDATE', { 
      players: room.players, 
      hostId: room.hostId 
    });
  });

  // ADD BOT
  socket.on('ADD_BOT', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.players.length >= 5) return;

    const botCount = room.players.filter(p => p.isBot).length;
    const botName = `${BOT_NAMES[botCount % BOT_NAMES.length]} (Bot)`;
    const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;

    room.players.push({ id: botId, name: botName, isBot: true, score: 0 });
    io.to(roomCode).emit('LOBBY_UPDATE', { players: room.players, hostId: room.hostId });
  });

  // AUTO-FILL BOTS
  socket.on('AUTO_FILL_BOTS', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;

    while (room.players.length < 5) {
      const botCount = room.players.filter(p => p.isBot).length;
      const botName = `${BOT_NAMES[botCount % BOT_NAMES.length]} (Bot)`;
      const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      room.players.push({ id: botId, name: botName, isBot: true, score: 0 });
    }
    io.to(roomCode).emit('LOBBY_UPDATE', { players: room.players, hostId: room.hostId });
  });

  // START ROUND (SECURE ROLE DISPATCH)
  socket.on('START_ROUND', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.players.length !== 5) return;

    room.phase = 'PARCHI';
    room.roundCompleted = false;
    room.roles = {};

    const chits = fisherYatesShuffle(["Raja", "Mantri", "Sipahi", "Daku", "Chor"]);
    room.players.forEach((player, idx) => {
      room.roles[player.id] = chits[idx];
    });

    // 1. Har individual socket ko sirf uska private role bhejte hain
    room.players.forEach((player) => {
      if (!player.isBot) {
        io.to(player.id).emit('PRIVATE_ROLE', {
          role: room.roles[player.id],
          round: room.round
        });
      }
    });

    // 2. Public announcement (Roles hidden)
    io.to(roomCode).emit('ROUND_STARTED', { round: room.round });
  });

  // OPEN DARBAR (COURT PHASE)
  socket.on('OPEN_DARBAR', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'COURT';

    // Darbar identities find karna
    const raja = room.players.find(p => room.roles[p.id] === 'Raja');
    const mantri = room.players.find(p => room.roles[p.id] === 'Mantri');
    const sipahi = room.players.find(p => room.roles[p.id] === 'Sipahi');

    // Suspects: Chor aur Daku (Identity hidden, sirf naam/id public)
    const suspects = room.players
      .filter(p => room.roles[p.id] === 'Chor' || room.roles[p.id] === 'Daku')
      .map(p => ({ id: p.id, name: p.name }));

    io.to(roomCode).emit('COURT_OPENED', {
      raja: { id: raja.id, name: raja.name },
      mantri: { id: mantri.id, name: mantri.name },
      sipahi: { id: sipahi.id, name: sipahi.name, isBot: sipahi.isBot },
      suspects: fisherYatesShuffle(suspects)
    });

    // Agar Sipahi BOT hai to server autonomously decision lega
    if (sipahi.isBot) {
      setTimeout(() => {
        if (!room.roundCompleted && room.phase === 'COURT') {
          // Medium difficulty AI: 60% chance to catch Daku
          const dakuPlayer = room.players.find(p => room.roles[p.id] === 'Daku');
          const chorPlayer = room.players.find(p => room.roles[p.id] === 'Chor');
          const pickDaku = Math.random() < 0.65;
          const chosenId = pickDaku ? dakuPlayer.id : chorPlayer.id;
          resolveVerdict(room, chosenId);
        }
      }, 3500);
    }
  });

  // SIPAHI ACTION (GUESS DAKU)
  socket.on('SIPAHI_GUESS', ({ roomCode, suspectId }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'COURT' || room.roundCompleted) return;

    const sipahi = room.players.find(p => room.roles[p.id] === 'Sipahi');
    if (socket.id !== sipahi.id) return; // Sirf Sipahi choose kar sakta hai

    resolveVerdict(room, suspectId);
  });

  function resolveVerdict(room, suspectId) {
    if (room.roundCompleted) return;
    room.roundCompleted = true;
    room.phase = 'VERDICT';

    const sipahi = room.players.find(p => room.roles[p.id] === 'Sipahi');
    const daku = room.players.find(p => room.roles[p.id] === 'Daku');
    const chor = room.players.find(p => room.roles[p.id] === 'Chor');
    const chosen = room.players.find(p => p.id === suspectId);

    const isCorrect = (chosen.id === daku.id);
    const roundPts = {};

    // Balanced Scoring Scheme
    room.players.forEach(p => {
      const r = room.roles[p.id];
      if (r === 'Raja') roundPts[p.id] = 1000;
      else if (r === 'Mantri') roundPts[p.id] = 800;
      else if (r === 'Chor') roundPts[p.id] = 300; // Baseline reward
    });

    if (isCorrect) {
      roundPts[sipahi.id] = 500;
      roundPts[daku.id] = 0;
    } else {
      roundPts[sipahi.id] = 0;
      roundPts[daku.id] = 800; // 300 base + 500 stolen
    }

    // Cumulative points
    room.players.forEach(p => {
      p.score += roundPts[p.id];
    });

    io.to(room.code).emit('VERDICT_ANNOUNCED', {
      isCorrect,
      chosenName: chosen.name,
      dakuName: daku.name,
      roundPts,
      allRoles: room.roles,
      players: room.players
    });
  }

  // NEXT ROUND
  socket.on('NEXT_ROUND', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.round += 1;
    room.phase = 'LOBBY';
    io.to(roomCode).emit('READY_NEXT_ROUND', { round: room.round });
  });

  // DISCONNECT HANDLING
  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          rooms.delete(code);
        } else {
          // Host migration
          if (room.hostId === socket.id) {
            const nextHuman = room.players.find(p => !p.isBot);
            room.hostId = nextHuman ? nextHuman.id : room.players[0].id;
          }
          io.to(code).emit('PLAYER_DISCONNECTED', { 
            players: room.players, 
            hostId: room.hostId 
          });
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Shahi Darbar Server active on port ${PORT}`);
});