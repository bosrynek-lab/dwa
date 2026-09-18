# Rynek Shop Bot — wersja LITE (Node.js 18 / 315 MiB RAM)

Ta wersja została przebudowana specjalnie pod hosting z limitem **315 MiB RAM**.
Nie używa ciężkiego `discord.js`; ma tylko jedną małą zależność: `ws` do połączenia z Discord Gateway.

## Zachowane funkcje

- `/panel-ticket` — panel tworzenia ticketów z Twoją grafiką **STWÓRZ TICKET**.
- Formularz: **Co chcesz zakupić / Kwota / Metoda płatności**.
- Prywatny kanał ticketa w ustawionej kategorii.
- Seller/admin: **Zamknij / Ustawienia / Przejmij ticket**.
- DM do właściciela po zamknięciu ticketa.
- `/panel-produkty` — panel produktów z grafiką **PRODUKTY**.
- Kategorie: Jailbreak, Robux, MM2, case-world, Petsim99 i przekierowanie na ustawione kanały.
- `/sticky-legit` — Legit Check z Twoją grafiką **LEGIT CHECK**.
- Automatyczny sticky na skonfigurowanym kanale.
- Niebieski motyw Rynek Shop.
- Bot szuka po nazwach customowych emotek na Twoim serwerze (np. `71334shop`, `40197checkmarkids`, `31274xids`, strzałki, płatności) i używa ich, jeśli je znajdzie.

## ACLClouds

**Node.js:** 18

**Install command:**

```bash
npm install --omit=dev --no-audit --no-fund
```

**Start command:**

```bash
npm start
```

`npm start` uruchamia:

```bash
node --max-old-space-size=128 src/index.js
```

Dzięki temu Node ma ograniczoną stertę i zostaje zapas w limicie 315 MiB na sam system hostingu.

## Token i ID serwera

Najbezpieczniej w ACLClouds dodać zmienne środowiskowe:

```env
DISCORD_TOKEN=TWÓJ_NOWY_TOKEN
GUILD_ID=ID_SERWERA
```

Możesz też utworzyć lokalny `.env` na serwerze. **Nie wrzucaj prawdziwego `.env` ani tokena na publiczny GitHub.**

Jeśli token był wcześniej pokazany na screenie lub udostępniony, zresetuj go w Discord Developer Portal i użyj nowego.

## GitHub

Do repo wrzuć całą zawartość tego folderu, ale bez `.env` i `node_modules`.
Branch w ACLClouds: `main`.
