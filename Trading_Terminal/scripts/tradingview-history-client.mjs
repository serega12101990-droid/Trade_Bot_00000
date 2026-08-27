import crypto from "node:crypto";
import https from "node:https";

const SERIES = {
  "1m": ["s1", "1"],
  "5m": ["s5", "5"],
  "15m": ["s15", "15"],
  "30m": ["s30", "30"],
  "1h": ["s60", "60"],
  "4h": ["s240", "240"],
  "1d": ["s1d", "1D"],
  "1w": ["s1w", "1W"],
};

function tradingViewEnvelope(method, params) {
  const payload = JSON.stringify({ m: method, p: params });
  return `~m~${Buffer.byteLength(payload)}~m~${payload}`;
}

function clientFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length <= 125) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else if (body.length <= 65_535) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(state, chunk, onText, sendFrame) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) return;
      const wide = state.buffer.readBigUInt64BE(2);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("TradingView frame is too large");
      length = Number(wide);
      offset = 10;
    }
    const masked = Boolean(second & 0x80);
    const maskBytes = masked ? 4 : 0;
    if (state.buffer.length < offset + maskBytes + length) return;
    const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
    offset += maskBytes;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
    state.buffer = state.buffer.subarray(offset + length);
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    const opcode = first & 0x0f;
    const final = Boolean(first & 0x80);
    if (opcode === 0x9) {
      sendFrame(clientFrame(payload, 0xA));
      continue;
    }
    if (opcode === 0x8) throw new Error("TradingView closed the history connection");
    if (opcode === 0x1) state.fragments = [payload];
    else if (opcode === 0x0) state.fragments.push(payload);
    else continue;
    if (final) {
      onText(Buffer.concat(state.fragments).toString("utf8"));
      state.fragments = [];
    }
  }
}

function extractMessages(raw) {
  const messages = [];
  const pattern = /~m~(\d+)~m~/g;
  let match;
  while ((match = pattern.exec(raw))) {
    const start = pattern.lastIndex;
    const bytes = Number(match[1]);
    messages.push(raw.slice(start, start + bytes));
    pattern.lastIndex = start + bytes;
  }
  return messages;
}

export function mapTradingViewSeries(rows) {
  return rows.flatMap((raw) => {
    const values = Array.isArray(raw?.v) ? raw.v : [];
    const time = Number(values[0]) * 1000;
    const open = Number(values[1]);
    const high = Number(values[2]);
    const low = Number(values[3]);
    const close = Number(values[4]);
    const volume = Number(values[5] ?? 0);
    if (![time, open, high, low, close, volume].every(Number.isFinite)) return [];
    return [{ time, open, high, low, close, volume: Math.max(0, volume), closed: true }];
  }).sort((left, right) => left.time - right.time);
}

export async function fetchTradingViewHistory(symbol, timeframe, count = 1000) {
  const normalized = String(symbol).trim().toUpperCase();
  const series = SERIES[timeframe];
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(normalized) || !series) throw new Error("Unsupported MOEX history request");
  const [seriesId, resolution] = series;
  const chartSession = `cs_${crypto.randomBytes(6).toString("hex")}`;
  const key = crypto.randomBytes(16).toString("base64");
  const path = `/socket.io/websocket?from=chart%2F${encodeURIComponent(normalized)}%2F&date=${new Date().toISOString().slice(0, 10).replaceAll("-", "_")}-00_00`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    let rows = [];
    const finish = (error, bars = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket && !socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve(bars);
    };
    const timeout = setTimeout(() => finish(new Error("TradingView history timeout")), 20_000);
    const request = https.request({
      hostname: "data.tradingview.com",
      port: 443,
      path,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        Origin: "https://www.tradingview.com",
        "User-Agent": "Mozilla/5.0 Northstar-Trading-Terminal/0.3",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
      },
    });
    request.on("upgrade", (_response, upgradedSocket, head) => {
      socket = upgradedSocket;
      const send = (method, params) => socket.write(clientFrame(tradingViewEnvelope(method, params)));
      const state = { buffer: Buffer.alloc(0), fragments: [] };
      const onText = (text) => {
        for (const raw of extractMessages(text)) {
          if (raw.startsWith("~h~")) {
            socket.write(clientFrame(`~m~${Buffer.byteLength(raw)}~m~${raw}`));
            continue;
          }
          try {
            const message = JSON.parse(raw);
            if (message.m === "timescale_update") {
              const update = message.p?.[1]?.[seriesId];
              if (Array.isArray(update?.s)) rows = update.s;
            }
            if (message.m === "series_completed" && message.p?.[1] === seriesId) {
              const bars = mapTradingViewSeries(rows);
              if (!bars.length) finish(new Error(`TradingView returned no history for ${normalized}`));
              else finish(null, bars);
            }
            if (message.m === "critical_error" || message.m === "protocol_error") finish(new Error(String(message.p?.at(-1) ?? "TradingView protocol error")));
          } catch {}
        }
      };
      socket.on("data", (chunk) => {
        try {
          decodeFrames(state, head?.length ? Buffer.concat([head, chunk]) : chunk, onText, (frame) => socket.write(frame));
          head = Buffer.alloc(0);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("TradingView frame error"));
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => finish(new Error("TradingView history connection closed")));
      send("set_auth_token", ["unauthorized_user_token"]);
      send("chart_create_session", [chartSession, ""]);
      send("resolve_symbol", [chartSession, "symbol_1", `={"symbol":"RUS:${normalized}","adjustment":"splits","session":"regular"}`]);
      send("create_series", [chartSession, seriesId, seriesId, "symbol_1", resolution, Math.min(5000, Math.max(100, Number(count) || 1000))]);
    });
    request.on("response", (response) => finish(new Error(`TradingView history HTTP ${response.statusCode}`)));
    request.on("error", (error) => finish(error));
    request.end();
  });
}
