'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.json');

const C = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
  Link: 5,
  Short: 1
};

let emojiMap = new Map();
function setEmojiMap(map) { emojiMap = map || new Map(); }
function customEmoji(name) { return emojiMap.get(name) || null; }
function emojiText(name, fallback) {
  const e = customEmoji(name);
  return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : fallback;
}
function componentEmoji(name, fallback) {
  const e = customEmoji(name);
  return e ? { id: e.id, name: e.name, animated: Boolean(e.animated) } : { name: fallback };
}

function color() {
  const raw = String(config.themeColor || '#3498DB').replace('#', '');
  return Number.parseInt(raw, 16) || 0x3498DB;
}

function asset(key, fileName) {
  const rel = config.assets?.[key];
  if (!rel) return null;
  const full = path.join(__dirname, '..', rel);
  if (!fs.existsSync(full)) return null;
  return { path: full, name: fileName };
}

function withImage(embed, key, fileName) {
  const file = asset(key, fileName);
  if (!file) return { embeds: [embed] };
  embed.image = { url: `attachment://${fileName}` };
  return { embeds: [embed], files: [file] };
}

function footer(label) {
  return { text: `${emojiText('71334shop', '🛒')} © 2026 ${config.brandName} × ${label}` };
}

function button(customId, label, style, emojiName, fallback, disabled = false) {
  return {
    type: C.Button,
    custom_id: customId,
    label,
    style,
    emoji: componentEmoji(emojiName, fallback),
    disabled
  };
}

function ticketPanelPayload() {
  const shop = emojiText('71334shop', '🛒');
  const arrow = emojiText('259419darkbluearrow', '»');
  const embed = {
    color: color(),
    title: `🌊  ·  RYNEK SHOP × TICKETY`,
    description: [
      `${shop}  ·  **Chcesz zakupić przedmiot lub potrzebujesz pomocy?**`,
      `${arrow}  ·  Wybierz przycisk poniżej, uzupełnij formularz, a utworzymy dla Ciebie prywatny ticket.`,
      '',
      `🌊  ·  W formularzu podasz: **co chcesz zakupić, kwotę i metodę płatności.**`
    ].join('\n'),
    footer: footer('Panel Ticketów')
  };
  const payload = withImage(embed, 'ticketBanner', 'ticket-banner.jpg');
  payload.components = [{
    type: C.ActionRow,
    components: [button('ticket:create', 'Utwórz ticket', C.Primary, '71334shop', '🛒')]
  }];
  return payload;
}

function ticketCreatedPayload(channelId) {
  return {
    embeds: [{
      color: color(),
      title: `${emojiText('40197checkmarkids', '✅')}  ·  Sukces!`,
      description: `**Sukces!** Twój ticket został utworzony, znajdziesz go na <#${channelId}>.`,
      footer: footer('Sukces')
    }]
  };
}

function avatarUrl(user) {
  if (user?.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`;
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function ticketChannelPayload({ user, ticketId, item, amount, payment, claimedBy = null }) {
  const clientIcon = emojiText('klient_2', '👤');
  const priceIcon = emojiText('cena', '🏷️');
  const payIcon = emojiText('platnosc_2', '💳');
  const embed = {
    color: color(),
    title: `🌊  ·  RYNEK SHOP × POMOC`,
    thumbnail: { url: avatarUrl(user) },
    fields: [
      {
        name: `${clientIcon}  ·  Informacje o użytkowniku`,
        value: [`› **Ping:** <@${user.id}>`, `› **TAG:** ${user.global_name || user.username}`, `› **ID:** \`${user.id}\``].join('\n')
      },
      {
        name: `ℹ️  ·  Informacje o tickecie`,
        value: [
          `› **ID Ticketa:** \`${ticketId}\``,
          `› **Co chcesz zakupić:** ${item}`,
          `› ${priceIcon} **Kwota:** ${amount}`,
          `› ${payIcon} **Metoda płatności:** ${payment}`,
          claimedBy ? `› **Przejęty przez:** <@${claimedBy}>` : '› **Status:** Oczekuje na obsługę'
        ].join('\n')
      }
    ],
    footer: footer('Pomoc')
  };
  return {
    embeds: [embed],
    components: [{
      type: C.ActionRow,
      components: [
        button('ticket:close', 'Zamknij ticketa', C.Danger, '31274xids', '❌'),
        button('ticket:settings', 'Ustawienia ticketa', C.Secondary, 'bot', '⚙️'),
        button('ticket:claim', claimedBy ? 'Ticket przejęty' : 'Przejmij ticketa', C.Primary, '23646yes', '✅', Boolean(claimedBy))
      ]
    }]
  };
}

function ticketClosedDmPayload({ user, ticketId, item, amount, payment, closedBy, closedAt = new Date() }) {
  const ts = Math.floor(closedAt.getTime() / 1000);
  return {
    embeds: [{
      color: color(),
      title: `🌊  ·  RYNEK SHOP × ZAMKNIĘTO TWOJEGO TICKETA`,
      description: [`Hejka <@${user.id}>! Twój ticket został **zamknięty**.`, 'Dziękujemy za skorzystanie z naszych usług i zapraszamy ponownie!'].join('\n'),
      fields: [{
        name: 'ℹ️  ·  Informacje o tickecie',
        value: [
          `› **ID Ticketa:** \`${ticketId}\``,
          `› **Zamknięto:** <t:${ts}:F>`,
          `› **Co kupowałeś:** ${item || 'Brak danych'}`,
          `› **Kwota:** ${amount || 'Brak danych'}`,
          `› **Metoda płatności:** ${payment || 'Brak danych'}`,
          closedBy ? `› **Zamknął:** <@${closedBy}>` : null
        ].filter(Boolean).join('\n')
      }],
      footer: footer('Zamknięto Twojego Ticketa')
    }]
  };
}

function legitPayload() {
  const embed = {
    color: color(),
    title: `🌊  ·  RYNEK SHOP × LEGIT CHECK`,
    fields: [
      { name: `${emojiText('weryfikacja_1', '✏️')}  ·  Wzór:`, value: '`+rep @Użytkownik (co zakupiłeś/sprzedałeś) (metoda płatności)`' },
      { name: 'ℹ️  ·  Przykład:', value: '`+rep @auto_wywrotka torpedo (blik)`' }
    ],
    footer: footer('Legit Check')
  };
  return withImage(embed, 'legitBanner', 'legit-banner.jpg');
}

function productsPayload() {
  const shop = emojiText('71334shop', '🛒');
  const embed = {
    color: color(),
    title: `${shop}  ·  RYNEK SHOP × CENNIK`,
    description: [`🌊  ·  **Wybierz interesującą Cię kategorię produktów.**`, 'Po wyborze pokażemy Ci właściwy kanał z cenami.', '', `${shop}  ·  Kliknij przycisk poniżej, aby otworzyć listę kategorii.`].join('\n'),
    footer: footer('Produkty')
  };
  const payload = withImage(embed, 'productsBanner', 'products-banner.png');
  payload.components = [{ type: C.ActionRow, components: [button('products:open', 'Wybierz kategorię', C.Primary, '71334shop', '🛒')] }];
  return payload;
}

function categoryEmoji(name) {
  const lower = name.toLowerCase();
  if (lower.includes('jailbreak')) return componentEmoji('jailbreak', '🌊');
  if (lower === 'mm2') return componentEmoji('mm2', '🌊');
  return componentEmoji('71334shop', '🛒');
}

function productsSelectPayload() {
  const options = Object.keys(config.products || {}).map(name => ({ label: name, value: name, emoji: categoryEmoji(name) }));
  return {
    embeds: [{ color: color(), title: `${emojiText('71334shop', '🛒')}  ·  Wybierz kategorię`, description: 'Wybierz kategorię z listy poniżej. Ta wiadomość jest widoczna tylko dla Ciebie.' }],
    components: [{
      type: C.ActionRow,
      components: [{ type: C.StringSelect, custom_id: 'products:select', placeholder: 'Wybierz kategorię', min_values: 1, max_values: 1, options }]
    }]
  };
}

function productResultPayload(category, channelId, guildId) {
  const result = {
    embeds: [{
      color: color(),
      title: `${emojiText('71334shop', '🛒')}  ·  ${category}`,
      description: channelId ? `Ceny tych przedmiotów znajdziesz na kanale <#${channelId}>.` : 'Kanał cen dla tej kategorii nie został jeszcze skonfigurowany.',
      footer: footer('Cennik')
    }],
    components: []
  };
  if (channelId && guildId) {
    result.components.push({
      type: C.ActionRow,
      components: [{ type: C.Button, style: C.Link, label: 'Przejdź do kanału', emoji: componentEmoji('strzalka_prawo', '➡️'), url: `https://discord.com/channels/${guildId}/${channelId}` }]
    });
  }
  return result;
}

function closeConfirmComponents() {
  return [{
    type: C.ActionRow,
    components: [
      button('ticket:close-confirm', 'Tak, zamknij', C.Danger, '31274xids', '❌'),
      button('ticket:close-cancel', 'Anuluj', C.Secondary, '259419darkbluearrow', '↩️')
    ]
  }];
}

function settingsComponents() {
  return [{
    type: C.ActionRow,
    components: [
      button('ticket:rename', 'Zmień nazwę', C.Primary, '259419darkbluearrow', '✏️'),
      button('ticket:add-user', 'Dodaj użytkownika', C.Secondary, 'klient_2', '➕'),
      button('ticket:remove-user', 'Usuń użytkownika', C.Secondary, '31274xids', '➖')
    ]
  }];
}

function purchaseModal() {
  return {
    custom_id: 'ticket:modal',
    title: 'Formularz zakupu',
    components: [
      { type: C.ActionRow, components: [{ type: C.TextInput, custom_id: 'ticket:item', label: 'Co chcesz zakupić', placeholder: 'np. Robux / przedmiot / usługa', style: C.Short, required: true, max_length: 200 }] },
      { type: C.ActionRow, components: [{ type: C.TextInput, custom_id: 'ticket:amount', label: 'Kwota', placeholder: 'np. 100 PLN', style: C.Short, required: true, max_length: 100 }] },
      { type: C.ActionRow, components: [{ type: C.TextInput, custom_id: 'ticket:payment', label: 'Metoda płatności', placeholder: 'np. BLIK / przelew / PayPal', style: C.Short, required: true, max_length: 100 }] }
    ]
  };
}

function oneInputModal(customId, title, inputId, label, placeholder, maxLength = 90) {
  return {
    custom_id: customId,
    title,
    components: [{ type: C.ActionRow, components: [{ type: C.TextInput, custom_id: inputId, label, placeholder, style: C.Short, required: true, max_length: maxLength }] }]
  };
}

module.exports = {
  setEmojiMap,
  ticketPanelPayload,
  ticketCreatedPayload,
  ticketChannelPayload,
  ticketClosedDmPayload,
  legitPayload,
  productsPayload,
  productsSelectPayload,
  productResultPayload,
  closeConfirmComponents,
  settingsComponents,
  purchaseModal,
  oneInputModal
};
