// GMN LAN Multiplayer Signaling Server
// Author: Gemini
// Version: 1.0.0
//
// This is a lightweight WebSocket server for establishing WebRTC connections
// between RPG Maker MZ clients on a local network.
//
// HOW TO RUN:
// 1. Make sure you have Node.js installed (https://nodejs.org/).
// 2. Open a terminal or command prompt.
// 3. Navigate to the directory where this file is saved.
// 4. Run the command: node signaling_server.js
//
// The server will then be running and listening for connections.

const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

// In-memory store for rooms and players
// For a real-world application, you might use a more robust store like Redis.
const rooms = new Map(); // key: roomId, value: Map(playerId, ws)

console.log('Signaling server started on port 8080...');
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
            // The following messages are for WebRTC signaling and are just forwarded
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
    if (rooms.has(roomId)) {
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
    const room = rooms.get(roomId);
    if (!room) {
        sendMessage(ws, { type: 'error', message: 'Room not found.' });
        return;
    }

    if (room.size >= 3) {
        sendMessage(ws, { type: 'error', message: 'Room is full.' });
        return;
    }

    // Find the next available player ID (2 or 3)
    const newPlayerId = room.has(2) ? 3 : 2;
    ws.meta = { roomId, playerId: newPlayerId };

    // Notify existing players about the new player
    const otherPlayers = [];
    for (const [id, client] of room.entries()) {
        otherPlayers.push({ id, info: client.meta.playerInfo }); // Send existing players' info to new player
        sendMessage(client, { type: 'player-joined', playerId: newPlayerId, playerInfo });
    }
    
    ws.meta.playerInfo = playerInfo; // Store info for future joiners
    room.set(newPlayerId, ws);

    console.log(`Player ${newPlayerId} joined room "${roomId}".`);
    sendMessage(ws, { type: 'room-joined', roomId, yourId: newPlayerId, otherPlayers });
}

function handleDisconnect(ws) {
    if (!ws.meta) return; // Client disconnected before joining a room

    const { roomId, playerId } = ws.meta;
    const room = rooms.get(roomId);

    if (room) {
        room.delete(playerId);
        console.log(`Player ${playerId} left room "${roomId}".`);

        // If the leader (Player 1) disconnects, or room is empty, close the room
        if (playerId === 1 || room.size === 0) {
            console.log(`Closing room "${roomId}".`);
            for (const client of room.values()) {
                sendMessage(client, {type: 'error', message: 'The room has been closed by the leader.'});
                client.close();
            }
            rooms.delete(roomId);
        } else {
            // Notify remaining players that this player has left
            for (const client of room.values()) {
                sendMessage(client, { type: 'player-left', playerId });
            }
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
            // Forward the message but ensure the 'from' field is correct
            data.from = playerId;
            sendMessage(recipient, data);
        } else {
            console.log(`Could not find recipient ${data.to} in room ${roomId}`);
        }
    }
}

function sendMessage(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}
