const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Rooms ──
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function newRoom(code, hostId, hostName) {
  return {
    code,
    players: [{ id: hostId, name: hostName, cards: [], hand: [], stack: [], wins: 0, eliminated: false, passed: false, connected: true, colorIndex: 0 }],
    hostId,
    started: false,
    phase: null,         // placing | bidding | flipping
    currentPlayer: 0,    // index in players
    currentBid: 0,
    highestBidder: -1,
    flipsRemaining: 0,
    totalCoastersOnTable: 0,
    roundNum: 0,
    firstPlacement: true,
    nextRoundStarter: -1,
    penaltyPlayer: -1,
    turnDeadline: 0,     // timestamp (ms) when current turn expires
    turnTimer: null,     // setTimeout handle for auto-action
    log: [],
    revealedCards: [],   // { playerIndex, card } for flip animations
  };
}

// ── Helpers ──
function getRoom(socket) {
  const code = socket.roomCode;
  return code ? rooms.get(code) : null;
}

function playerIndex(room, socketId) {
  return room.players.findIndex(p => p.id === socketId);
}

function activePlayers(room) {
  return room.players.filter(p => !p.eliminated);
}

function findNextActive(room, from) {
  const n = room.players.length;
  for (let i = 0; i < n; i++) {
    const idx = (from + i) % n;
    if (!room.players[idx].eliminated) return idx;
  }
  return -1;
}

function nextActiveUnpassed(room, from) {
  const n = room.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (!room.players[idx].eliminated && !room.players[idx].passed) return idx;
  }
  return -1;
}

function countOnTable(room) {
  return room.players.reduce((sum, p) => sum + p.stack.length, 0);
}

function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 100) room.log.shift();
}

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.turnDeadline = 0;
}

function startTurnTimer(room, seconds, callback) {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + seconds * 1000;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    room.turnDeadline = 0;
    callback();
  }, seconds * 1000);
}

function sanitizeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Sanitize state for a specific player (hide other hands) ──
function stateForPlayer(room, socketId) {
  const myIdx = playerIndex(room, socketId);
  return {
    code: room.code,
    started: room.started,
    players: room.players.map((p, i) => ({
      name: p.name,
      handCount: p.hand.length,
      hand: i === myIdx ? p.hand : null,  // only show own hand
      stackCount: p.stack.length,
      totalCards: p.cards.length,
      wins: p.wins,
      eliminated: p.eliminated,
      passed: p.passed,
      connected: p.connected,
      isMe: i === myIdx,
      colorIndex: p.colorIndex,
    })),
    hostId: room.hostId,
    isHost: socketId === room.hostId,
    myIndex: myIdx,
    phase: room.phase,
    currentPlayer: room.currentPlayer,
    currentBid: room.currentBid,
    highestBidder: room.highestBidder,
    flipsRemaining: room.flipsRemaining,
    totalCoastersOnTable: room.totalCoastersOnTable,
    roundNum: room.roundNum,
    firstPlacement: room.firstPlacement,
    log: room.log.slice(-40),
    revealedCards: room.revealedCards,
    penaltyPlayer: room.penaltyPlayer,
    penaltyCards: (room.phase === 'penalty' && room.penaltyPlayer === myIdx) ? room.players[myIdx].cards : null,
    turnDeadline: room.turnDeadline,
  };
}

function broadcastState(room) {
  for (const p of room.players) {
    io.to(p.id).emit('gameState', stateForPlayer(room, p.id));
  }
}

function broadcastMessage(room, msg) {
  addLog(room, msg);
  io.to(room.code).emit('message', msg);
}

// ── Game Logic ──
function startGame(room) {
  room.started = true;
  room.roundNum = 0;
  room.players.forEach(p => {
    p.cards = ['rose', 'rose', 'rose', 'skull'];
    p.wins = 0;
    p.eliminated = false;
  });
  addLog(room, '═══ Game Started ═══');
  startRound(room);
}

function startRound(room) {
  clearTurnTimer(room);
  room.roundNum++;
  room.phase = 'placing';
  room.currentBid = 0;
  room.highestBidder = -1;
  room.flipsRemaining = 0;
  room.totalCoastersOnTable = 0;
  room.firstPlacement = true;
  room.revealedCards = [];

  room.players.forEach(p => {
    if (!p.eliminated) {
      p.hand = [...p.cards];
      p.stack = [];
      p.passed = false;
    }
  });

  // First player: use nextRoundStarter if set, otherwise rotate
  if (room.nextRoundStarter >= 0 && !room.players[room.nextRoundStarter].eliminated) {
    room.currentPlayer = room.nextRoundStarter;
  } else {
    room.currentPlayer = findNextActive(room, (room.roundNum - 1) % room.players.length);
  }
  room.nextRoundStarter = -1;
  addLog(room, `— Round ${room.roundNum} —`);

  // Start 20s timer for first player's turn
  const firstPlayer = room.currentPlayer;
  startTurnTimer(room, 20, () => {
    if (room.phase !== 'placing' || room.currentPlayer !== firstPlayer) return;
    const p = room.players[firstPlayer];
    if (p.hand.length > 0) {
      handlePlace(room, firstPlayer, 0);
    }
  });
  broadcastState(room);
}

function handlePlace(room, pIdx, cardIndex) {
  if (room.phase !== 'placing') return;
  if (room.currentPlayer !== pIdx) return;
  const p = room.players[pIdx];
  if (cardIndex < 0 || cardIndex >= p.hand.length) return;

  const card = p.hand.splice(cardIndex, 1)[0];
  p.stack.push(card);
  room.totalCoastersOnTable = countOnTable(room);
  addLog(room, `${p.name} placed a coaster.`);

  // Check if all active players placed at least 1
  const allPlaced = room.players.every(pl => pl.eliminated || pl.stack.length > 0);
  if (allPlaced) room.firstPlacement = false;

  advancePlacing(room);
}

function advancePlacing(room) {
  let next = nextActiveUnpassed(room, room.currentPlayer);
  if (next === -1) next = findNextActive(room, 0);
  room.currentPlayer = next;

  // If the next player has no cards in hand, they must bid
  const nextPlayer = room.players[next];
  if (nextPlayer && !nextPlayer.eliminated && nextPlayer.hand.length === 0 && room.phase === 'placing' && !room.firstPlacement) {
    clearTurnTimer(room);
    broadcastState(room);
    setTimeout(() => {
      if (room.phase === 'placing' && room.currentPlayer === next) {
        handleStartBid(room, next, 1);
      }
    }, 800);
  } else {
    // 20s timer for placing turn
    startTurnTimer(room, 20, () => {
      if (room.phase !== 'placing' || room.currentPlayer !== next) return;
      // Auto-bid 1 if allowed, otherwise auto-place first card
      if (!room.firstPlacement && nextPlayer.stack.length > 0) {
        handleStartBid(room, next, 1);
      } else if (nextPlayer.hand.length > 0) {
        handlePlace(room, next, 0);
      }
    });
    broadcastState(room);
  }
}

function handleStartBid(room, pIdx, amount) {
  if (room.phase !== 'placing') return;
  if (room.currentPlayer !== pIdx) return;
  const p = room.players[pIdx];
  if (room.firstPlacement) return;

  room.totalCoastersOnTable = countOnTable(room);
  const maxBid = room.totalCoastersOnTable;
  const bidAmount = Math.max(1, Math.min(amount || 1, maxBid));

  room.phase = 'bidding';
  room.currentBid = bidAmount;
  room.highestBidder = pIdx;
  room.players.forEach(pl => pl.passed = false);
  players_passed_set_bidder(room, pIdx);

  addLog(room, `${p.name} opened bidding at ${bidAmount}.`);
  room.currentPlayer = -1; // no turn order in bidding
  startBidTimer(room);
  checkBiddingEnd(room);
}

function players_passed_set_bidder(room, bidderIdx) {
  // The bidder doesn't pass themselves
  room.players.forEach((p, i) => {
    if (i === bidderIdx) p.passed = false;
  });
}

function startBidTimer(room) {
  startTurnTimer(room, 20, () => {
    if (room.phase !== 'bidding') return;
    // Auto-pass all non-highest-bidder players who haven't passed
    room.players.forEach((p, i) => {
      if (!p.eliminated && !p.passed && i !== room.highestBidder) {
        p.passed = true;
        addLog(room, `${p.name} auto-passed (time).`);
      }
    });
    checkBiddingEnd(room);
  });
}

function handleRaiseBid(room, pIdx, amount) {
  if (room.phase !== 'bidding') return;
  const p = room.players[pIdx];
  if (p.passed || p.eliminated) return;
  if (pIdx === room.highestBidder) return; // can't outbid yourself
  room.totalCoastersOnTable = countOnTable(room);
  if (amount <= room.currentBid || amount > room.totalCoastersOnTable) return;

  room.currentBid = amount;
  room.highestBidder = pIdx;
  addLog(room, `${p.name} bid ${amount}.`);
  startBidTimer(room);
  checkBiddingEnd(room);
}

function handlePass(room, pIdx) {
  if (room.phase !== 'bidding') return;
  const p = room.players[pIdx];
  if (p.passed || p.eliminated) return;
  if (pIdx === room.highestBidder) return; // current highest bidder can't pass

  p.passed = true;
  addLog(room, `${p.name} passed.`);
  checkBiddingEnd(room);
}

function checkBiddingEnd(room) {
  // Bidding ends when all players except the highest bidder have passed,
  // or the bid equals total coasters on table
  room.totalCoastersOnTable = countOnTable(room);
  const active = room.players.filter((p, i) => !p.eliminated && !p.passed && i !== room.highestBidder);
  if (active.length === 0 || room.currentBid >= room.totalCoastersOnTable) {
    startFlipping(room);
    return;
  }
  broadcastState(room);
}

function startFlipping(room) {
  clearTurnTimer(room);
  room.phase = 'flipping';
  room.flipsRemaining = room.currentBid;
  room.currentPlayer = room.highestBidder;
  room.revealedCards = [];
  const bidder = room.players[room.highestBidder];
  addLog(room, `${bidder.name} must flip ${room.currentBid} coaster(s).`);
  broadcastState(room);
}

function handleFlip(room, flipperIdx, targetPlayerIdx) {
  if (room.phase !== 'flipping') return;
  if (room.flipsRemaining <= 0) return;
  if (flipperIdx !== room.highestBidder) return;
  if (room.currentPlayer !== flipperIdx) return;

  const target = room.players[targetPlayerIdx];
  if (!target || target.eliminated || target.stack.length === 0) return;

  // Must flip own stack first
  const flipper = room.players[flipperIdx];
  if (targetPlayerIdx !== flipperIdx && flipper.stack.length > 0) return;

  const card = target.stack.pop();
  room.totalCoastersOnTable = countOnTable(room);
  room.flipsRemaining--;

  room.revealedCards.push({ playerIndex: targetPlayerIdx, card, playerName: target.name });

  if (card === 'skull') {
    room.phase = 'flip_result';
    addLog(room, `💀 ${flipper.name} flipped ${target.name}'s SKULL!`);
    broadcastState(room);
    setTimeout(() => {
      penalize(room, flipperIdx, targetPlayerIdx);
    }, 1500);
  } else {
    addLog(room, `🌹 ${flipper.name} flipped ${target.name}'s Rose.`);
    if (room.flipsRemaining <= 0) {
      room.phase = 'flip_result';
      broadcastState(room);
      setTimeout(() => {
        challengeSuccess(room, flipperIdx);
      }, 1200);
    } else {
      broadcastState(room);
    }
  }
}

function challengeSuccess(room, pIdx) {
  const p = room.players[pIdx];
  p.wins++;
  room.nextRoundStarter = pIdx;
  addLog(room, `🏆 ${p.name} wins a point! (${p.wins}/2)`);
  if (p.wins >= 2) {
    gameOver(room, pIdx);
    return;
  }
  broadcastState(room);
  setTimeout(() => startRound(room), 2000);
}

function penalize(room, loserIdx, skullerIdx) {
  // Skull owner starts next round; if own skull, challenger starts
  room.nextRoundStarter = (loserIdx === skullerIdx) ? loserIdx : skullerIdx;

  const p = room.players[loserIdx];

  if (loserIdx === skullerIdx) {
    // Own skull: challenger chooses which card to discard
    if (p.cards.length > 1) {
      room.phase = 'penalty';
      room.penaltyPlayer = loserIdx;
      addLog(room, `${p.name} hit their own skull — choose a coaster to discard.`);
      broadcastState(room);
      return;
    }
    // Only 1 card left — no choice needed
  } else {
    // Opponent skull: blind random removal
  }

  doCardRemoval(room, loserIdx, -1);
}

function doCardRemoval(room, loserIdx, chosenIdx) {
  const p = room.players[loserIdx];
  if (p.cards.length > 0) {
    const removeIdx = (chosenIdx >= 0 && chosenIdx < p.cards.length) ? chosenIdx : Math.floor(Math.random() * p.cards.length);
    const removed = p.cards.splice(removeIdx, 1)[0];
    addLog(room, `${p.name} loses a coaster. ${p.cards.length} remaining.`);
  }
  if (p.cards.length === 0) {
    p.eliminated = true;
    p.hand = [];
    p.stack = [];
    addLog(room, `☠ ${p.name} is eliminated!`);
  }

  room.penaltyPlayer = -1;

  const alive = room.players.filter(pl => !pl.eliminated);
  if (alive.length <= 1) {
    gameOver(room, room.players.indexOf(alive[0]));
    return;
  }
  broadcastState(room);
  setTimeout(() => startRound(room), 2000);
}

function handlePenaltyDiscard(room, pIdx, cardIndex) {
  if (room.phase !== 'penalty') return;
  if (room.penaltyPlayer !== pIdx) return;
  const p = room.players[pIdx];
  if (cardIndex < 0 || cardIndex >= p.cards.length) return;
  doCardRemoval(room, pIdx, cardIndex);
}

function gameOver(room, winnerIdx) {
  clearTurnTimer(room);
  room.phase = 'gameover';
  const winner = room.players[winnerIdx];
  addLog(room, `═══ ${winner.name} WINS THE GAME! ═══`);
  io.to(room.code).emit('gameOver', { winnerName: winner.name, winnerIndex: winnerIdx });
  broadcastState(room);
}

// ── Socket Handling ──
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('createRoom', (name, cb) => {
    const code = genCode();
    const room = newRoom(code, socket.id, name.trim().slice(0, 16) || 'Host');
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    cb({ success: true, code });
    broadcastState(room);
  });

  socket.on('joinRoom', (data, cb) => {
    const code = (data.code || '').toUpperCase().trim();
    const name = (data.name || '').trim().slice(0, 16) || 'Player';
    const room = rooms.get(code);
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.started) {
      // Check if this is a reconnecting player
      const existing = room.players.find(p => p.name === name && !p.connected);
      if (existing) {
        existing.id = socket.id;
        existing.connected = true;
        socket.join(code);
        socket.roomCode = code;
        cb({ success: true, code });
        broadcastState(room);
        return;
      }
      return cb({ success: false, error: 'Game already in progress.' });
    }
    if (room.players.length >= 6) return cb({ success: false, error: 'Room is full (max 6).' });
    if (room.players.find(p => p.name === name)) return cb({ success: false, error: 'Name already taken.' });

    room.players.push({ id: socket.id, name, cards: [], hand: [], stack: [], wins: 0, eliminated: false, passed: false, connected: true, colorIndex: room.players.length });
    socket.join(code);
    socket.roomCode = code;
    cb({ success: true, code });
    addLog(room, `${name} joined the room.`);
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = getRoom(socket);
    if (!room || room.started) return;
    if (socket.id !== room.hostId) return;
    if (room.players.length < 2) return;
    startGame(room);
  });

  socket.on('placeCard', (cardIndex) => {
    const room = getRoom(socket);
    if (!room || !room.started) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;
    handlePlace(room, pIdx, cardIndex);
  });

  socket.on('startBid', (amount) => {
    const room = getRoom(socket);
    if (!room || !room.started) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;
    handleStartBid(room, pIdx, amount);
  });

  socket.on('raiseBid', (amount) => {
    const room = getRoom(socket);
    if (!room || !room.started) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;
    handleRaiseBid(room, pIdx, amount);
  });

  socket.on('pass', () => {
    const room = getRoom(socket);
    if (!room || !room.started) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;
    handlePass(room, pIdx);
  });

  socket.on('flipCoaster', (targetIdx) => {
    const room = getRoom(socket);
    if (!room || !room.started) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;
    handleFlip(room, pIdx, targetIdx);
  });

  socket.on('chatMessage', (msg) => {
    const room = getRoom(socket);
    if (!room) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;
    const p = room.players[pIdx];
    const text = sanitizeHtml((msg || '').toString().trim().slice(0, 200));
    if (!text) return;
    const now = Date.now();
    if (p.lastChatTime && now - p.lastChatTime < 1000) return; // rate limit
    p.lastChatTime = now;
    addLog(room, `💬 ${p.name}: ${text}`);
    broadcastState(room);
  });

  socket.on('penaltyDiscard', (cardIndex) => {
    const room = getRoom(socket);
    if (!room || !room.started) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;
    handlePenaltyDiscard(room, pIdx, cardIndex);
  });

  socket.on('dougLose', () => {
    const room = getRoom(socket);
    if (!room) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;
    const p = room.players[pIdx];
    if (p.name.toLowerCase() !== 'pat-wins') return;
    addLog(room, `💥 ${p.name} activated the DOUG BUTTON!`);
    io.to(room.code).emit('dougLose');
    broadcastState(room);
  });

  socket.on('playAgain', () => {
    const room = getRoom(socket);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    room.started = false;
    room.phase = null;
    room.log = [];
    room.revealedCards = [];
    room.players.forEach(p => {
      p.cards = [];
      p.hand = [];
      p.stack = [];
      p.wins = 0;
      p.eliminated = false;
      p.passed = false;
    });
    addLog(room, 'Host reset the game. Waiting to start...');
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket);
    if (!room) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;

    if (!room.started) {
      // Remove from lobby
      room.players.splice(pIdx, 1);
      if (room.players.length === 0) {
        rooms.delete(room.code);
      } else {
        if (socket.id === room.hostId) room.hostId = room.players[0].id;
        broadcastState(room);
      }
    } else {
      room.players[pIdx].connected = false;
      addLog(room, `${room.players[pIdx].name} disconnected.`);
      broadcastState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ☠  SKULL server running on http://localhost:${PORT}\n`);
});
