#!/usr/bin/env node

import net from 'node:net';
import readline from 'node:readline';
import crypto from 'node:crypto';
import cbor from 'cbor';

const args = process.argv.slice(2);
let customUser = null;
let customHost = null;
let customPort = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '-u' || args[i] === '--user') { customUser = args[i + 1]; i++; }
    else if (args[i] === '-b' || args[i] === '--bot') { process.env.BOT_MODE = 'true'; process.env.BOT_API_KEY = args[i + 1]; i++; }
    else if (args[i] === '-s' || args[i] === '--server') { customHost = args[i + 1]; i++; }
    else if (args[i] === '-p' || args[i] === '--port') { customPort = parseInt(args[i + 1]); i++; }
    else if (args[i] === '-h' || args[i] === '--help') { 
        console.log(`NEXUS Protocol Client

Usage: node cli.js [options]

Options:
  -u, --user <name>     Username to connect as
  -b, --bot <key>       Bot mode with API key
  -s, --server <host>   Server hostname/IP
  -p, --port <port>     Server port (default: 7171)
  -h, --help            Show this help

Examples:
  node cli.js -u Sheepy
  node cli.js -b <api_key> --user MyBot
  node cli.js -s 192.168.1.100 -p 7171`);
        process.exit(0); 
    }
}

let SERVER_PORT = customPort || process.env.LNRP_PORT || 7171;
let SERVER_HOST = customHost || process.env.LNRP_HOST || 'localhost';
let USER_NAME = customUser || process.env.LNRP_USER || `user_${Math.floor(Math.random() * 10000)}`;
let IS_BOT = process.env.BOT_MODE === 'true';
let BOT_API_KEY = process.env.BOT_API_KEY || '';
let IS_LOGGED_IN = false;
let PENDING_USERNAME = null;

let socket = null;
let currentServerId = null;
let currentServerName = null;
let currentRoom = null;
let connected = false;
let buffer = Buffer.alloc(0);
let serverConfig = { name: 'Unknown', description: 'Unknown', motd: '' };
let userColors = new Map(); // Track colors per user to ensure uniqueness

// Generate unique color for each user
const colorPalette = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#5DADE2', '#58D68D', '#F1948A', '#D7BDE2', '#7DCEA0', '#F9E79F', '#AED6F1'];
let nextColorIndex = 0;

function getUserColor(username) {
    if (!userColors.has(username)) {
        userColors.set(username, colorPalette[nextColorIndex % colorPalette.length]);
        nextColorIndex++;
    }
    return userColors.get(username);
}

function rgbToAnsi(hexColor) { 
    const r = parseInt(hexColor.slice(1,3),16); 
    const g = parseInt(hexColor.slice(3,5),16); 
    const b = parseInt(hexColor.slice(5,7),16); 
    return `\x1b[38;2;${r};${g};${b}m`; 
}

function encodeMessage(msg) { 
    const encoded = cbor.encode(msg); 
    const header = Buffer.alloc(4); 
    header.writeUInt32BE(encoded.length); 
    return Buffer.concat([header, encoded]); 
}

function sendCommand(type, data) { 
    if (socket && connected && !socket.destroyed) { 
        socket.write(encodeMessage({ type, ...data })); 
        return true; 
    } 
    return false; 
}

const clearScreen = () => {
    console.clear();
    showHeader();
    updatePrompt();
};

const showHeader = () => {
    const boxWidth = 78;
    console.log(`\x1b[35m╔${'═'.repeat(boxWidth)}╗`);
    console.log(`║${'NEXUS PROTOCOL v1.0'.padStart(Math.floor((boxWidth - 18) / 2) + 18).padEnd(boxWidth)}║`);
    console.log(`╠${'═'.repeat(boxWidth)}╣`);
    console.log(`║User: ${USER_NAME}${IS_BOT ? ' 🤖 BOT MODE' : ''}${IS_LOGGED_IN ? ' ✅' : ' ❌'}${' '.repeat(boxWidth - 7 - USER_NAME.length - (IS_BOT ? 11 : 0) - (IS_LOGGED_IN ? 3 : 0))}║`);
    console.log(`║Server: ${SERVER_HOST}:${SERVER_PORT}${' '.repeat(boxWidth - 9 - String(SERVER_PORT).length - SERVER_HOST.length)}║`);
    console.log(`║Status: ${connected ? 'Connected ✅' : 'Disconnected ❌'}${' '.repeat(boxWidth - 9 - (connected ? 12 : 15))}║`);
    if (currentServerId && currentServerName) { 
        console.log(`╠${'═'.repeat(boxWidth)}╣`);
        const displayName = currentServerName.length > 45 ? currentServerName.substring(0, 42) + '...' : currentServerName;
        console.log(`║📡 Nexus: ${displayName} (ID: ${currentServerId})${' '.repeat(boxWidth - 11 - displayName.length - (String(currentServerId).length + 5))}║`);
    }
    if (currentRoom) console.log(`║💬 Chamber: #${currentRoom}${' '.repeat(boxWidth - 13 - currentRoom.length)}║`);
    console.log(`\x1b[35m╚${'═'.repeat(boxWidth)}╝\x1b[0m`);
};

const updatePrompt = () => { 
    const roomDisplay = currentRoom ? `#${currentRoom}` : ''; 
    const connStatus = connected ? '' : '🔌 '; 
    const botTag = IS_BOT ? '🤖 ' : '';
    const authTag = !IS_LOGGED_IN && !IS_BOT ? '🔐 ' : '';
    const nexusTag = currentServerId ? ` [${currentServerId}]` : '';
    rl.setPrompt(`\x1b[36m${connStatus}${authTag}${botTag}${USER_NAME}${nexusTag}${roomDisplay ? '@' + roomDisplay : ''}> \x1b[0m`); 
};

const disconnect = () => {
    if (!connected) {
        console.log('\x1b[33mNot connected to any server\x1b[0m');
        return;
    }
    console.log('\x1b[33mDisconnecting from server...\x1b[0m');
    if (socket) {
        socket.destroy();
    }
    connected = false;
    currentServerId = null;
    currentServerName = null;
    currentRoom = null;
    clearScreen();
    console.log('\x1b[32m✓ Disconnected from server\x1b[0m');
    console.log('\x1b[33mType /connect to reconnect or /server to change servers\x1b[0m');
    updatePrompt();
    rl.prompt();
};

const handleData = (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
        const msgLength = buffer.readUInt32BE(0);
        if (msgLength > 10 * 1024 * 1024 || msgLength < 1) { buffer = Buffer.alloc(0); return; }
        if (buffer.length < msgLength + 4) break;
        const msgData = buffer.subarray(4, msgLength + 4);
        buffer = buffer.subarray(msgLength + 4);
        try {
            const msg = cbor.decode(msgData);
            switch (msg.type) {
                case 'nexus_config': 
                    serverConfig = { name: msg.serverName, description: msg.serverDescription, motd: msg.motd }; 
                    if (msg.globalApiKey && IS_BOT) BOT_API_KEY = msg.globalApiKey; 
                    clearScreen();
                    console.log(`\x1b[32m✓ Connected to ${serverConfig.name}\x1b[0m`); 
                    break;
                case 'nexus_login_success':
                    IS_LOGGED_IN = true;
                    USER_NAME = msg.username;
                    console.log(`\x1b[32m✓ ${msg.message}\x1b[0m`);
                    console.log(`\x1b[33mUse /handshake to complete connection\x1b[0m`);
                    clearScreen();
                    break;
                case 'nexus_server_state':
                    if (msg.serverId === null) {
                        currentServerId = null;
                        currentServerName = null;
                        currentRoom = null;
                        console.log(`\x1b[33mLeft Nexus\x1b[0m`);
                        clearScreen();
                    } else {
                        currentServerId = msg.serverId;
                        currentServerName = msg.serverName;
                        console.log(`\x1b[32m✓ Now in Nexus: ${currentServerName} (${currentServerId})\x1b[0m`);
                        clearScreen();
                    }
                    break;
                case 'nexus_room_state':
                    if (msg.roomName === null) {
                        currentRoom = null;
                        console.log(`\x1b[33mLeft chamber\x1b[0m`);
                        clearScreen();
                    } else {
                        currentRoom = msg.roomName;
                        console.log(`\x1b[32m✓ Now in chamber: #${currentRoom}\x1b[0m`);
                        clearScreen();
                    }
                    break;
                case 'nexus_chat': 
                    if (currentRoom === msg.room) { 
                        const colorCode = msg.color ? rgbToAnsi(msg.color) : getUserColor(msg.from);
                        const botTag = msg.isBot ? '🤖 ' : '';
                        const roleBadge = msg.role && msg.role !== 'member' ? ` [${msg.role}]` : '';
                        const displayName = msg.displayName || msg.from;
                        console.log(`\n${colorCode}[${msg.room}] ${botTag}${displayName}${roleBadge}:\x1b[0m ${msg.message}`); 
                        updatePrompt(); 
                        rl.prompt();
                    } 
                    break;
                case 'nexus_private': 
                    const pmColor = msg.color ? rgbToAnsi(msg.color) : '\x1b[35m'; 
                    console.log(`\n${pmColor}💌 [PM from ${msg.from}]:\x1b[0m ${msg.message}`); 
                    if (msg.offline) console.log(`\x1b[33m  (offline message)\x1b[0m`);
                    updatePrompt(); 
                    rl.prompt();
                    break;
                case 'nexus_system': 
                    if (msg.message !== serverConfig.motd) {
                        if (msg.message.includes('Nexus created!')) {
                            const match = msg.message.match(/ID: ([0-9]+), API Key: ([a-f0-9]+)/);
                            if (match) {
                                console.log(`\n\x1b[32m✓ ${msg.message}\x1b[0m`);
                                console.log(`\x1b[33m📌 Save this API Key for bot access: ${match[2]}\x1b[0m`);
                                console.log(`\x1b[33m📌 Share this 4-digit ID with friends: ${match[1]}\x1b[0m`);
                            } else console.log(`\n\x1b[33mℹ ${msg.message}\x1b[0m`);
                        } else if (msg.message.includes('Joined Nexus:')) {
                            console.log(`\n\x1b[32m✓ ${msg.message}\x1b[0m`);
                        } else if (msg.message.includes('Nickname changed')) {
                            console.log(`\n\x1b[32m✓ ${msg.message}\x1b[0m`);
                        } else if (msg.message.includes('Left Nexus')) {
                            clearScreen();
                            console.log(`\x1b[33m${msg.message}\x1b[0m`);
                        } else {
                            console.log(`\n\x1b[33mℹ ${msg.message}\x1b[0m`);
                        }
                    }
                    updatePrompt(); 
                    rl.prompt();
                    break;
                case 'nexus_error': 
                    console.log(`\n\x1b[31m❌ ${msg.message}\x1b[0m`); 
                    updatePrompt(); 
                    rl.prompt();
                    break;
            }
        } catch (err) { console.log(`\x1b[31mParse error: ${err.message}\x1b[0m`); }
    }
    if (connected) rl.prompt();
};

const connectToServer = () => {
    if (socket) socket.destroy();
    buffer = Buffer.alloc(0);
    console.log(`\x1b[33m⏳ Connecting to ${SERVER_HOST}:${SERVER_PORT}...\x1b[0m`);
    socket = net.createConnection({ host: SERVER_HOST, port: SERVER_PORT }, () => {
        connected = true;
        if (IS_BOT && BOT_API_KEY) { 
            socket.write(encodeMessage({ type: 'nexus_bot_auth', api_key: BOT_API_KEY, bot_name: USER_NAME })); 
        } else if (IS_LOGGED_IN && PENDING_USERNAME) {
            socket.write(encodeMessage({ type: 'nexus_handshake', name: PENDING_USERNAME, public_key: crypto.randomBytes(32).toString('hex') }));
            PENDING_USERNAME = null;
        } else {
            socket.write(encodeMessage({ type: 'nexus_handshake', name: USER_NAME, public_key: crypto.randomBytes(32).toString('hex') }));
        }
        updatePrompt();
        console.log(`\x1b[32m✓ Connected!\x1b[0m`);
        if (!IS_BOT && !IS_LOGGED_IN) console.log(`\x1b[33mType /register <user> <pass> or /login <user> <pass> to authenticate!\x1b[0m`);
        if (!IS_BOT && IS_LOGGED_IN) console.log(`\x1b[33mType /handshake to complete login, then /create <name> or /join <id>!\x1b[0m`);
    });
    socket.on('data', handleData);
    socket.on('error', (err) => { console.log(`\x1b[31m✗ Connection error: ${err.message}\x1b[0m`); connected = false; updatePrompt(); });
    socket.on('close', () => { if (connected) { connected = false; console.log(`\x1b[31m✗ Disconnected\x1b[0m`); updatePrompt(); } });
};

const handshake = () => {
    if (!connected) { console.log(`\x1b[31mNot connected. Type /connect first\x1b[0m`); return; }
    if (!IS_LOGGED_IN) { console.log(`\x1b[31mNot logged in. Type /login first\x1b[0m`); return; }
    socket.write(encodeMessage({ type: 'nexus_handshake', name: USER_NAME, public_key: crypto.randomBytes(32).toString('hex') }));
};

const changeServer = (host, port) => {
    if (connected) {
        console.log(`\x1b[33mDisconnecting from current server...\x1b[0m`);
        if (socket) socket.destroy();
        connected = false;
    }
    SERVER_HOST = host;
    if (port) SERVER_PORT = port;
    console.log(`\x1b[33mServer changed to ${SERVER_HOST}:${SERVER_PORT}\x1b[0m`);
    clearScreen();
};

const reconnect = () => {
    if (connected) {
        console.log(`\x1b[33mAlready connected. Disconnecting first...\x1b[0m`);
        if (socket) socket.destroy();
        connected = false;
    }
    setTimeout(() => connectToServer(), 500);
};

const register = (username, password) => {
    if (!connected) { console.log(`\x1b[31mNot connected. Type /connect first\x1b[0m`); return; }
    if (!username || !password) { console.log(`\x1b[31mUsage: /register <username> <password>\x1b[0m`); return; }
    sendCommand('nexus_register', { username, password });
};

const login = (username, password) => {
    if (!connected) { console.log(`\x1b[31mNot connected. Type /connect first\x1b[0m`); return; }
    if (!username || !password) { console.log(`\x1b[31mUsage: /login <username> <password>\x1b[0m`); return; }
    PENDING_USERNAME = username;
    sendCommand('nexus_login', { username, password });
};

const logout = () => {
    if (!connected) { console.log(`\x1b[31mNot connected\x1b[0m`); return; }
    IS_LOGGED_IN = false;
    PENDING_USERNAME = null;
    if (socket) socket.destroy();
    connected = false;
    console.log(`\x1b[33mLogged out. Type /connect to reconnect as guest or /login to authenticate\x1b[0m`);
    clearScreen();
};

const showApiKey = () => {
    if (!connected) { console.log(`\x1b[31mNot connected\x1b[0m`); return; }
    if (!currentServerId) { console.log(`\x1b[31mNot in a Nexus\x1b[0m`); return; }
    sendCommand('nexus_get_api_key', {});
};

const setNickname = (nickname) => {
    if (!nickname) { console.log(`\x1b[31mUsage: /nick <name>\x1b[0m`); return; }
    if (!connected) { console.log(`\x1b[31mNot connected. Type /connect first\x1b[0m`); return; }
    if (!currentServerId) { console.log(`\x1b[31mNot in a Nexus. Use /join <id> first\x1b[0m`); return; }
    sendCommand('nexus_set_nickname', { nickname });
};

const handleCommand = (cmd, args) => {
    switch(cmd) {
        case 'help': 
            console.log(`\x1b[33m╔══════════════════════════════════════════════════════════════════╗
║                      NEXUS CLIENT COMMANDS                                    ║
╠══════════════════════════════════════════════════════════════════╣
║ CONNECTION:                                                            ║
║   /connect           - Connect to server                                ║
║   /disconnect        - Disconnect from current server                   ║
║   /reconnect         - Reconnect to server                              ║
║   /handshake         - Complete login handshake                         ║
║   /server <host> [port] - Change server address                         ║
║   /register <u> <p>  - Register account                                 ║
║   /login <u> <p>     - Login to account                                 ║
║   /logout            - Logout                                           ║
║                                                                         ║
║ NEXUS MANAGEMENT:                                                       ║
║   /create <name>     - Create a Nexus (gets 4-digit ID)                 ║
║   /delete            - Delete current Nexus                             ║
║   /join <id>         - Join a Nexus by ID                               ║
║   /leave             - Leave current Nexus                              ║
║   /servers           - List all Nexuses                                 ║
║   /info              - Show Nexus info                                  ║
║   /apikey            - Show your Nexus API key (owner only)             ║
║                                                                         ║
║ CHAMBER MANAGEMENT:                                                     ║
║   /createroom <name> - Create a chamber                                 ║
║   /deleteroom <name> - Delete a chamber                                 ║
║   /joinroom <name>   - Join a chamber                                   ║
║   /leaveroom         - Leave chamber                                    ║
║   /rooms             - List chambers                                    ║
║                                                                         ║
║ USER MANAGEMENT:                                                        ║
║   /users             - List users in chamber                            ║
║   /members           - List all members                                 ║
║   /nick <name>       - Set nickname                                     ║
║   /msg <user> <msg>  - Private message                                  ║
║                                                                         ║
║ MODERATION:                                                             ║
║   /kick <user>       - Kick user                                        ║
║   /ban <user> [reason] - Ban user                                       ║
║   /unban <user>      - Unban user                                       ║
║   /bans              - List bans                                        ║
║                                                                         ║
║ ROLES:                                                                  ║
║   /addrole <n> <c> <p> - Add role                                       ║
║   /removerole <name> - Remove role                                      ║
║   /setrole <u> <r>   - Set user role                                    ║
║   /roles             - List roles                                       ║
║                                                                         ║
║ INVITES:                                                                ║
║   /invite            - Create invite code                               ║
║   /invite <code>     - Use invite code                                  ║
║                                                                         ║
║ UTILITY:                                                                ║
║   /clear             - Clear screen                                     ║
║   /quit              - Exit                                             ║
╚══════════════════════════════════════════════════════════════════╝\x1b[0m`);
            break;
        case 'connect': 
            if (!connected) connectToServer(); 
            else console.log('\x1b[33mAlready connected!\x1b[0m'); 
            break;
        case 'disconnect':
            disconnect();
            break;
        case 'handshake': 
            handshake(); 
            break;
        case 'reconnect': 
            reconnect(); 
            break;
        case 'server': 
            if (!args[0]) { console.log('\x1b[31mUsage: /server <host> [port]\x1b[0m'); break; }
            changeServer(args[0], args[1] ? parseInt(args[1]) : null);
            break;
        case 'register': 
            register(args[0], args[1]); 
            break;
        case 'login': 
            login(args[0], args[1]); 
            break;
        case 'logout': 
            logout(); 
            break;
        case 'apikey': 
            showApiKey(); 
            break;
        case 'create': 
            if (!connected) { console.log('\x1b[31mNot connected. Type /connect first\x1b[0m'); break; } 
            sendCommand('nexus_create_server', { server_name: args.join(' ') || `${USER_NAME}'s Nexus` }); 
            break;
        case 'delete': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            if (!currentServerId) { console.log('\x1b[31mNot in a Nexus. Use /join first\x1b[0m'); break; }
            console.log('\x1b[33m⚠️ Are you sure? Type /delete_confirm to confirm\x1b[0m');
            const confirmHandler = (input) => {
                if (input.trim() === '/delete_confirm') {
                    sendCommand('nexus_delete_server', {});
                    rl.removeListener('line', confirmHandler);
                } else if (input.trim() === '/cancel') {
                    console.log('\x1b[33mDeletion cancelled\x1b[0m');
                    rl.removeListener('line', confirmHandler);
                }
                updatePrompt();
                rl.prompt();
            };
            rl.on('line', confirmHandler);
            break;
        case 'delete_confirm':
            sendCommand('nexus_delete_server', {});
            break;
        case 'join': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            if (!args[0]) { console.log('\x1b[31mUsage: /join <server_id> (4-digit ID)\x1b[0m'); break; } 
            sendCommand('nexus_join_server', { server_id: args[0] }); 
            break;
        case 'leave': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            sendCommand('nexus_leave_server', {}); 
            break;
        case 'servers': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            sendCommand('nexus_list_servers', {}); 
            break;
        case 'info': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            sendCommand('nexus_server_info', {}); 
            break;
        case 'createroom': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            if (!args[0]) { console.log('\x1b[31mUsage: /createroom <name>\x1b[0m'); break; } 
            if (!currentServerId) { console.log('\x1b[31mNot in a Nexus. Use /join first\x1b[0m'); break; }
            sendCommand('nexus_create_room', { room_name: args[0] }); 
            break;
        case 'deleteroom': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            if (!args[0]) { console.log('\x1b[31mUsage: /deleteroom <name>\x1b[0m'); break; } 
            if (!currentServerId) { console.log('\x1b[31mNot in a Nexus. Use /join first\x1b[0m'); break; }
            sendCommand('nexus_delete_room', { room_name: args[0] }); 
            break;
        case 'joinroom': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            if (!args[0]) { console.log('\x1b[31mUsage: /joinroom <name>\x1b[0m'); break; } 
            if (!currentServerId) { console.log('\x1b[31mNot in a Nexus. Use /join first\x1b[0m'); break; }
            sendCommand('nexus_join_room', { room: args[0] }); 
            break;
        case 'leaveroom': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            sendCommand('nexus_leave_room', {}); 
            break;
        case 'rooms': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            sendCommand('nexus_list_rooms', {}); 
            break;
        case 'users': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            sendCommand('nexus_list_users', {}); 
            break;
        case 'members': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            sendCommand('nexus_list_members', {}); 
            break;
        case 'msg': 
            if (args.length >= 2) { 
                sendCommand('nexus_private', { target: args[0], message: args.slice(1).join(' ') }); 
                console.log(`\x1b[36m📤 [PM to ${args[0]}]: ${args.slice(1).join(' ')}\x1b[0m`); 
            } else console.log('\x1b[31mUsage: /msg <user> <message>\x1b[0m'); 
            break;
        case 'nick': 
            setNickname(args[0]); 
            break;
        case 'kick': 
            if (args[0]) sendCommand('nexus_kick', { target: args[0] }); 
            else console.log('\x1b[31mUsage: /kick <user>\x1b[0m'); 
            break;
        case 'ban': 
            if (args[0]) sendCommand('nexus_ban', { target: args[0], reason: args.slice(1).join(' ') || 'No reason' }); 
            else console.log('\x1b[31mUsage: /ban <user> [reason]\x1b[0m'); 
            break;
        case 'unban': 
            if (args[0]) sendCommand('nexus_unban', { target: args[0] }); 
            else console.log('\x1b[31mUsage: /unban <user>\x1b[0m'); 
            break;
        case 'bans': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            sendCommand('nexus_list_bans', {}); 
            break;
        case 'addrole': 
            if (args.length >= 3) sendCommand('nexus_add_role', { role_name: args[0], color: args[1], permissions: args.slice(2).join(' ') }); 
            else console.log('\x1b[31mUsage: /addrole <name> <color> <permissions>\x1b[0m'); 
            break;
        case 'removerole': 
            if (args[0]) sendCommand('nexus_remove_role', { role_name: args[0] }); 
            else console.log('\x1b[31mUsage: /removerole <name>\x1b[0m'); 
            break;
        case 'setrole': 
            if (args.length >= 2) sendCommand('nexus_set_role', { target: args[0], role: args[1] }); 
            else console.log('\x1b[31mUsage: /setrole <user> <role>\x1b[0m'); 
            break;
        case 'roles': 
            if (!connected) { console.log('\x1b[31mNot connected\x1b[0m'); break; } 
            sendCommand('nexus_list_roles', {}); 
            break;
        case 'invite': 
            if (args[0]) { 
                sendCommand('nexus_use_invite', { code: args[0] }); 
            } else { 
                if (!currentServerId) { console.log('\x1b[31mNot in a Nexus. Use /join first\x1b[0m'); break; }
                sendCommand('nexus_create_invite', {}); 
            } 
            break;
        case 'clear': 
            clearScreen(); 
            break;
        case 'quit': 
            console.log('\x1b[33m👋 Goodbye!\x1b[0m'); 
            if (socket) socket.end(); 
            setTimeout(() => process.exit(0), 100); 
            break;
        default: 
            console.log(`\x1b[31mUnknown command: ${cmd}. Type /help\x1b[0m`);
    }
};

const processInput = (input) => {
    if (!input.trim()) { updatePrompt(); rl.prompt(); return; }
    if (input.startsWith('/')) { 
        const parts = input.slice(1).split(' '); 
        handleCommand(parts[0].toLowerCase(), parts.slice(1)); 
    } else { 
        if (!connected) console.log('\x1b[31m❌ Not connected. Type /connect first\x1b[0m'); 
        else if (currentRoom) sendCommand('nexus_message', { message: input }); 
        else console.log('\x1b[31m❌ Not in a chamber. Use /joinroom <name>\x1b[0m'); 
    }
    updatePrompt(); 
    rl.prompt();
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
clearScreen();
console.log(`\x1b[33mNEXUS Protocol - Type /connect to connect to ${SERVER_HOST}:${SERVER_PORT}\x1b[0m`);
console.log(`\x1b[33mAfter login, type /handshake to complete authentication\x1b[0m`);
console.log(`\x1b[33mType /help to see all commands\x1b[0m`);
rl.on('line', processInput);
process.on('SIGINT', () => { console.log('\n\x1b[33m👋 Goodbye!\x1b[0m'); if (socket) socket.end(); setTimeout(() => process.exit(0), 100); });
