//=============================================================================
// RPG Maker MZ Multiplayer Server for Centralized Architecture
// Version: 1.0.0
//=============================================================================

const WebSocket = require('ws');

// Use the PORT environment variable provided by Render.com, or 8080 for local testing.
const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port: PORT });

console.log(`Starting server on port ${PORT}...`);

// --- Server State ---
let nextPlayerId = 1;
// Use a Map to store player data, keyed by their unique ID.
// players: { playerId -> { ws: WebSocket, info: Object } }
const players = new Map();

// The server's authoritative game state. This will be sent to new players.
const gameState = {
    switches: {},
    variables: {},
    selfSwitches: {}
};

// --- Helper Functions ---

/**
 * Broadcasts a message to all connected clients except the originator.
 * @param {object} data The data object to send.
 * @param {number} [originatorId] The ID of the player who sent the message.
 */
function broadcast(data, originatorId = null) {
    const message = JSON.stringify(data);
    for (const [playerId, player] of players.entries()) {
        if (playerId !== originatorId && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(message);
        }
    }
}


// --- Main Server Logic ---

wss.on('connection', (ws) => {
    // Assign a unique ID to the new player.
    const playerId = nextPlayerId++;
    ws.playerId = playerId; // Attach the ID to the WebSocket object for easy reference.

    console.log(`Player ${playerId} connected.`);

    // Keep-alive mechanism: Render's free tier can idle. Pinging keeps the connection active.
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    // Handle incoming messages from this client
    ws.on('message', (rawMessage) => {
        try {
            const data = JSON.parse(rawMessage);

            // The first message must be 'login'
            if (data.type === 'login') {
                // Store the player's data
                players.set(playerId, { ws: ws, info: data.playerInfo });

                // Get a list of all other players to send to the new player
                const otherPlayers = [];
                for (const [id, p] of players.entries()) {
                    if (id !== playerId) {
                        otherPlayers.push({ id: id, info: p.info });
                    }
                }

                // Send a success message back to the newly connected player
                ws.send(JSON.stringify({
                    type: 'login-success',
                    yourId: playerId,
                    gameState: gameState,
                    players: otherPlayers
                }));

                // Notify all other players that a new player has joined
                broadcast({
                    type: 'player-joined',
                    playerId: playerId,
                    playerInfo: data.playerInfo
                }, playerId);

                return; // Stop processing after login
            }
            
            // For all other message types, ensure the player is logged in
            if (!players.has(ws.playerId)) {
                console.warn(`Message received from non-logged-in client. Disconnecting.`);
                ws.terminate();
                return;
            }

            // Process different message types
            switch (data.type) {
                case 'player-move':
                case 'player-meta':
                case 'map-transfer':
                case 'player-state-change':
                    // Update server state with new player info/location
                    const player = players.get(ws.playerId);
                    if (player) {
                        if (data.type === 'player-move') {
                            player.info.x = data.x;
                            player.info.y = data.y;
                            player.info.direction = data.direction;
                        } else if (data.type === 'map-transfer') {
                            player.info.mapId = data.mapId;
                        } else if (data.type === 'player-meta') {
                            player.info = data.info;
                        }
                    }
                    // Relay the message to all other clients
                    broadcast({ ...data, from: ws.playerId }, ws.playerId);
                    break;

                case 'switch-change':
                    if (data.id !== undefined && data.value !== undefined) {
                        gameState.switches[data.id] = data.value;
                        broadcast({ ...data, from: ws.playerId }, ws.playerId);
                    }
                    break;

                case 'variable-change':
                    if (data.id !== undefined && data.value !== undefined) {
                        gameState.variables[data.id] = data.value;
                        broadcast({ ...data, from: ws.playerId }, ws.playerId);
                    }
                    break;

                case 'self-switch-change':
                    const key = `${data.mapId},${data.eventId},${data.switchType}`;
                    gameState.selfSwitches[key] = data.value;
                    broadcast({ ...data, from: ws.playerId }, ws.playerId);
                    break;

                default:
                    console.log(`Received unknown message type: ${data.type}`);
                    break;
            }
        } catch (error) {
            console.error(`Failed to process message: ${rawMessage}`, error);
        }
    });

    // Handle client disconnection
    ws.on('close', () => {
        const disconnectedId = ws.playerId;
        if (players.has(disconnectedId)) {
            players.delete(disconnectedId);
            console.log(`Player ${disconnectedId} disconnected.`);
            // Notify all remaining players
            broadcast({
                type: 'player-left',
                playerId: disconnectedId
            });
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for player ${ws.playerId}:`, error);
    });
});

// Interval to check for inactive connections and terminate them
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            console.log(`Terminating inactive connection for player ${ws.playerId || '(unknown)'}.`);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(() => {});
    });
}, 30000); // 30 seconds

wss.on('close', () => {
    clearInterval(interval);
});

console.log('Server is running and waiting for connections.');
