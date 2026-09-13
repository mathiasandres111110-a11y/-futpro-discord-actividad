const DISCORD_API = "https://discord.com/api/v10";
const LOOKBACK_MS = 125_000;
const MAX_PAGES_PER_CHANNEL = 10;
const PREFIXES = ["!", "/", "?", "."];

function requireSettings(env) {
  for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "FUTPRO_ACTIVITY_URL", "FUTPRO_ACTIVITY_KEY"]) {
    if (!env[key]) throw new Error(`Falta configurar ${key}.`);
  }
  if (!/^\d{17,20}$/.test(env.DISCORD_GUILD_ID)) throw new Error("DISCORD_GUILD_ID no es válido.");
  const url = new URL(env.FUTPRO_ACTIVITY_URL);
  if (url.protocol !== "https:" || !url.pathname.endsWith("/api/integrations/discord/activity/events")) {
    throw new Error("FUTPRO_ACTIVITY_URL no es la dirección del conector de FutPro.");
  }
}

async function discord(env, path) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    throw new Error(`Discord respondió ${response.status}${retry ? `; reintenta en ${retry}s` : ""}.`);
  }
  return response.json();
}

async function sendToFutPro(env, identity, channels, events) {
  const response = await fetch(env.FUTPRO_ACTIVITY_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${env.FUTPRO_ACTIVITY_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      applicationId: identity.bot.id,
      guildId: identity.guild.id,
      guildName: identity.guild.name,
      channels,
      events,
    }),
  });
  if (!response.ok) throw new Error(`FutPro respondió ${response.status}. Revisa la clave privada.`);
  return response.json();
}

function snowflakeAt(timestamp) {
  return String((BigInt(timestamp) - 1420070400000n) << 22n);
}

function normalMessage(message) {
  if (!message?.id || !message?.channel_id || !message?.author?.id) return false;
  if (message.author.bot || message.webhook_id || message.interaction || message.interaction_metadata) return false;
  if (![0, 19].includes(message.type)) return false;
  return !PREFIXES.some((prefix) => String(message.content || "").trimStart().startsWith(prefix));
}

async function readRecentMessages(env, channelId) {
  const collected = new Map();
  let after = snowflakeAt(Date.now() - LOOKBACK_MS);
  for (let page = 0; page < MAX_PAGES_PER_CHANNEL; page++) {
    const messages = await discord(env, `/channels/${channelId}/messages?limit=100&after=${after}`);
    if (!Array.isArray(messages) || !messages.length) break;
    for (const message of messages) if (normalMessage(message)) collected.set(message.id, message);
    if (messages.length < 100) break;
    after = messages.reduce((largest, message) => BigInt(message.id) > BigInt(largest) ? message.id : largest, after);
  }
  return [...collected.values()].map((message) => ({
    type: "create",
    id: message.id,
    channelId: message.channel_id,
    userId: message.author.id,
    username: message.author.username,
    displayName: message.member?.nick || message.author.global_name || message.author.username,
  }));
}

async function identify(env) {
  const [bot, guild] = await Promise.all([discord(env, "/users/@me"), discord(env, `/guilds/${env.DISCORD_GUILD_ID}`)]);
  return { bot, guild };
}

async function synchronize(env) {
  requireSettings(env);
  const identity = await identify(env);
  const guildChannels = await discord(env, `/guilds/${identity.guild.id}/channels`);
  const channels = guildChannels
    .filter((channel) => [0, 5].includes(channel.type))
    .map((channel) => ({ id: channel.id, name: channel.name }))
    .slice(0, 500);

  // First heartbeat discovers the server and obtains the owner's current channel selection.
  const configuration = await sendToFutPro(env, identity, channels, []);
  if (!configuration.enabled || !configuration.channelIds?.length) return;

  const allowed = new Set(channels.map((channel) => channel.id));
  const selected = configuration.channelIds.filter((id) => allowed.has(id)).slice(0, 10);
  for (const channelId of selected) {
    try {
      const events = await readRecentMessages(env, channelId);
      for (let index = 0; index < events.length; index += 100) {
        await sendToFutPro(env, identity, channels, events.slice(index, index + 100));
      }
    } catch (error) {
      console.error(new Date().toISOString(), `Canal ${channelId}:`, error.message);
    }
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(synchronize(env).catch((error) => console.error(new Date().toISOString(), error.message)));
  },
  async fetch(_request, env, ctx) {
    ctx.waitUntil(synchronize(env).catch((error) => console.error(new Date().toISOString(), error.message)));
    return new Response("FutPro: comprobación iniciada. Revisa los registros del Worker y el panel de Actividad de Discord.", {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
