// GMN LAN Multiplayer Signaling Server
// Author: Gemini (Updated)
// Version: 1.3.0
//
// This is a lightweight WebSocket server for establishing WebRTC connections
// between RPG Maker MZ clients on a local network.
//
// CHANGES v1.3.0:
// - Added persistent "PLZA" room for a shared world experience.
// - Plaza state (switches, variables) is server-authoritative.
// - Plaza state is saved to `plaza_state.json` and persists through restarts.
// - Plaza state is automatically reset every week.
// - Updated message handling for Plaza-specific state synchronization.
//
// CHANGES v1.2.0:
// - Increased maximum players per room from 3 to 8
// - Improved player ID assignment logic for larger rooms
//
// HOW TO RUN:
// 1. Make sure you have Node.js installed (https://nodejs.org/).
// 2. Open a terminal or command prompt.
// 3. Navigate to the directory where this file is saved.
// 4. Run the command: node signaling_server.js

const WebSocket = require('ws');
const fs = require('fs');

const wss = new WebSocket.Server({ port: 8080 });

const rooms = new Map();
const MAX_PLAYERS_PER_ROOM = 8;
const PLAZA_ROOM_ID = "PLZA";
const PLAZA_STATE_FILE = './plaza_state.json';

// --- PLAZA STATE MANAGEMENT ---
let plazaState = {
    switches: {},
    variables: {},
    lastReset: new Date().toISOString()
};

// Load persistent Plaza state on startup
try {
    if (fs.existsSync(PLAZA_STATE_FILE)) {
        const savedState = JSON.parse(fs.readFileSync(PLAZA_STATE_FILE, 'utf-8'));
        if (savedState.switches && savedState.variables && savedState.lastReset) {
            plazaState = savedState;
            console.log('Loaded persistent Plaza state from file.');
        }
    }
} catch (e) {
    console.error('Could not load plaza_state.json:', e);
}

function savePlazaState() {
    try {
        fs.writeFileSync(PLAZA_STATE_FILE, JSON.stringify(plazaState, null, 2));
    } catch (e) {
        console.error('Failed to save Plaza state:', e);
    }
}

// Check for weekly reset every hour
setInterval(() => {
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const lastResetTime = new Date(plazaState.lastReset).getTime();
    if (Date.now() - lastResetTime > ONE_WEEK_MS) {
        console.log('Performing weekly reset of Plaza state.');
        plazaState.switches = {};
        plazaState.variables = {};
        plazaState.lastReset = new Date().toISOString();
        savePlazaState();

        const plazaRoom = rooms.get(PLAZA_ROOM_ID);
        if (plazaRoom) {
            broadcastToRoom(PLAZA_ROOM_ID, {
                type: 'plaza-state-reset',
                message: 'The world state has been reset for the week.'
            });
        }
    }
}, 60 * 60 * 1000);

// --- SERVER START ---
console.log('Signaling server started on port 8080...');
console.log(`Maximum players per room: ${MAX_PLAYERS_PER_ROOM}`);
// Initialize the persistent Plaza room
rooms.set(PLAZA_ROOM_ID, new Map());
console.log(`Persistent Plaza room "${PLAZA_ROOM_ID}" is active.`);
console.log('Waiting for players to connect...');


wss.on('connection', (ws) => {
    console.log('Client connected.');

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON received:', message);
            return;
        }

        switch (data.type) {
            case 'create':
                handleCreateRoom(ws, data.roomId);
                break;
            case 'join':
                handleJoinRoom(ws, data.roomId, data.playerInfo);
                break;
            case 'list-rooms':
                handleListRooms(ws);
                break;
            // Plaza-specific state updates
            case 'plaza-switch-change':
                handlePlazaSwitchChange(ws, data.id, data.value);
                break;
            case 'plaza-variable-change':
                handlePlazaVariableChange(ws, data.id, data.value);
                break;
            // WebRTC signaling forwarding
            case 'webrtc-offer':
            case 'webrtc-answer':
            case 'webrtc-candidate':
                forwardMessage(ws, data);
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected.');
        handleDisconnect(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function handleCreateRoom(ws, roomId) {
    if (rooms.has(roomId) || roomId === PLAZA_ROOM_ID) {
        sendMessage(ws, { type: 'error', message: 'Room already exists.' });
        return;
    }

    const players = new Map();
    const playerId = 1; // The creator is always Player 1
    players.set(playerId, ws);

    ws.meta = { roomId, playerId };
    rooms.set(roomId, players);

    console.log(`Room "${roomId}" created by Player ${playerId}.`);
    sendMessage(ws, { type: 'room-created', roomId });
}

function handleJoinRoom(ws, roomId, playerInfo) {
    if (roomId === PLAZA_ROOM_ID) {
        handleJoinPlaza(ws, playerInfo);
        return;
    }

    const room = rooms.get(roomId);
    if (!room) {
        sendMessage(ws, { type: 'error', message: 'Room not found.' });
        return;
    }

    if (room.size >= MAX_PLAYERS_PER_ROOM) {
        sendMessage(ws, { type: 'error', message: 'Room is full.' });
        return;
    }

    const newPlayerId = findNextAvailablePlayerId(room);
    if (!newPlayerId) {
        sendMessage(ws, { type: 'error', message: 'No available player slots.' });
        return;
    }

    ws.meta = { roomId, playerId: newPlayerId, playerInfo };

    const otherPlayers = [];
    for (const [id, client] of room.entries()) {
        otherPlayers.push({ id, info: client.meta.playerInfo });
        sendMessage(client, { type: 'player-joined', playerId: newPlayerId, playerInfo });
    }
    
    room.set(newPlayerId, ws);

    console.log(`Player ${newPlayerId} joined room "${roomId}" (${room.size}/${MAX_PLAYERS_PER_ROOM} players).`);
    sendMessage(ws, { type: 'room-joined', roomId, yourId: newPlayerId, otherPlayers });
}

function handleJoinPlaza(ws, playerInfo) {
    const plazaRoom = rooms.get(PLAZA_ROOM_ID);
    const newPlayerId = findNextAvailablePlayerId(plazaRoom, 100); // Allow up to 100 players in Plaza

    ws.meta = { roomId: PLAZA_ROOM_ID, playerId: newPlayerId, playerInfo };

    const otherPlayers = [];
    for (const [id, client] of plazaRoom.entries()) {
        if (client.meta && client.meta.playerInfo) {
            otherPlayers.push({ id, info: client.meta.playerInfo });
        }
        sendMessage(client, { type: 'player-joined', playerId: newPlayerId, playerInfo });
    }

    plazaRoom.set(newPlayerId, ws);
    console.log(`Player ${newPlayerId} joined Plaza "${PLAZA_ROOM_ID}" (${plazaRoom.size} players).`);
    
    // Notify the new player they've joined the Plaza and send other players' info
    sendMessage(ws, {
        type: 'room-joined',
        roomId: PLAZA_ROOM_ID,
        isPlaza: true,
        yourId: newPlayerId,
        otherPlayers
    });

    // Send the entire current Plaza state to the new player
    sendMessage(ws, {
        type: 'plaza-full-state',
        switches: plazaState.switches,
        variables: plazaState.variables
    });
}

function findNextAvailablePlayerId(room, limit = MAX_PLAYERS_PER_ROOM) {
    // Player 1 is reserved for leaders in standard rooms
    const startId = (room === rooms.get(PLAZA_ROOM_ID)) ? 1 : 2;
    for (let id = startId; id <= limit; id++) {
        if (!room.has(id)) {
            return id;
        }
    }
    return null; // No available slots
}

function handleListRooms(ws) {
    const roomList = Array.from(rooms.entries())
        .filter(([roomId]) => roomId !== PLAZA_ROOM_ID) // Don't list the Plaza
        .map(([roomId, players]) => ({
            id: roomId,
            players: players.size,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            isFull: players.size >= MAX_PLAYERS_PER_ROOM
        }));
    
    console.log(`Sending room list to client: ${roomList.length} rooms available`);
    sendMessage(ws, {
        type: 'room-list',
        rooms: roomList
    });
}

function handleDisconnect(ws) {
    if (!ws.meta) return;

    const { roomId, playerId } = ws.meta;
    const room = rooms.get(roomId);

    if (room) {
        room.delete(playerId);
        console.log(`Player ${playerId} left room "${roomId}" (${room.size} players remaining).`);

        // If room is not the Plaza and becomes empty or leader leaves, close it
        if (roomId !== PLAZA_ROOM_ID && (playerId === 1 || room.size === 0)) {
            console.log(`Closing room "${roomId}".`);
            for (const client of room.values()) {
                sendMessage(client, {type: 'error', message: 'The room has been closed by the leader.'});
                client.close();
            }
            rooms.delete(roomId);
        } else {
            // Notify remaining players that this player has left
            broadcastToRoom(roomId, { type: 'player-left', playerId });
        }
    }
}

function forwardMessage(ws, data) {
    if (!ws.meta) return;
    const { roomId, playerId } = ws.meta;
    const room = rooms.get(roomId);

    if (room && data.to) {
        const recipient = room.get(data.to);
        if (recipient) {
            data.from = playerId;
            sendMessage(recipient, data);
        } else {
            console.log(`Could not find recipient ${data.to} in room ${roomId}`);
        }
    }
}

function handlePlazaSwitchChange(ws, switchId, value) {
    if (ws.meta.roomId !== PLAZA_ROOM_ID) return;
    plazaState.switches[switchId] = value;
    savePlazaState();
    broadcastToRoom(PLAZA_ROOM_ID, { type: 'plaza-sync-switch', id: switchId, value }, ws);
}

function handlePlazaVariableChange(ws, variableId, value) {
    if (ws.meta.roomId !== PLAZA_ROOM_ID) return;
    plazaState.variables[variableId] = value;
    savePlazaState();
    broadcastToRoom(PLAZA_ROOM_ID, { type: 'plaza-sync-variable', id: variableId, value }, ws);
}

function broadcastToRoom(roomId, data, excludeWs = null) {
    const room = rooms.get(roomId);
    if (room) {
        for (const client of room.values()) {
            if (client !== excludeWs) {
                sendMessage(client, data);
            }
        }
    }
}

function sendMessage(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}
