'use strict';

const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'storage.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let state = { tickets: {}, stickyMessages: {} };
try {
  if (fs.existsSync(dataFile)) {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    state = {
      tickets: parsed.tickets || {},
      stickyMessages: parsed.stickyMessages || {}
    };
  }
} catch (_) {}

function save() {
  fs.writeFileSync(dataFile, JSON.stringify(state));
}

function getTicket(channelId) { return state.tickets[channelId] || null; }
function setTicket(channelId, ticket) { state.tickets[channelId] = ticket; save(); }
function deleteTicket(channelId) { delete state.tickets[channelId]; save(); }
function getSticky(channelId) { return state.stickyMessages[channelId] || null; }
function setSticky(channelId, messageId) { state.stickyMessages[channelId] = messageId; save(); }

module.exports = { getTicket, setTicket, deleteTicket, getSticky, setSticky };
