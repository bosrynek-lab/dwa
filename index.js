'use strict';

const WebSocket = require('ws');
const fs = require('node:fs');
const { loadEnv } = require('./env');
loadEnv();

const config = require('../config.json');
const storage = require('./storage');
const ui = require('./ui');

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const API = 'https://discord.com/api/v10';

if (!token) {
  console.error('Brak DISCORD_TOKEN. Wpisz go w zmiennych środowiskowych ACLClouds lub w pliku .env.');
  process.exit(1);
}
if (!guildId) {
  console.error('Brak GUILD_ID. Wpisz ID serwera w zmiennych środowiskowych ACLClouds lub w pliku .env.');
  process.exit(1);
}

const Bits = {
  Administrator: 8n,
  ManageChannels: 16n,
  ViewChannel: 1024n,
  SendMessages: 2048n,
  ManageMessages: 8192n,
  EmbedLinks: 16384n,
  AttachFiles: 32768n,
  ReadMessageHistory: 65536n
};

const I = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ModalSubmit: 5,
  Button: 2,
  StringSelect: 3,
  Pong: 1,
  ChannelMessage: 4,
  DeferredChannelMessage: 5,
  DeferredUpdateMessage: 6,
  UpdateMessage: 7,
  Modal: 9,
  Ephemeral: 64
};

const intents = (1 << 0) | (1 << 9); // Guilds + GuildMessages. MessageContent NIE jest potrzebny.
let botUser = null;
let applicationId = null;
let seq = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let ws = null;
let emojiMap = new Map();
const stickyTimers = new Map();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function apiRequest(method, route, body, extraHeaders = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    if (res.status === 429) {
      let retry = 1;
      try { retry = Number((await res.json()).retry_after || 1); } catch (_) {}
      await sleep(Math.ceil(retry * 1000) + 100);
      continue;
    }

    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch (_) { return text; } })() : null;
    if (!res.ok) {
      const err = new Error(`Discord API ${res.status} ${method} ${route}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error(`Przekroczono liczbę prób Discord API: ${method} ${route}`);
}

async function apiMultipart(method, route, payload) {
  const files = payload.files || [];
  const json = { ...payload };
  delete json.files;

  if (!files.length) return apiRequest(method, route, json);

  json.attachments = files.map((file, id) => ({ id, filename: file.name }));
  const form = new FormData();
  form.append('payload_json', JSON.stringify(json));
  files.forEach((file, id) => {
    const bytes = fs.readFileSync(file.path);
    form.append(`files[${id}]`, new Blob([bytes]), file.name);
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: { Authorization: `Bot ${token}` },
      body: form
    });
    if (res.status === 429) {
      let retry = 1;
      try { retry = Number((await res.json()).retry_after || 1); } catch (_) {}
      await sleep(Math.ceil(retry * 1000) + 100);
      continue;
    }
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch (_) { return text; } })() : null;
    if (!res.ok) throw new Error(`Discord API ${res.status} ${method} ${route}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    return data;
  }
  throw new Error(`Przekroczono liczbę prób uploadu: ${method} ${route}`);
}

function sendMessage(channelId, payload) {
  return apiMultipart('POST', `/channels/${channelId}/messages`, payload);
}
function editMessage(channelId, messageId, payload) {
  return apiRequest('PATCH', `/channels/${channelId}/messages/${messageId}`, payload);
}
function deleteMessage(channelId, messageId) {
  return apiRequest('DELETE', `/channels/${channelId}/messages/${messageId}`);
}

function interactionCallback(interaction, type, data) {
  return apiRequest('POST', `/interactions/${interaction.id}/${interaction.token}/callback`, data === undefined ? { type } : { type, data });
}
function replyEphemeral(interaction, content, components = [], embeds = []) {
  return interactionCallback(interaction, I.ChannelMessage, { content, components, embeds, flags: I.Ephemeral });
}
function deferEphemeral(interaction) {
  return interactionCallback(interaction, I.DeferredChannelMessage, { flags: I.Ephemeral });
}
function deferUpdate(interaction) {
  return interactionCallback(interaction, I.DeferredUpdateMessage);
}
function updateComponentMessage(interaction, data) {
  return interactionCallback(interaction, I.UpdateMessage, data);
}
function showModal(interaction, modal) {
  return interactionCallback(interaction, I.Modal, modal);
}
function editOriginal(interaction, data) {
  return apiRequest('PATCH', `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, data);
}

function isStaff(member) {
  if (!member) return false;
  try {
    const perms = BigInt(member.permissions || '0');
    if ((perms & Bits.Administrator) === Bits.Administrator) return true;
  } catch (_) {}
  const roles = config.ticket?.staffRoleIds || [];
  return roles.some(roleId => (member.roles || []).includes(roleId));
}

function cleanChannelName(input) {
  return String(input || 'user')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'user';
}

function randomTicketId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function allow(...bits) { return bits.reduce((a, b) => a | b, 0n).toString(); }

function modalValue(interaction, customId) {
  for (const row of interaction.data?.components || []) {
    for (const c of row.components || []) {
      if (c.custom_id === customId) return String(c.value || '');
    }
  }
  return '';
}

function optionValue(interaction, name) {
  const stack = [...(interaction.data?.options || [])];
  while (stack.length) {
    const o = stack.shift();
    if (o.name === name) return o.value;
    if (o.options) stack.push(...o.options);
  }
  return null;
}

function interactionUser(interaction) {
  return interaction.member?.user || interaction.user || null;
}

function cacheEmojis(emojis) {
  for (const e of emojis || []) {
    if (e?.name && e?.id) emojiMap.set(e.name, { id: e.id, name: e.name, animated: Boolean(e.animated) });
  }
  ui.setEmojiMap(emojiMap);
}

async function registerCommands() {
  const commands = [
    {
      name: 'panel-ticket',
      description: 'Wysyła panel do tworzenia ticketów.',
      type: 1,
      default_member_permissions: '32',
      options: [{ name: 'kanal', description: 'Kanał, na który wysłać panel', type: 7, channel_types: [0], required: true }]
    },
    {
      name: 'panel-produkty',
      description: 'Wysyła panel produktów/cennika.',
      type: 1,
      default_member_permissions: '32',
      options: [{ name: 'kanal', description: 'Kanał, na który wysłać panel', type: 7, channel_types: [0], required: true }]
    },
    {
      name: 'sticky-legit',
      description: 'Ustawia sticky message z wzorem +rep.',
      type: 1,
      default_member_permissions: '32',
      options: [{ name: 'kanal', description: 'Kanał legit-check', type: 7, channel_types: [0], required: true }]
    }
  ];
  await apiRequest('PUT', `/applications/${applicationId}/guilds/${guildId}/commands`, commands);
  console.log(`Zarejestrowano ${commands.length} komendy slash.`);
}

async function sendSticky(channelId) {
  const oldId = storage.getSticky(channelId);
  if (oldId) await deleteMessage(channelId, oldId).catch(() => null);
  const msg = await sendMessage(channelId, ui.legitPayload());
  storage.setSticky(channelId, msg.id);
  return msg;
}

async function updateTicketMessage(channelId, ticket) {
  if (!ticket?.messageId) return;
  try {
    const user = await apiRequest('GET', `/users/${ticket.ownerId}`);
    await editMessage(channelId, ticket.messageId, ui.ticketChannelPayload({
      user,
      ticketId: ticket.ticketId,
      item: ticket.item,
      amount: ticket.amount,
      payment: ticket.payment,
      claimedBy: ticket.claimedBy
    }));
  } catch (err) {
    console.warn('Nie udało się zaktualizować ticketa:', err.message);
  }
}

async function createDm(userId) {
  return apiRequest('POST', '/users/@me/channels', { recipient_id: userId });
}

async function handleCommand(interaction) {
  const channelId = optionValue(interaction, 'kanal');
  if (!channelId) return replyEphemeral(interaction, 'Nie wybrano kanału.');

  await deferEphemeral(interaction);
  if (interaction.data.name === 'panel-ticket') {
    await sendMessage(channelId, ui.ticketPanelPayload());
    return editOriginal(interaction, { content: `Panel ticketów wysłany na <#${channelId}>.` });
  }
  if (interaction.data.name === 'panel-produkty') {
    await sendMessage(channelId, ui.productsPayload());
    return editOriginal(interaction, { content: `Panel produktów wysłany na <#${channelId}>.` });
  }
  if (interaction.data.name === 'sticky-legit') {
    await sendSticky(channelId);
    return editOriginal(interaction, { content: `Sticky legit-check ustawiony na <#${channelId}>.` });
  }
  return editOriginal(interaction, { content: 'Nieznana komenda.' });
}

async function handleButton(interaction) {
  const id = interaction.data.custom_id;

  if (id === 'ticket:create') return showModal(interaction, ui.purchaseModal());

  if (id === 'ticket:claim') {
    if (!isStaff(interaction.member)) return replyEphemeral(interaction, 'Tylko administrator lub seller może przejąć ticketa.');
    await deferEphemeral(interaction);
    const ticket = storage.getTicket(interaction.channel_id);
    if (!ticket) return editOriginal(interaction, { content: 'Nie znaleziono danych tego ticketa.' });
    if (ticket.claimedBy) return editOriginal(interaction, { content: 'Ten ticket został już przejęty.' });
    ticket.claimedBy = interactionUser(interaction).id;
    storage.setTicket(interaction.channel_id, ticket);
    await updateTicketMessage(interaction.channel_id, ticket);
    return editOriginal(interaction, { content: `Ticket przejęty przez <@${ticket.claimedBy}>.` });
  }

  if (id === 'ticket:close') {
    if (!isStaff(interaction.member)) return replyEphemeral(interaction, 'Tylko administrator lub seller może zamknąć ticketa.');
    if (!storage.getTicket(interaction.channel_id)) return replyEphemeral(interaction, 'Nie znaleziono danych tego ticketa.');
    return replyEphemeral(interaction, 'Na pewno zamknąć ten ticket?', ui.closeConfirmComponents());
  }

  if (id === 'ticket:close-cancel') {
    return updateComponentMessage(interaction, { content: 'Anulowano zamykanie ticketa.', components: [], embeds: [] });
  }

  if (id === 'ticket:close-confirm') {
    if (!isStaff(interaction.member)) return replyEphemeral(interaction, 'Brak uprawnień.');
    const ticket = storage.getTicket(interaction.channel_id);
    if (!ticket) return updateComponentMessage(interaction, { content: 'Nie znaleziono danych tego ticketa.', components: [], embeds: [] });

    await deferUpdate(interaction);
    const delay = Number(config.ticket?.closeDelaySeconds || 5);
    let dmSent = false;
    try {
      const owner = await apiRequest('GET', `/users/${ticket.ownerId}`);
      const dm = await createDm(ticket.ownerId);
      await sendMessage(dm.id, ui.ticketClosedDmPayload({
        user: owner,
        ticketId: ticket.ticketId,
        item: ticket.item,
        amount: ticket.amount,
        payment: ticket.payment,
        closedBy: interactionUser(interaction).id,
        closedAt: new Date()
      }));
      dmSent = true;
    } catch (err) {
      console.warn(`DM ticketa ${ticket.ticketId}:`, err.message);
    }

    await editOriginal(interaction, {
      content: dmSent
        ? `Wiadomość prywatna została wysłana. Ticket zostanie zamknięty za ${delay} s.`
        : `Nie udało się wysłać wiadomości prywatnej. Ticket zostanie zamknięty za ${delay} s.`,
      components: [],
      embeds: []
    }).catch(() => null);

    storage.deleteTicket(interaction.channel_id);
    setTimeout(() => apiRequest('DELETE', `/channels/${interaction.channel_id}`).catch(() => null), delay * 1000);
    return;
  }

  if (id === 'ticket:settings') {
    if (!isStaff(interaction.member)) return replyEphemeral(interaction, 'Tylko administrator lub seller może używać ustawień ticketa.');
    return replyEphemeral(interaction, 'Ustawienia ticketa:', ui.settingsComponents());
  }

  if (id === 'ticket:rename') {
    if (!isStaff(interaction.member)) return replyEphemeral(interaction, 'Brak uprawnień.');
    return showModal(interaction, ui.oneInputModal('ticket:rename-modal', 'Zmień nazwę ticketa', 'ticket:new-name', 'Nowa nazwa kanału', 'np. ticket-robux', 90));
  }

  if (id === 'ticket:add-user' || id === 'ticket:remove-user') {
    if (!isStaff(interaction.member)) return replyEphemeral(interaction, 'Brak uprawnień.');
    const adding = id === 'ticket:add-user';
    return showModal(interaction, ui.oneInputModal(
      adding ? 'ticket:add-user-modal' : 'ticket:remove-user-modal',
      adding ? 'Dodaj użytkownika' : 'Usuń użytkownika',
      'ticket:user-id',
      'ID użytkownika',
      'Wklej ID użytkownika Discord',
      30
    ));
  }

  if (id === 'products:open') {
    const payload = ui.productsSelectPayload();
    return interactionCallback(interaction, I.ChannelMessage, { ...payload, flags: I.Ephemeral });
  }
}

async function handleModal(interaction) {
  const id = interaction.data.custom_id;
  const user = interactionUser(interaction);

  if (id === 'ticket:modal') {
    await deferEphemeral(interaction);
    const item = modalValue(interaction, 'ticket:item').trim();
    const amount = modalValue(interaction, 'ticket:amount').trim();
    const payment = modalValue(interaction, 'ticket:payment').trim();

    const overwrites = [
      { id: interaction.guild_id, type: 0, deny: Bits.ViewChannel.toString(), allow: '0' },
      { id: user.id, type: 1, deny: '0', allow: allow(Bits.ViewChannel, Bits.SendMessages, Bits.ReadMessageHistory, Bits.AttachFiles, Bits.EmbedLinks) },
      { id: botUser.id, type: 1, deny: '0', allow: allow(Bits.ViewChannel, Bits.SendMessages, Bits.ReadMessageHistory, Bits.ManageChannels, Bits.ManageMessages) }
    ];
    for (const roleId of (config.ticket?.staffRoleIds || []).filter(Boolean)) {
      overwrites.push({ id: roleId, type: 0, deny: '0', allow: allow(Bits.ViewChannel, Bits.SendMessages, Bits.ReadMessageHistory, Bits.ManageMessages) });
    }

    const body = {
      name: `${config.ticket?.channelPrefix || 'ticket'}-${cleanChannelName(user.username)}`,
      type: 0,
      topic: `Ticket użytkownika ${user.id}`,
      permission_overwrites: overwrites
    };
    if (config.ticket?.categoryId) body.parent_id = config.ticket.categoryId;

    const channel = await apiRequest('POST', `/guilds/${interaction.guild_id}/channels`, body);
    const ticketId = randomTicketId();
    const ticket = { ticketId, ownerId: user.id, item, amount, payment, claimedBy: null, createdAt: Date.now(), messageId: null };
    const msg = await sendMessage(channel.id, ui.ticketChannelPayload({ user, ticketId, item, amount, payment }));
    ticket.messageId = msg.id;
    storage.setTicket(channel.id, ticket);
    return editOriginal(interaction, ui.ticketCreatedPayload(channel.id));
  }

  if (id === 'ticket:rename-modal') {
    if (!isStaff(interaction.member)) return replyEphemeral(interaction, 'Brak uprawnień.');
    await deferEphemeral(interaction);
    const newName = cleanChannelName(modalValue(interaction, 'ticket:new-name'));
    await apiRequest('PATCH', `/channels/${interaction.channel_id}`, { name: newName });
    return editOriginal(interaction, { content: `Nazwa kanału została zmieniona na **${newName}**.` });
  }

  if (id === 'ticket:add-user-modal' || id === 'ticket:remove-user-modal') {
    if (!isStaff(interaction.member)) return replyEphemeral(interaction, 'Brak uprawnień.');
    await deferEphemeral(interaction);
    const userId = modalValue(interaction, 'ticket:user-id').replace(/\D/g, '');
    if (!userId) return editOriginal(interaction, { content: 'Nieprawidłowe ID użytkownika.' });
    const adding = id === 'ticket:add-user-modal';

    if (adding) {
      await apiRequest('PUT', `/channels/${interaction.channel_id}/permissions/${userId}`, {
        type: 1,
        allow: allow(Bits.ViewChannel, Bits.SendMessages, Bits.ReadMessageHistory),
        deny: '0'
      });
      return editOriginal(interaction, { content: `Dodano <@${userId}> do ticketa.` });
    }

    const ticket = storage.getTicket(interaction.channel_id);
    if (ticket?.ownerId === userId) return editOriginal(interaction, { content: 'Nie można usunąć właściciela ticketa.' });
    await apiRequest('DELETE', `/channels/${interaction.channel_id}/permissions/${userId}`).catch(() => null);
    return editOriginal(interaction, { content: `Usunięto <@${userId}> z ticketa.` });
  }
}

async function handleSelect(interaction) {
  if (interaction.data.custom_id !== 'products:select') return;
  const category = interaction.data.values?.[0];
  const channelId = config.products?.[category] || '';
  return updateComponentMessage(interaction, ui.productResultPayload(category, channelId, interaction.guild_id));
}

async function handleInteraction(interaction) {
  try {
    if (interaction.type === I.Ping) return interactionCallback(interaction, I.Pong);
    if (interaction.type === I.ApplicationCommand) return handleCommand(interaction);
    if (interaction.type === I.ModalSubmit) return handleModal(interaction);
    if (interaction.type === I.MessageComponent) {
      if (interaction.data.component_type === I.Button) return handleButton(interaction);
      if (interaction.data.component_type === I.StringSelect) return handleSelect(interaction);
    }
  } catch (err) {
    console.error('Błąd interakcji:', err.message);
    // Jeżeli interakcja nie została jeszcze potwierdzona, spróbuj wysłać prosty błąd.
    await replyEphemeral(interaction, 'Wystąpił błąd podczas wykonywania tej akcji.').catch(() => null);
  }
}

function scheduleSticky(channelId) {
  if (!config.sticky?.enabledByDefault || !config.sticky?.refreshOnEveryMessage) return;
  if (!config.sticky?.channelId || channelId !== config.sticky.channelId) return;
  if (stickyTimers.has(channelId)) clearTimeout(stickyTimers.get(channelId));
  const timer = setTimeout(() => {
    stickyTimers.delete(channelId);
    sendSticky(channelId).catch(err => console.warn('Sticky:', err.message));
  }, 1200);
  stickyTimers.set(channelId, timer);
}

async function onDispatch(t, d) {
  if (t === 'READY') {
    botUser = d.user;
    applicationId = d.application?.id || d.user.id;
    console.log(`Zalogowano jako ${botUser.username} (${botUser.id})`);
    try { await registerCommands(); } catch (err) { console.error('Rejestracja komend:', err.message); }
    if (config.sticky?.enabledByDefault && config.sticky?.sendOnStartup && config.sticky?.channelId) {
      setTimeout(() => sendSticky(config.sticky.channelId).catch(err => console.warn('Sticky start:', err.message)), 2500);
    }
    return;
  }

  if (t === 'GUILD_CREATE' && d.id === guildId) {
    emojiMap = new Map();
    cacheEmojis(d.emojis || []);
    console.log(`Wczytano ${emojiMap.size} emotek serwera.`);
    return;
  }

  if (t === 'GUILD_EMOJIS_UPDATE' && d.guild_id === guildId) {
    emojiMap = new Map();
    cacheEmojis(d.emojis || []);
    return;
  }

  if (t === 'INTERACTION_CREATE') return handleInteraction(d);

  if (t === 'MESSAGE_CREATE') {
    if (d.author?.bot || !d.guild_id) return;
    scheduleSticky(d.channel_id);
  }
}

async function gatewayUrl() {
  const data = await apiRequest('GET', '/gateway/bot');
  return `${data.url}/?v=10&encoding=json`;
}

async function connectGateway() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    const url = await gatewayUrl();
    ws = new WebSocket(url);

    ws.on('open', () => console.log('Połączono z Discord Gateway.'));

    ws.on('message', raw => {
      try {
        const packet = JSON.parse(raw.toString());
        if (packet.s !== null && packet.s !== undefined) seq = packet.s;

        if (packet.op === 10) {
          const interval = packet.d.heartbeat_interval;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: seq }));
          }, interval);

          ws.send(JSON.stringify({
            op: 2,
            d: {
              token,
              intents,
              properties: { os: process.platform, browser: 'rynek-shop-lite', device: 'rynek-shop-lite' },
              presence: { status: 'online', afk: false, activities: [{ name: 'Rynek Shop', type: 3 }] }
            }
          }));
          return;
        }

        if (packet.op === 7 || packet.op === 9) {
          try { ws.close(); } catch (_) {}
          return;
        }

        if (packet.op === 0) onDispatch(packet.t, packet.d).catch(err => console.error('Dispatch:', err.message));
      } catch (err) {
        console.error('Gateway packet:', err.message);
      }
    });

    ws.on('error', err => console.warn('Gateway error:', err.message));
    ws.on('close', code => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      console.warn(`Gateway rozłączony (${code}). Ponawiam za 5 s...`);
      reconnectTimer = setTimeout(connectGateway, 5000);
    });
  } catch (err) {
    console.error('Nie udało się połączyć z Gateway:', err.message);
    reconnectTimer = setTimeout(connectGateway, 5000);
  }
}

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message || err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err?.message || err));

connectGateway();
