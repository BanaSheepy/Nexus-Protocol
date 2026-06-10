#!/usr/bin/env node

// ============================================
// NEXUS PROTOCOL v1.6 - Streamlined Edition
// ============================================
const CONFIG = {
    protocolName: "Nexus",
    protocolVersion: "1.6",
    serverName: "Nexus Hub", 
    serverDescription: "A streamlined mesh communication network",
    motd: "Welcome to Nexus Protocol v1.6",
    bindAddress: "0.0.0.0",
    port: 7171,
    udpPort: 7172,
    wsPort: 8171,
    maxMessageSize: 10 * 1024 * 1024,
    nameExpiry: 300000,
    enableOfflineMessages: true,
    enableMessageHistory: true,
    adminUsers: ["admin"],
    dataDir: "./data",
};

import dgram from 'node:dgram';
import net from 'node:net';
import sqlite3 from 'sqlite3';
import cbor from 'cbor';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });

const db = new sqlite3.Database(path.join(CONFIG.dataDir, 'nexus.db'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS nexus_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_users (username TEXT PRIMARY KEY, password_hash TEXT, created_at INTEGER, last_login INTEGER, is_admin INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_servers (server_id TEXT PRIMARY KEY, owner TEXT, server_name TEXT, created_at INTEGER, default_room TEXT, is_permanent INTEGER DEFAULT 1)`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_rooms (server_id TEXT, room_name TEXT, created_by TEXT, created_at INTEGER, PRIMARY KEY (server_id, room_name))`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_bans (server_id TEXT, banned_user TEXT, banned_by TEXT, reason TEXT, banned_at INTEGER, PRIMARY KEY (server_id, banned_user))`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_roles (server_id TEXT, role_name TEXT, color TEXT, permissions TEXT, created_by TEXT, PRIMARY KEY (server_id, role_name))`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_members (server_id TEXT, user_name TEXT, role TEXT, joined_at INTEGER, nickname TEXT, PRIMARY KEY (server_id, user_name))`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_messages (server_id TEXT, room_name TEXT, user_name TEXT, message TEXT, timestamp INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_offline (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_name TEXT, sender_name TEXT, payload BLOB, timestamp INTEGER, delivered INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_invites (invite_code TEXT PRIMARY KEY, server_id TEXT, created_by TEXT, created_at INTEGER, uses INTEGER DEFAULT 0, max_uses INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS nexus_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT, action TEXT, user_name TEXT, target TEXT, details TEXT, timestamp INTEGER)`);
    
    db.run(`ALTER TABLE nexus_servers ADD COLUMN is_permanent INTEGER DEFAULT 1`, (err) => {});
    db.run(`ALTER TABLE nexus_rooms ADD COLUMN created_by TEXT`, (err) => {});
    db.run(`ALTER TABLE nexus_rooms ADD COLUMN created_at INTEGER`, (err) => {});
    db.run(`ALTER TABLE nexus_members ADD COLUMN nickname TEXT`, (err) => {});
});

let userServers = new Map();
let serverRooms = new Map();
let serverBans = new Map();
let serverRoles = new Map();
let serverMembers = new Map();
let activeConnections = new Map();
let userColors = new Map();
let monitoredRooms = new Set();
let consoleInRoom = null;
let tcpServerReady = false;
let wssReady = false;
let rl = null;

const colorPalette = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#5DADE2', '#58D68D', '#F1948A', '#D7BDE2', '#7DCEA0', '#F9E79F', '#AED6F1'];

function getUserColor(username) {
    if (!userColors.has(username)) userColors.set(username, colorPalette[userColors.size % colorPalette.length]);
    return userColors.get(username);
}

function encodeMessage(msg) {
    const encoded = cbor.encode(msg);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(encoded.length);
    return Buffer.concat([header, encoded]);
}

function broadcastToWebClients(message) { 
    if (global.wss) global.wss.clients.forEach(client => { 
        if (client.readyState === 1) client.send(JSON.stringify(message)); 
    }); 
}

function generateServerId() { return Math.floor(1000 + Math.random() * 9000).toString(); }
function generateInviteCode() { return Math.floor(1000 + Math.random() * 9000).toString(); }

function createInvite(serverId, createdBy, maxUses = 0) {
    const code = generateInviteCode();
    db.run('INSERT INTO nexus_invites (invite_code, server_id, created_by, created_at, max_uses) VALUES (?, ?, ?, ?, ?)', [code, serverId, createdBy, Date.now(), maxUses]);
    return code;
}

function logAudit(serverId, action, userName, target, details) {
    db.run('INSERT INTO nexus_audit_log (server_id, action, user_name, target, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)', [serverId, action, userName, target, details, Date.now()]);
    console.log(`\x1b[90m[AUDIT] ${serverId}: ${action} by ${userName} -> ${target}\x1b[0m`);
}

function isUserBanned(serverId, username) { 
    const bans = serverBans.get(serverId); 
    return bans && bans.has(username); 
}

function addBan(serverId, bannedUser, bannedBy, reason) {
    if (!serverBans.has(serverId)) serverBans.set(serverId, new Map());
    serverBans.get(serverId).set(bannedUser, { bannedBy, reason, time: Date.now() });
    db.run('INSERT OR REPLACE INTO nexus_bans (server_id, banned_user, banned_by, reason, banned_at) VALUES (?, ?, ?, ?, ?)', [serverId, bannedUser, bannedBy, reason, Date.now()]);
    logAudit(serverId, 'BAN', bannedBy, bannedUser, reason);
}

function removeBan(serverId, bannedUser) { 
    if (serverBans.has(serverId)) serverBans.get(serverId).delete(bannedUser); 
    db.run('DELETE FROM nexus_bans WHERE server_id = ? AND banned_user = ?', [serverId, bannedUser]);
    logAudit(serverId, 'UNBAN', 'system', bannedUser, '');
}

function addRole(serverId, roleName, color, permissions, createdBy) {
    if (!serverRoles.has(serverId)) serverRoles.set(serverId, new Map());
    serverRoles.get(serverId).set(roleName, { color, permissions, createdBy });
    db.run('INSERT OR REPLACE INTO nexus_roles (server_id, role_name, color, permissions, created_by) VALUES (?, ?, ?, ?, ?)', [serverId, roleName, color, permissions, createdBy]);
    logAudit(serverId, 'ADD_ROLE', createdBy, roleName, `color:${color} perms:${permissions}`);
}

function getUserRole(serverId, username) { 
    const member = serverMembers.get(serverId)?.get(username); 
    return member?.role || 'member'; 
}

function getDisplayName(serverId, username) {
    const member = serverMembers.get(serverId)?.get(username);
    if (member?.nickname) return member.nickname;
    return username;
}

function setUserNickname(serverId, username, nickname) {
    if (!serverMembers.has(serverId)) return false;
    if (!serverMembers.get(serverId).has(username)) return false;
    
    serverMembers.get(serverId).get(username).nickname = nickname;
    db.run('UPDATE nexus_members SET nickname = ? WHERE server_id = ? AND user_name = ?', [nickname, serverId, username]);
    return true;
}

function deleteUserServer(serverId, requester, isConsole = false) {
    if (!userServers.has(serverId)) return { error: 'Nexus not found' };
    
    const server = userServers.get(serverId);
    
    if (!isConsole && server.owner !== requester && !CONFIG.adminUsers.includes(requester)) {
        return { error: 'Only Nexus owner or server admin can delete this Nexus' };
    }
    
    for (const [username, conn] of activeConnections) {
        if (conn.currentServer === serverId) {
            const msg = { type: 'nexus_system', message: `The Nexus "${server.name}" has been deleted` };
            if (conn.isWeb) conn.socket.send(JSON.stringify(msg));
            else conn.socket.write(encodeMessage(msg));
            conn.currentServer = null;
            conn.currentRoom = null;
            if (conn.isWeb) conn.socket.send(JSON.stringify({ type: 'nexus_server_state', serverId: null, roomName: null }));
            else conn.socket.write(encodeMessage({ type: 'nexus_server_state', serverId: null, roomName: null }));
        }
    }
    
    db.run('DELETE FROM nexus_servers WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM nexus_rooms WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM nexus_bans WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM nexus_roles WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM nexus_members WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM nexus_messages WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM nexus_invites WHERE server_id = ?', [serverId]);
    
    userServers.delete(serverId);
    serverRooms.delete(serverId);
    serverBans.delete(serverId);
    serverRoles.delete(serverId);
    serverMembers.delete(serverId);
    
    logAudit(serverId, 'DELETE_SERVER', requester, server.name, 'Nexus deleted');
    
    return { success: true, name: server.name };
}

function createUserServer(owner, serverName) {
    let serverId;
    let unique = false;
    
    while (!unique) {
        serverId = generateServerId();
        if (!userServers.has(serverId)) unique = true;
    }
    
    userServers.set(serverId, { owner, name: serverName, createdAt: Date.now() });
    serverRooms.set(serverId, new Set(['general']));
    serverMembers.set(serverId, new Map());
    serverMembers.get(serverId).set(owner, { role: 'owner', joinedAt: Date.now(), nickname: null });
    
    db.run('INSERT INTO nexus_servers (server_id, owner, server_name, created_at, default_room) VALUES (?, ?, ?, ?, ?)', [serverId, owner, serverName, Date.now(), 'general']);
    db.run('INSERT INTO nexus_rooms (server_id, room_name, created_by, created_at) VALUES (?, ?, ?, ?)', [serverId, 'general', owner, Date.now()]);
    logAudit(serverId, 'CREATE_SERVER', owner, serverName, '');
    return { serverId };
}

function joinUserServer(username, serverId) {
    if (!userServers.has(serverId)) return { error: 'Nexus not found' };
    if (isUserBanned(serverId, username)) return { error: 'You are banned from this Nexus' };
    if (!serverMembers.get(serverId)) serverMembers.set(serverId, new Map());
    if (!serverMembers.get(serverId).has(username)) {
        serverMembers.get(serverId).set(username, { role: 'member', joinedAt: Date.now(), nickname: null });
        db.run('INSERT INTO nexus_members (server_id, user_name, role, joined_at) VALUES (?, ?, ?, ?)', [serverId, username, 'member', Date.now()]);
        logAudit(serverId, 'JOIN', username, '', '');
    }
    return { success: true };
}

function sendServerConfig(socket, isWebSocket = false) {
    const configMsg = { 
        type: 'nexus_config', 
        protocol: CONFIG.protocolName,
        version: CONFIG.protocolVersion,
        serverName: CONFIG.serverName, 
        serverDescription: CONFIG.serverDescription, 
        motd: CONFIG.motd, 
        colorPalette: colorPalette
    };
    if (isWebSocket) socket.send(JSON.stringify(configMsg));
    else socket.write(encodeMessage(configMsg));
}

function broadcastToRoom(serverId, roomName, message, sender) {
    const members = serverMembers.get(serverId);
    if (!members) return;
    
    const displayName = getDisplayName(serverId, sender);
    
    db.run('INSERT INTO nexus_messages (server_id, room_name, user_name, message, timestamp) VALUES (?, ?, ?, ?, ?)', [serverId, roomName, sender, message, Date.now()]);
    
    for (const [memberName, memberData] of members) {
        const conn = activeConnections.get(memberName);
        if (conn && conn.socket && !conn.socket.destroyed && conn.currentRoom === roomName && conn.currentServer === serverId) {
            const msg = { 
                type: 'nexus_chat', 
                room: roomName, 
                from: sender, 
                displayName: displayName,
                message: message, 
                timestamp: Date.now(), 
                color: getUserColor(sender), 
                role: getUserRole(serverId, sender)
            };
            if (conn.isWeb) conn.socket.send(JSON.stringify(msg));
            else conn.socket.write(encodeMessage(msg));
        }
    }
    
    broadcastToWebClients({ 
        type: 'nexus_chat', 
        room: roomName, 
        from: sender, 
        displayName: displayName,
        message: message, 
        timestamp: Date.now(), 
        color: getUserColor(sender), 
        role: getUserRole(serverId, sender)
    });
    
    if (monitoredRooms.has(roomName) || consoleInRoom === roomName) {
        console.log(`\x1b[36m[${roomName}] ${displayName}: ${message}\x1b[0m`);
        if (rl) rl.prompt();
    }
}

function registerUser(username, password, socket, isWebSocket = false) {
    return new Promise((resolve) => {
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        db.get('SELECT * FROM nexus_users WHERE username = ?', [username], (err, row) => {
            if (row) {
                const msg = { type: 'nexus_system', message: '❌ Username already taken' };
                if (isWebSocket) socket.send(JSON.stringify(msg));
                else socket.write(encodeMessage(msg));
                resolve(false);
            } else {
                db.run('INSERT INTO nexus_users (username, password_hash, created_at, last_login) VALUES (?, ?, ?, ?)',
                    [username, passwordHash, Date.now(), Date.now()], (err) => {
                    const msg = { type: 'nexus_system', message: err ? '❌ Registration failed' : `✓ Registration successful! You can now login with /login ${username} <password>` };
                    if (isWebSocket) socket.send(JSON.stringify(msg));
                    else socket.write(encodeMessage(msg));
                    resolve(!err);
                });
            }
        });
    });
}

function loginUser(username, password, socket, isWebSocket = false) {
    return new Promise((resolve, reject) => {
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        db.get('SELECT * FROM nexus_users WHERE username = ? AND password_hash = ?', [username, passwordHash], (err, row) => {
            if (row) {
                db.run('UPDATE nexus_users SET last_login = ? WHERE username = ?', [Date.now(), username]);
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

const handleTCPConnection = (socket) => {
    let buffer = Buffer.alloc(0);
    let userName = null;
    let currentServer = null;
    let currentRoom = null;
    let authenticated = false;
    let loggedInUser = null;
    
    const updateConnectionState = () => {
        const conn = activeConnections.get(userName);
        if (conn) {
            conn.currentServer = currentServer;
            conn.currentRoom = currentRoom;
        }
    };
    
    // Auto handshake after login
    const autoHandshake = (username) => {
        if (authenticated) return;
        
        if (activeConnections.has(username)) {
            userName = `${username}_${Math.floor(Math.random() * 1000)}`;
            socket.write(encodeMessage({ type: 'nexus_system', message: `Username taken. Assigned: ${userName}` }));
        } else {
            userName = username;
        }
        
        authenticated = true;
        activeConnections.set(userName, { socket, currentServer: null, currentRoom: null, isWeb: false, loggedInUser: loggedInUser });
        userColors.set(userName, colorPalette[activeConnections.size % colorPalette.length]);
        console.log(`\x1b[32m[+] ${userName} (logged in as: ${loggedInUser || 'guest'}) connected\x1b[0m`);
        sendServerConfig(socket, false);
        socket.write(encodeMessage({ type: 'nexus_system', message: CONFIG.motd }));
        socket.write(encodeMessage({ type: 'nexus_system', message: 'Type /help for commands' }));
        
        db.all('SELECT * FROM nexus_offline WHERE recipient_name = ? AND delivered = 0', [userName], (err, msgs) => { 
            if (msgs && msgs.length > 0) {
                msgs.forEach(m => { 
                    socket.write(encodeMessage({ type: 'nexus_private', from: m.sender_name, message: m.payload.toString(), timestamp: m.timestamp, offline: true })); 
                    db.run('UPDATE nexus_offline SET delivered = 1 WHERE id = ?', [m.id]); 
                });
            }
        });
    };
    
    socket.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
            const msgLength = buffer.readUInt32BE(0);
            if (msgLength > CONFIG.maxMessageSize || msgLength < 1) { socket.destroy(); return; }
            if (buffer.length < msgLength + 4) break;
            const msgData = buffer.subarray(4, msgLength + 4);
            buffer = buffer.subarray(msgLength + 4);
            try {
                const msg = cbor.decode(msgData);
                
                if (msg.type === 'nexus_register') {
                    await registerUser(msg.username, msg.password, socket, false);
                    return;
                }
                
                if (msg.type === 'nexus_login') {
                    const success = await loginUser(msg.username, msg.password, socket, false);
                    if (success) {
                        loggedInUser = msg.username;
                        socket.write(encodeMessage({ type: 'nexus_login_success', username: msg.username, message: `✓ Login successful! Welcome back ${msg.username}` }));
                        // Auto handshake
                        autoHandshake(msg.username);
                    } else {
                        socket.write(encodeMessage({ type: 'nexus_system', message: '❌ Invalid username or password' }));
                    }
                    return;
                }
                
                if (msg.type === 'nexus_logout') {
                    if (loggedInUser) {
                        loggedInUser = null;
                        authenticated = false;
                        userName = null;
                        currentServer = null;
                        currentRoom = null;
                        socket.write(encodeMessage({ type: 'nexus_system', message: '✓ Logged out successfully' }));
                        socket.write(encodeMessage({ type: 'nexus_server_state', serverId: null, roomName: null }));
                    } else {
                        socket.write(encodeMessage({ type: 'nexus_system', message: 'Not logged in' }));
                    }
                    return;
                }
                
                // Guest connection (no login)
                if (msg.type === 'nexus_guest') {
                    let requestedName = msg.name;
                    if (activeConnections.has(requestedName)) {
                        userName = `${requestedName}_${Math.floor(Math.random() * 1000)}`;
                        socket.write(encodeMessage({ type: 'nexus_system', message: `Username taken. Assigned: ${userName}` }));
                    } else {
                        userName = requestedName;
                    }
                    authenticated = true;
                    activeConnections.set(userName, { socket, currentServer: null, currentRoom: null, isWeb: false, loggedInUser: null });
                    userColors.set(userName, colorPalette[activeConnections.size % colorPalette.length]);
                    console.log(`\x1b[32m[+] ${userName} (guest) connected\x1b[0m`);
                    sendServerConfig(socket, false);
                    socket.write(encodeMessage({ type: 'nexus_system', message: CONFIG.motd }));
                    socket.write(encodeMessage({ type: 'nexus_system', message: 'Type /help for commands' }));
                    return;
                }
                
                if (!authenticated) {
                    socket.write(encodeMessage({ type: 'nexus_error', message: 'Not authenticated. Use /login <user> <pass> or /guest <name>' }));
                    continue;
                }
                
                if (msg.type === 'nexus_create_server') {
                    const { serverId } = createUserServer(userName, msg.server_name || `${userName}'s Nexus`);
                    socket.write(encodeMessage({ type: 'nexus_system', message: `✓ Nexus created! ID: ${serverId}` }));
                }
                
                if (msg.type === 'nexus_delete_server') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const result = deleteUserServer(currentServer, userName, false);
                    if (result.error) socket.write(encodeMessage({ type: 'nexus_error', message: result.error }));
                    else {
                        socket.write(encodeMessage({ type: 'nexus_system', message: `✓ Nexus "${result.name}" deleted successfully` }));
                        currentServer = null;
                        currentRoom = null;
                        updateConnectionState();
                        socket.write(encodeMessage({ type: 'nexus_server_state', serverId: null, roomName: null }));
                    }
                }
                
                if (msg.type === 'nexus_join_server') {
                    const result = joinUserServer(userName, msg.server_id);
                    if (result.error) socket.write(encodeMessage({ type: 'nexus_error', message: result.error }));
                    else { 
                        currentServer = msg.server_id;
                        updateConnectionState();
                        socket.write(encodeMessage({ type: 'nexus_system', message: `✓ Joined Nexus: ${userServers.get(msg.server_id).name}` }));
                        socket.write(encodeMessage({ type: 'nexus_server_state', serverId: currentServer, serverName: userServers.get(currentServer).name, roomName: currentRoom }));
                        if (serverRooms.get(msg.server_id)?.has('general')) {
                            currentRoom = 'general';
                            updateConnectionState();
                            socket.write(encodeMessage({ type: 'nexus_system', message: `Auto-joined chamber: general` }));
                            socket.write(encodeMessage({ type: 'nexus_room_state', roomName: currentRoom }));
                            broadcastToRoom(currentServer, currentRoom, `${userName} joined the chamber`, 'system');
                        }
                        const server = userServers.get(currentServer);
                        const memberCount = serverMembers.get(currentServer)?.size || 0;
                        const roomCount = serverRooms.get(currentServer)?.size || 0;
                        socket.write(encodeMessage({ type: 'nexus_system', message: `Nexus: ${server.name}\nOwner: ${server.owner}\nCreated: ${new Date(server.createdAt).toLocaleString()}\nMembers: ${memberCount}\nChambers: ${roomCount}` }));
                    }
                }
                
                if (msg.type === 'nexus_leave_server') {
                    if (currentRoom) {
                        broadcastToRoom(currentServer, currentRoom, `${userName} left`, 'system');
                        currentRoom = null;
                    }
                    if (currentServer) {
                        currentServer = null;
                        updateConnectionState();
                        socket.write(encodeMessage({ type: 'nexus_system', message: 'Left Nexus' }));
                        socket.write(encodeMessage({ type: 'nexus_server_state', serverId: null, roomName: null }));
                    } else {
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' }));
                    }
                }
                
                if (msg.type === 'nexus_create_room') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus. Use /join <server_id> first' })); return; }
                    if (!msg.room_name) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Room name required' })); return; }
                    
                    const server = userServers.get(currentServer);
                    const hasPermission = (server.owner === userName || CONFIG.adminUsers.includes(userName));
                    
                    if (!hasPermission) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Only Nexus owner can create chambers' })); 
                        return; 
                    }
                    
                    if (serverRooms.get(currentServer).has(msg.room_name)) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Chamber already exists' })); 
                        return; 
                    }
                    
                    serverRooms.get(currentServer).add(msg.room_name);
                    db.run('INSERT INTO nexus_rooms (server_id, room_name, created_by, created_at) VALUES (?, ?, ?, ?)', [currentServer, msg.room_name, userName, Date.now()]);
                    socket.write(encodeMessage({ type: 'nexus_system', message: `✓ Chamber created: ${msg.room_name}` }));
                    logAudit(currentServer, 'CREATE_ROOM', userName, msg.room_name, '');
                }
                
                if (msg.type === 'nexus_delete_room') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus. Use /join <server_id> first' })); return; }
                    if (!msg.room_name) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Room name required' })); return; }
                    
                    const server = userServers.get(currentServer);
                    const hasPermission = (server.owner === userName || CONFIG.adminUsers.includes(userName));
                    
                    if (!hasPermission) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Only Nexus owner can delete chambers' })); 
                        return; 
                    }
                    
                    if (msg.room_name === 'general') { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Cannot delete the general chamber' })); 
                        return; 
                    }
                    
                    if (!serverRooms.get(currentServer).has(msg.room_name)) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Chamber does not exist' })); 
                        return; 
                    }
                    
                    serverRooms.get(currentServer).delete(msg.room_name);
                    db.run('DELETE FROM nexus_rooms WHERE server_id = ? AND room_name = ?', [currentServer, msg.room_name]);
                    db.run('DELETE FROM nexus_messages WHERE server_id = ? AND room_name = ?', [currentServer, msg.room_name]);
                    
                    if (currentRoom === msg.room_name) {
                        currentRoom = null;
                        updateConnectionState();
                        socket.write(encodeMessage({ type: 'nexus_room_state', roomName: null }));
                    }
                    socket.write(encodeMessage({ type: 'nexus_system', message: `✓ Chamber deleted: ${msg.room_name}` }));
                    logAudit(currentServer, 'DELETE_ROOM', userName, msg.room_name, '');
                }
                
                if (msg.type === 'nexus_join_room') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus. Use /join <server_id> first' })); return; }
                    if (!msg.room) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Room name required' })); return; }
                    
                    if (!serverRooms.get(currentServer)?.has(msg.room)) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: `Chamber "${msg.room}" does not exist. Available: ${Array.from(serverRooms.get(currentServer)).join(', ')}` })); 
                        return; 
                    }
                    
                    if (currentRoom) broadcastToRoom(currentServer, currentRoom, `${userName} left the chamber`, 'system');
                    currentRoom = msg.room;
                    updateConnectionState();
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Joined chamber: ${currentRoom}` }));
                    socket.write(encodeMessage({ type: 'nexus_room_state', roomName: currentRoom }));
                    broadcastToRoom(currentServer, currentRoom, `${userName} joined the chamber`, 'system');
                }
                
                if (msg.type === 'nexus_leave_room') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    if (currentRoom) {
                        broadcastToRoom(currentServer, currentRoom, `${userName} left the chamber`, 'system');
                        currentRoom = null;
                        updateConnectionState();
                        socket.write(encodeMessage({ type: 'nexus_system', message: 'Left chamber' }));
                        socket.write(encodeMessage({ type: 'nexus_room_state', roomName: null }));
                    } else {
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a chamber' }));
                    }
                }
                
                if (msg.type === 'nexus_message') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus. Use /join <server_id> first' })); return; }
                    if (!currentRoom) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a chamber. Use /joinroom <name> first' })); 
                        return; 
                    }
                    broadcastToRoom(currentServer, currentRoom, msg.message, userName);
                }
                
                if (msg.type === 'nexus_private') {
                    const targetConn = activeConnections.get(msg.target);
                    if (targetConn) {
                        const pmMsg = { type: 'nexus_private', from: userName, message: msg.message, timestamp: Date.now(), color: getUserColor(userName) };
                        if (targetConn.isWeb) targetConn.socket.send(JSON.stringify(pmMsg));
                        else targetConn.socket.write(encodeMessage(pmMsg));
                        socket.write(encodeMessage({ type: 'nexus_system', message: `Message sent to ${msg.target}` }));
                    } else {
                        db.run('INSERT INTO nexus_offline (recipient_name, sender_name, payload, timestamp) VALUES (?, ?, ?, ?)', [msg.target, userName, Buffer.from(msg.message), Date.now()]);
                        socket.write(encodeMessage({ type: 'nexus_system', message: `Message stored offline for ${msg.target}` }));
                    }
                }
                
                if (msg.type === 'nexus_kick') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const server = userServers.get(currentServer);
                    const hasPermission = (server.owner === userName || CONFIG.adminUsers.includes(userName));
                    
                    if (!hasPermission) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Only owner can kick' })); 
                        return; 
                    }
                    const targetConn = activeConnections.get(msg.target);
                    if (targetConn && targetConn.currentServer === currentServer) { 
                        const kickMsg = { type: 'nexus_system', message: `You were kicked from ${server.name}` };
                        if (targetConn.isWeb) targetConn.socket.send(JSON.stringify(kickMsg));
                        else targetConn.socket.write(encodeMessage(kickMsg));
                        targetConn.currentServer = null;
                        targetConn.currentRoom = null;
                        if (targetConn.isWeb) targetConn.socket.send(JSON.stringify({ type: 'nexus_server_state', serverId: null, roomName: null }));
                        else targetConn.socket.write(encodeMessage({ type: 'nexus_server_state', serverId: null, roomName: null }));
                    }
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Kicked ${msg.target}` }));
                    logAudit(currentServer, 'KICK', userName, msg.target, '');
                }
                
                if (msg.type === 'nexus_ban') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const server = userServers.get(currentServer);
                    const hasPermission = (server.owner === userName || CONFIG.adminUsers.includes(userName));
                    
                    if (!hasPermission) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Only owner can ban' })); 
                        return; 
                    }
                    addBan(currentServer, msg.target, userName, msg.reason || 'No reason');
                    const targetConn = activeConnections.get(msg.target);
                    if (targetConn && targetConn.currentServer === currentServer) {
                        const banMsg = { type: 'nexus_system', message: `You were banned from ${server.name}` };
                        if (targetConn.isWeb) targetConn.socket.send(JSON.stringify(banMsg));
                        else targetConn.socket.write(encodeMessage(banMsg));
                        targetConn.currentServer = null;
                        targetConn.currentRoom = null;
                        if (targetConn.isWeb) targetConn.socket.send(JSON.stringify({ type: 'nexus_server_state', serverId: null, roomName: null }));
                        else targetConn.socket.write(encodeMessage({ type: 'nexus_server_state', serverId: null, roomName: null }));
                    }
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Banned ${msg.target}` }));
                }
                
                if (msg.type === 'nexus_unban') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const server = userServers.get(currentServer);
                    const hasPermission = (server.owner === userName || CONFIG.adminUsers.includes(userName));
                    
                    if (!hasPermission) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Only owner can unban' })); 
                        return; 
                    }
                    removeBan(currentServer, msg.target);
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Unbanned ${msg.target}` }));
                }
                
                if (msg.type === 'nexus_add_role') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const server = userServers.get(currentServer);
                    const hasPermission = (server.owner === userName || CONFIG.adminUsers.includes(userName));
                    
                    if (!hasPermission) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Only owner can add ranks' })); 
                        return; 
                    }
                    addRole(currentServer, msg.role_name, msg.color || '#888888', msg.permissions || '', userName);
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Rank created: ${msg.role_name}` }));
                }
                
                if (msg.type === 'nexus_set_role') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const server = userServers.get(currentServer);
                    const hasPermission = (server.owner === userName || CONFIG.adminUsers.includes(userName));
                    
                    if (!hasPermission) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Only owner can assign ranks' })); 
                        return; 
                    }
                    if (serverMembers.get(currentServer).has(msg.target)) { 
                        serverMembers.get(currentServer).get(msg.target).role = msg.role; 
                        db.run('UPDATE nexus_members SET role = ? WHERE server_id = ? AND user_name = ?', [msg.role, currentServer, msg.target]);
                        socket.write(encodeMessage({ type: 'nexus_system', message: `Set ${msg.target}'s rank to ${msg.role}` }));
                    } else {
                        socket.write(encodeMessage({ type: 'nexus_error', message: `User ${msg.target} not found in this Nexus` }));
                    }
                }
                
                if (msg.type === 'nexus_set_nickname') {
                    if (!currentServer) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus. Join a Nexus first with /join <id>' })); 
                        return; 
                    }
                    if (!msg.nickname) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Nickname required' })); return; }
                    
                    if (setUserNickname(currentServer, userName, msg.nickname)) {
                        socket.write(encodeMessage({ type: 'nexus_system', message: `✓ Nickname changed to: ${msg.nickname}` }));
                        if (currentRoom) {
                            broadcastToRoom(currentServer, currentRoom, `${userName} is now known as ${msg.nickname}`, 'system');
                        }
                    } else {
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Failed to set nickname. Make sure you are in a Nexus.' }));
                    }
                }
                
                if (msg.type === 'nexus_list_servers') {
                    const servers = Array.from(userServers.entries()).map(([id, s]) => `${id}: ${s.name} (owner: ${s.owner})`);
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Nexuses: ${servers.join(', ') || 'none'}` }));
                }
                
                if (msg.type === 'nexus_list_rooms') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const rooms = Array.from(serverRooms.get(currentServer));
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Chambers: ${rooms.join(', ')}` }));
                }
                
                if (msg.type === 'nexus_list_users') {
                    if (!currentServer || !currentRoom) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a chamber' })); return; }
                    const usersInRoom = [];
                    for (const [name, conn] of activeConnections) {
                        if (conn.currentServer === currentServer && conn.currentRoom === currentRoom) {
                            const displayName = getDisplayName(currentServer, name);
                            usersInRoom.push(`${displayName}${displayName !== name ? ` (${name})` : ''}`);
                        }
                    }
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Users in ${currentRoom}: ${usersInRoom.join(', ') || 'none'}` }));
                }
                
                if (msg.type === 'nexus_list_members') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const members = serverMembers.get(currentServer);
                    const memberList = Array.from(members.entries()).map(([name, data]) => {
                        const displayName = data.nickname || name;
                        const status = activeConnections.has(name) ? '🟢' : '⚫';
                        return `${status} ${displayName}${displayName !== name ? ` (${name})` : ''} [${data.role}]`;
                    });
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Members (${members.size}): ${memberList.join(', ')}` }));
                }
                
                if (msg.type === 'nexus_list_bans') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const bans = serverBans.get(currentServer);
                    if (bans && bans.size > 0) socket.write(encodeMessage({ type: 'nexus_system', message: `Banned users: ${Array.from(bans.keys()).join(', ')}` }));
                    else socket.write(encodeMessage({ type: 'nexus_system', message: 'No banned users' }));
                }
                
                if (msg.type === 'nexus_list_roles') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const roles = serverRoles.get(currentServer);
                    if (roles && roles.size > 0) socket.write(encodeMessage({ type: 'nexus_system', message: `Ranks: ${Array.from(roles.keys()).join(', ')}` }));
                    else socket.write(encodeMessage({ type: 'nexus_system', message: 'No custom ranks' }));
                }
                
                if (msg.type === 'nexus_server_info') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const server = userServers.get(currentServer);
                    const memberCount = serverMembers.get(currentServer)?.size || 0;
                    const roomCount = serverRooms.get(currentServer)?.size || 0;
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Nexus: ${server.name}\nOwner: ${server.owner}\nCreated: ${new Date(server.createdAt).toLocaleString()}\nMembers: ${memberCount}\nChambers: ${roomCount}` }));
                }
                
                if (msg.type === 'nexus_create_invite') {
                    if (!currentServer) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const server = userServers.get(currentServer);
                    const hasPermission = (server.owner === userName || CONFIG.adminUsers.includes(userName));
                    
                    if (!hasPermission) { 
                        socket.write(encodeMessage({ type: 'nexus_error', message: 'Only owner can create invites' })); 
                        return; 
                    }
                    const code = createInvite(currentServer, userName);
                    socket.write(encodeMessage({ type: 'nexus_system', message: `Invite code: ${code}` }));
                }
                
                if (msg.type === 'nexus_use_invite') {
                    db.get('SELECT * FROM nexus_invites WHERE invite_code = ?', [msg.code], (err, invite) => {
                        if (!invite) { socket.write(encodeMessage({ type: 'nexus_error', message: 'Invalid invite code' })); return; }
                        const result = joinUserServer(userName, invite.server_id);
                        if (result.error) socket.write(encodeMessage({ type: 'nexus_error', message: result.error }));
                        else {
                            currentServer = invite.server_id;
                            updateConnectionState();
                            db.run('UPDATE nexus_invites SET uses = uses + 1 WHERE invite_code = ?', [msg.code]);
                            socket.write(encodeMessage({ type: 'nexus_system', message: `✓ Joined Nexus: ${userServers.get(invite.server_id).name} via invite` }));
                            socket.write(encodeMessage({ type: 'nexus_server_state', serverId: currentServer, serverName: userServers.get(currentServer).name, roomName: currentRoom }));
                            if (serverRooms.get(invite.server_id)?.has('general')) {
                                currentRoom = 'general';
                                updateConnectionState();
                                socket.write(encodeMessage({ type: 'nexus_system', message: `Auto-joined chamber: general` }));
                                socket.write(encodeMessage({ type: 'nexus_room_state', roomName: currentRoom }));
                                broadcastToRoom(currentServer, currentRoom, `${userName} joined the chamber`, 'system');
                            }
                        }
                    });
                }
            } catch (err) { console.log(`Parse error: ${err.message}`); }
        }
    });
    
    socket.on('close', () => {
        if (userName) {
            if (currentRoom && currentServer) broadcastToRoom(currentServer, currentRoom, `${userName} disconnected`, 'system');
            activeConnections.delete(userName);
            console.log(`\x1b[31m[-] ${userName} disconnected\x1b[0m`);
        }
    });
};

const udpSocket = dgram.createSocket('udp4');
const tcpServer = net.createServer();

udpSocket.on('message', (msg, rinfo) => { 
    try { 
        const decoded = cbor.decode(msg); 
        if (decoded.type === 'nexus_ping') { 
            udpSocket.send(cbor.encode({ type: 'nexus_pong', name: decoded.name, ip: rinfo.address, port: CONFIG.port, ttl: 300 }), rinfo.port, rinfo.address); 
        } 
    } catch(e) {} 
});

tcpServer.on('connection', handleTCPConnection);

function startServer() {
    udpSocket.bind(CONFIG.udpPort, CONFIG.bindAddress, () => {
        console.log(`Nexus UDP discovery active on ${CONFIG.bindAddress}:${CONFIG.udpPort}`);
    });
    
    tcpServer.listen(CONFIG.port, CONFIG.bindAddress, () => {
        tcpServerReady = true;
        console.log(`Nexus TCP active on ${CONFIG.bindAddress}:${CONFIG.port}`);
        checkAndShowBanner();
    });
    
    const wss = new WebSocketServer({ port: CONFIG.wsPort });
    global.wss = wss;
    
    wss.on('connection', (ws, req) => {
        let userName = null;
        let currentServer = null;
        let currentRoom = null;
        let loggedInUser = null;
        
        sendServerConfig(ws, true);
        
        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                
                if (msg.type === 'nexus_register') {
                    await registerUser(msg.username, msg.password, ws, true);
                    return;
                }
                
                if (msg.type === 'nexus_login') {
                    const success = await loginUser(msg.username, msg.password, ws, true);
                    if (success) {
                        loggedInUser = msg.username;
                        ws.send(JSON.stringify({ type: 'nexus_login_success', username: msg.username, message: `✓ Login successful! Welcome back ${msg.username}` }));
                        // Auto handshake
                        if (activeConnections.has(msg.username)) {
                            userName = `${msg.username}_${Math.floor(Math.random() * 1000)}`;
                            ws.send(JSON.stringify({ type: 'nexus_system', message: `Username taken. Assigned: ${userName}` }));
                        } else {
                            userName = msg.username;
                        }
                        activeConnections.set(userName, { socket: ws, currentServer: null, currentRoom: null, isWeb: true, loggedInUser: loggedInUser });
                        userColors.set(userName, colorPalette[activeConnections.size % colorPalette.length]);
                        console.log(`\x1b[32m[Web] ${userName} (logged in as: ${loggedInUser}) connected\x1b[0m`);
                        ws.send(JSON.stringify({ type: 'nexus_system', message: CONFIG.motd }));
                    } else {
                        ws.send(JSON.stringify({ type: 'nexus_system', message: '❌ Invalid username or password' }));
                    }
                    return;
                }
                
                if (msg.type === 'nexus_logout') {
                    if (loggedInUser) {
                        loggedInUser = null;
                        userName = null;
                        currentServer = null;
                        currentRoom = null;
                        ws.send(JSON.stringify({ type: 'nexus_system', message: '✓ Logged out successfully' }));
                        ws.send(JSON.stringify({ type: 'nexus_server_state', serverId: null, roomName: null }));
                    } else {
                        ws.send(JSON.stringify({ type: 'nexus_system', message: 'Not logged in' }));
                    }
                    return;
                }
                
                if (msg.type === 'nexus_guest') {
                    let requestedName = msg.name;
                    if (activeConnections.has(requestedName)) {
                        userName = `${requestedName}_${Math.floor(Math.random() * 1000)}`;
                        ws.send(JSON.stringify({ type: 'nexus_system', message: `Username taken. Assigned: ${userName}` }));
                    } else {
                        userName = requestedName;
                    }
                    activeConnections.set(userName, { socket: ws, currentServer: null, currentRoom: null, isWeb: true, loggedInUser: null });
                    userColors.set(userName, colorPalette[activeConnections.size % colorPalette.length]);
                    console.log(`\x1b[32m[Web] ${userName} (guest) connected\x1b[0m`);
                    ws.send(JSON.stringify({ type: 'nexus_system', message: CONFIG.motd }));
                    return;
                }
                
                if (msg.type === 'nexus_create_server') {
                    const { serverId } = createUserServer(userName, msg.server_name);
                    ws.send(JSON.stringify({ type: 'nexus_system', message: `✓ Nexus created! ID: ${serverId}` }));
                }
                
                if (msg.type === 'nexus_delete_server') {
                    if (!currentServer) { ws.send(JSON.stringify({ type: 'nexus_error', message: 'Not in a Nexus' })); return; }
                    const result = deleteUserServer(currentServer, userName, false);
                    if (result.error) ws.send(JSON.stringify({ type: 'nexus_error', message: result.error }));
                    else {
                        ws.send(JSON.stringify({ type: 'nexus_system', message: `✓ Nexus "${result.name}" deleted successfully` }));
                        currentServer = null;
                        currentRoom = null;
                        ws.send(JSON.stringify({ type: 'nexus_server_state', serverId: null, roomName: null }));
                    }
                }
                
                if (msg.type === 'nexus_join_server') {
                    const result = joinUserServer(userName, msg.server_id);
                    if (result.error) ws.send(JSON.stringify({ type: 'nexus_error', message: result.error }));
                    else { 
                        currentServer = msg.server_id;
                        const conn = activeConnections.get(userName);
                        if (conn) conn.currentServer = currentServer;
                        ws.send(JSON.stringify({ type: 'nexus_system', message: `✓ Joined Nexus: ${userServers.get(msg.server_id).name}` }));
                        ws.send(JSON.stringify({ type: 'nexus_server_state', serverId: currentServer, serverName: userServers.get(currentServer).name, roomName: currentRoom }));
                        if (serverRooms.get(msg.server_id)?.has('general')) {
                            currentRoom = 'general';
                            if (conn) conn.currentRoom = currentRoom;
                            ws.send(JSON.stringify({ type: 'nexus_system', message: `Auto-joined chamber: general` }));
                            ws.send(JSON.stringify({ type: 'nexus_room_state', roomName: currentRoom }));
                            broadcastToRoom(currentServer, currentRoom, `${userName} joined the chamber`, 'system');
                        }
                    }
                }
                
                if (msg.type === 'nexus_create_room') {
                    if (!currentServer) { ws.send(JSON.stringify({ type: 'nexus_error', message: 'Not in a Nexus. Use /join <server_id> first' })); return; }
                    if (!msg.room_name) { ws.send(JSON.stringify({ type: 'nexus_error', message: 'Room name required' })); return; }
                    
                    const server = userServers.get(currentServer);
                    if (server.owner !== userName && !CONFIG.adminUsers.includes(userName)) { 
                        ws.send(JSON.stringify({ type: 'nexus_error', message: 'Only Nexus owner can create chambers' })); 
                        return; 
                    }
                    
                    if (serverRooms.get(currentServer).has(msg.room_name)) { 
                        ws.send(JSON.stringify({ type: 'nexus_error', message: 'Chamber already exists' })); 
                        return; 
                    }
                    
                    serverRooms.get(currentServer).add(msg.room_name);
                    db.run('INSERT INTO nexus_rooms (server_id, room_name, created_by, created_at) VALUES (?, ?, ?, ?)', [currentServer, msg.room_name, userName, Date.now()]);
                    ws.send(JSON.stringify({ type: 'nexus_system', message: `✓ Chamber created: ${msg.room_name}` }));
                }
                
                if (msg.type === 'nexus_delete_room') {
                    if (!currentServer) { ws.send(JSON.stringify({ type: 'nexus_error', message: 'Not in a Nexus. Use /join <server_id> first' })); return; }
                    if (!msg.room_name) { ws.send(JSON.stringify({ type: 'nexus_error', message: 'Room name required' })); return; }
                    
                    const server = userServers.get(currentServer);
                    if (server.owner !== userName && !CONFIG.adminUsers.includes(userName)) { 
                        ws.send(JSON.stringify({ type: 'nexus_error', message: 'Only Nexus owner can delete chambers' })); 
                        return; 
                    }
                    
                    if (msg.room_name === 'general') { 
                        ws.send(JSON.stringify({ type: 'nexus_error', message: 'Cannot delete the general chamber' })); 
                        return; 
                    }
                    
                    if (!serverRooms.get(currentServer).has(msg.room_name)) { 
                        ws.send(JSON.stringify({ type: 'nexus_error', message: 'Chamber does not exist' })); 
                        return; 
                    }
                    
                    serverRooms.get(currentServer).delete(msg.room_name);
                    db.run('DELETE FROM nexus_rooms WHERE server_id = ? AND room_name = ?', [currentServer, msg.room_name]);
                    db.run('DELETE FROM nexus_messages WHERE server_id = ? AND room_name = ?', [currentServer, msg.room_name]);
                    
                    if (currentRoom === msg.room_name) {
                        currentRoom = null;
                        ws.send(JSON.stringify({ type: 'nexus_room_state', roomName: null }));
                    }
                    ws.send(JSON.stringify({ type: 'nexus_system', message: `✓ Chamber deleted: ${msg.room_name}` }));
                }
                
                if (msg.type === 'nexus_join_room') {
                    if (!currentServer) { ws.send(JSON.stringify({ type: 'nexus_error', message: 'Not in a Nexus. Use /join <server_id> first' })); return; }
                    if (!msg.room) { ws.send(JSON.stringify({ type: 'nexus_error', message: 'Room name required' })); return; }
                    
                    if (!serverRooms.get(currentServer)?.has(msg.room)) { 
                        ws.send(JSON.stringify({ type: 'nexus_error', message: `Chamber "${msg.room}" does not exist` })); 
                        return; 
                    }
                    
                    if (currentRoom) broadcastToRoom(currentServer, currentRoom, `${userName} left the chamber`, 'system');
                    currentRoom = msg.room;
                    const conn = activeConnections.get(userName);
                    if (conn) conn.currentRoom = currentRoom;
                    ws.send(JSON.stringify({ type: 'nexus_system', message: `Joined chamber: ${currentRoom}` }));
                    ws.send(JSON.stringify({ type: 'nexus_room_state', roomName: currentRoom }));
                    broadcastToRoom(currentServer, currentRoom, `${userName} joined the chamber`, 'system');
                }
                
                if (msg.type === 'nexus_message') {
                    if (!currentServer || !currentRoom) { 
                        ws.send(JSON.stringify({ type: 'nexus_error', message: 'Not in a chamber. Use /joinroom <name> first' })); 
                        return; 
                    }
                    broadcastToRoom(currentServer, currentRoom, msg.message, userName);
                }
                
                if (msg.type === 'nexus_private') {
                    const targetConn = activeConnections.get(msg.target);
                    if (targetConn) {
                        targetConn.socket.send(JSON.stringify({ type: 'nexus_private', from: userName, message: msg.message, timestamp: Date.now(), color: getUserColor(userName) }));
                        ws.send(JSON.stringify({ type: 'nexus_system', message: `Message sent to ${msg.target}` }));
                    } else {
                        db.run('INSERT INTO nexus_offline (recipient_name, sender_name, payload, timestamp) VALUES (?, ?, ?, ?)', [msg.target, userName, Buffer.from(msg.message), Date.now()]);
                        ws.send(JSON.stringify({ type: 'nexus_system', message: `Message stored offline for ${msg.target}` }));
                    }
                }
                
                if (msg.type === 'nexus_set_nickname') {
                    if (!currentServer) { 
                        ws.send(JSON.stringify({ type: 'nexus_error', message: 'Not in a Nexus. Join a Nexus first with /join <id>' })); 
                        return; 
                    }
                    if (!msg.nickname) { ws.send(JSON.stringify({ type: 'nexus_error', message: 'Nickname required' })); return; }
                    
                    if (setUserNickname(currentServer, userName, msg.nickname)) {
                        ws.send(JSON.stringify({ type: 'nexus_system', message: `✓ Nickname changed to: ${msg.nickname}` }));
                        if (currentRoom) {
                            broadcastToRoom(currentServer, currentRoom, `${userName} is now known as ${msg.nickname}`, 'system');
                        }
                    } else {
                        ws.send(JSON.stringify({ type: 'nexus_error', message: 'Failed to set nickname' }));
                    }
                }
                
                if (msg.type === 'nexus_leave_room') {
                    if (currentRoom) {
                        broadcastToRoom(currentServer, currentRoom, `${userName} left the chamber`, 'system');
                        currentRoom = null;
                        const conn = activeConnections.get(userName);
                        if (conn) conn.currentRoom = null;
                        ws.send(JSON.stringify({ type: 'nexus_system', message: 'Left chamber' }));
                        ws.send(JSON.stringify({ type: 'nexus_room_state', roomName: null }));
                    } else {
                        ws.send(JSON.stringify({ type: 'nexus_error', message: 'Not in a chamber' }));
                    }
                }
            } catch(e) { console.log('Web parse error:', e); }
        });
        
        ws.on('close', () => {
            if (userName) {
                if (currentRoom && currentServer) broadcastToRoom(currentServer, currentRoom, `${userName} disconnected`, 'system');
                activeConnections.delete(userName);
                console.log(`\x1b[31m[Web] ${userName} disconnected\x1b[0m`);
            }
        });
    });
    
    wss.on('listening', () => {
        wssReady = true;
        console.log(`Nexus WebSocket active on port ${CONFIG.wsPort}`);
        checkAndShowBanner();
    });
}

function checkAndShowBanner() {
    if (tcpServerReady && wssReady) {
        console.log(`\x1b[36m╔═══════════════════════════════════════════════════════════════════╗
║                    NEXUS PROTOCOL v1.6 - STREAMLINED                        ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Server:   ${CONFIG.serverName.padEnd(55)}║
║  Version:  ${CONFIG.protocolVersion.padEnd(55)}║
╠═══════════════════════════════════════════════════════════════════════╣
║  TCP: ${CONFIG.bindAddress}:${CONFIG.port}  |  WebSocket: ${CONFIG.bindAddress}:${CONFIG.wsPort}  ║
║  UDP: ${CONFIG.bindAddress}:${CONFIG.udpPort} (Discovery)                       ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Console Commands:                                                       ║
║  /help        - Show console commands                                    ║
║  /join <room> - Join a room as console (view messages)                   ║
║  /leave       - Leave current console room                               ║
║  /msg <user>  - Send private message from console                        ║
║  /broadcast   - Send message to all users                                ║
║  /status      - Show server status                                       ║
║  /list        - List all connected users                                 ║
║  /list_servers - List all Nexuses                                        ║
║  /delete_server <id> - Delete a Nexus (admin only)                       ║
║  /kick <user> - Disconnect a user                                        ║
║  /exit        - Shutdown server                                          ║
╚═══════════════════════════════════════════════════════════════════════╝
\x1b[0m`);
        
        setupConsole();
    }
}

function setupConsole() {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\x1b[36mNEXUS>\x1b[0m ' });
    
    rl.on('line', (line) => {
        const input = line.trim();
        
        if (consoleInRoom && !input.startsWith('/') && input.length > 0) {
            let found = false;
            for (const [serverId, rooms] of serverRooms) {
                if (rooms.has(consoleInRoom)) {
                    broadcastToRoom(serverId, consoleInRoom, input, 'SERVER');
                    found = true;
                    break;
                }
            }
            if (!found) {
                console.log(`\x1b[31mRoom "${consoleInRoom}" not found in any Nexus\x1b[0m`);
            }
            rl.prompt();
            return;
        }
        
        if (input.startsWith('/')) {
            const parts = input.slice(1).split(' ');
            const cmd = parts[0].toLowerCase();
            const args = parts.slice(1);
            
            if (cmd === 'help') {
                console.log(`\x1b[33mConsole Commands:
  /help                - Show this help
  /join <room>         - Join a room to monitor and chat as SERVER
  /leave               - Leave current monitored room
  /msg <user> <msg>    - Send private message as SERVER
  /broadcast <msg>     - Send message to all connected users
  /status              - Show server status
  /list                - List all connected users
  /list_servers        - List all Nexuses
  /delete_server <id>  - Delete a Nexus by ID (admin only)
  /kick <user>         - Disconnect a user
  /exit                - Shutdown server\x1b[0m`);
            } else if (cmd === 'join') {
                if (args[0]) {
                    consoleInRoom = args[0];
                    console.log(`\x1b[32m✓ Joined room: ${args[0]}\x1b[0m`);
                    console.log(`\x1b[33mYou can now type messages directly to chat in this room!\x1b[0m`);
                } else console.log('\x1b[31mUsage: /join <roomname>\x1b[0m');
            } else if (cmd === 'leave') {
                if (consoleInRoom) {
                    console.log(`\x1b[33mLeft room: ${consoleInRoom}\x1b[0m`);
                    consoleInRoom = null;
                } else console.log('\x1b[31mNot in any room\x1b[0m');
            } else if (cmd === 'msg') {
                if (args.length >= 2) {
                    const to = args[0];
                    const message = args.slice(1).join(' ');
                    const targetConn = activeConnections.get(to);
                    if (targetConn) {
                        const pmMsg = { type: 'nexus_private', from: 'SERVER', message: message, timestamp: Date.now(), color: '#FFFFFF' };
                        if (targetConn.isWeb) targetConn.socket.send(JSON.stringify(pmMsg));
                        else targetConn.socket.write(encodeMessage(pmMsg));
                        console.log(`\x1b[32m✓ Message sent to ${to}\x1b[0m`);
                    } else console.log(`\x1b[31mUser ${to} not connected\x1b[0m`);
                } else console.log('\x1b[31mUsage: /msg <user> <message>\x1b[0m');
            } else if (cmd === 'broadcast') {
                if (args.length >= 1) {
                    const message = args.join(' ');
                    let count = 0;
                    for (const [name, conn] of activeConnections) {
                        if (conn.socket && !conn.socket.destroyed) {
                            try {
                                const broadcastMsg = { type: 'nexus_system', message: `[SERVER BROADCAST] ${message}` };
                                if (conn.isWeb) conn.socket.send(JSON.stringify(broadcastMsg));
                                else conn.socket.write(encodeMessage(broadcastMsg));
                                count++;
                            } catch(e) {}
                        }
                    }
                    console.log(`\x1b[32m✓ Broadcast sent to ${count} users\x1b[0m`);
                } else console.log('\x1b[31mUsage: /broadcast <message>\x1b[0m');
            } else if (cmd === 'status') {
                console.log(`\x1b[36mServer Status:
  Users: ${activeConnections.size}
  Nexuses: ${userServers.size}
  Uptime: ${Math.floor(process.uptime())} seconds\x1b[0m`);
                console.log(`\x1b[36mActive connections:\x1b[0m`);
                for (const [name, conn] of activeConnections) {
                    console.log(`  ${name}: Server=${conn.currentServer || 'none'}, Room=${conn.currentRoom || 'none'}, Web=${conn.isWeb}, LoggedIn=${conn.loggedInUser || 'guest'}`);
                }
            } else if (cmd === 'list') {
                console.log(`\x1b[36mConnected users (${activeConnections.size}):\x1b[0m`);
                for (const [name, data] of activeConnections) {
                    const type = data.isWeb ? '[WEB]' : '[TCP]';
                    const serverInfo = data.currentServer ? ` @ ${userServers.get(data.currentServer)?.name || data.currentServer}` : '';
                    const roomInfo = data.currentRoom ? ` #${data.currentRoom}` : '';
                    const loginInfo = data.loggedInUser ? ` (as: ${data.loggedInUser})` : ' (guest)';
                    console.log(`  ${type} ${name}${loginInfo}${serverInfo}${roomInfo}`);
                }
            } else if (cmd === 'list_servers') {
                if (userServers.size === 0) console.log('No Nexuses created yet');
                else {
                    for (const [id, server] of userServers) {
                        const memberCount = serverMembers.get(id)?.size || 0;
                        const roomCount = serverRooms.get(id)?.size || 0;
                        console.log(`${id}: ${server.name} (owner: ${server.owner}, members: ${memberCount}, rooms: ${roomCount})`);
                    }
                }
            } else if (cmd === 'delete_server') {
                if (!args[0]) { console.log('\x1b[31mUsage: /delete_server <server_id>\x1b[0m'); return; }
                const result = deleteUserServer(args[0], 'CONSOLE', true);
                if (result.error) console.log(`\x1b[31m${result.error}\x1b[0m`);
                else console.log(`\x1b[32m✓ Nexus "${result.name}" deleted successfully\x1b[0m`);
            } else if (cmd === 'kick') {
                if (args[0]) {
                    const targetConn = activeConnections.get(args[0]);
                    if (targetConn) {
                        const kickMsg = { type: 'nexus_system', message: 'You were kicked by server admin' };
                        if (targetConn.isWeb) targetConn.socket.send(JSON.stringify(kickMsg));
                        else targetConn.socket.write(encodeMessage(kickMsg));
                        targetConn.socket.destroy();
                        console.log(`\x1b[33mKicked user: ${args[0]}\x1b[0m`);
                    } else console.log(`\x1b[31mUser ${args[0]} not found\x1b[0m`);
                } else console.log('\x1b[31mUsage: /kick <user>\x1b[0m');
            } else if (cmd === 'exit') {
                console.log('\x1b[33mShutting down...\x1b[0m');
                process.exit(0);
            } else {
                console.log(`\x1b[31mUnknown command: ${cmd}. Type /help\x1b[0m`);
            }
        }
        rl.prompt();
    });
    
    rl.on('SIGINT', () => process.exit(0));
    rl.prompt();
}

db.serialize(() => {
    db.all('SELECT * FROM nexus_servers', [], (err, rows) => {
        if (err) {
            console.error('Error loading servers:', err);
            startServer();
            return;
        }
        if (rows) {
            rows.forEach(row => {
                userServers.set(row.server_id, {
                    owner: row.owner,
                    name: row.server_name,
                    createdAt: row.created_at
                });
                serverRooms.set(row.server_id, new Set());
            });
        }
        
        db.all('SELECT * FROM nexus_rooms', [], (err, rows) => {
            if (rows) {
                rows.forEach(row => {
                    if (serverRooms.has(row.server_id)) serverRooms.get(row.server_id).add(row.room_name);
                });
            }
            
            db.all('SELECT * FROM nexus_members', [], (err, rows) => {
                if (rows) {
                    rows.forEach(row => {
                        if (!serverMembers.has(row.server_id)) serverMembers.set(row.server_id, new Map());
                        serverMembers.get(row.server_id).set(row.user_name, { 
                            role: row.role, 
                            joinedAt: row.joined_at, 
                            nickname: row.nickname 
                        });
                    });
                }
                
                db.all('SELECT * FROM nexus_bans', [], (err, rows) => {
                    if (rows) {
                        rows.forEach(row => {
                            if (!serverBans.has(row.server_id)) serverBans.set(row.server_id, new Map());
                            serverBans.get(row.server_id).set(row.banned_user, { 
                                banned_by: row.banned_by, 
                                reason: row.reason, 
                                time: row.banned_at 
                            });
                        });
                    }
                    
                    db.all('SELECT * FROM nexus_roles', [], (err, rows) => {
                        if (rows) {
                            rows.forEach(row => {
                                if (!serverRoles.has(row.server_id)) serverRoles.set(row.server_id, new Map());
                                serverRoles.get(row.server_id).set(row.role_name, { 
                                    color: row.color, 
                                    permissions: row.permissions, 
                                    createdBy: row.created_by 
                                });
                            });
                        }
                        
                        startServer();
                    });
                });
            });
        });
    });
});
