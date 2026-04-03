require("dotenv").config();

const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder,
  ChannelType,
  PermissionsBitField
} = require('discord.js');

const axios = require('axios');
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent
  ]
});

const express = require("express");
const app = express();

// 🔥 CORREÇÃO AQUI
const TOKEN = process.env.DISCORD_TOKEN;

// 🚨 proteção
if (!TOKEN) {
  console.log("❌ TOKEN NÃO ENCONTRADO! Verifica o Railway.");
  process.exit(1);
}

const ARQUIVO = "deals_enviados.json";
const CONFIG = "config.json";

// ==========================
// 📁 CONFIG
// ==========================
function carregarConfig() {
  if (!fs.existsSync(CONFIG)) {
    fs.writeFileSync(CONFIG, "{}");
    return {};
  }
  return JSON.parse(fs.readFileSync(CONFIG));
}

function salvarConfig(data) {
  fs.writeFileSync(CONFIG, JSON.stringify(data, null, 2));
}

// ==========================
// 📁 ENVIADOS
// ==========================
function carregarEnviados() {
  if (!fs.existsSync(ARQUIVO)) {
    fs.writeFileSync(ARQUIVO, "[]");
    return [];
  }
  return JSON.parse(fs.readFileSync(ARQUIVO));
}

function salvarEnviados(lista) {
  fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
}

// ==========================
function calcularScore(jogo, dadosSteam, reviews) {
  const desconto = parseFloat(jogo.savings);
  const preco = parseFloat(jogo.salePrice);

  let score = desconto;

  if (preco <= 10) score += 15;
  if (preco <= 5) score += 25;

  score += reviews.percent * 0.3;

  if (reviews.total > 5000) score += 10;
  if (reviews.total > 20000) score += 20;

  return score;
}

function definirCategoria(desconto) {
  if (desconto >= 85) return "💀 DESCONTO CRIMINOSO";
  if (desconto >= 75) return "🔥 PROMOÇÃO INSANA";
  if (desconto >= 60) return "⚡ ÓTIMA OFERTA";
  return "🔥 PROMOÇÃO BOA";
}

async function buscarPromocoes() {
  try {
    const res = await axios.get("https://www.cheapshark.com/api/1.0/deals?storeID=1&upperPrice=50");
    return res.data;
  } catch {
    return [];
  }
}

async function buscarDadosSteam(appID) {
  try {
    const res = await axios.get(
      `https://store.steampowered.com/api/appdetails?appids=${appID}&cc=br&l=portuguese`
    );

    const data = res.data[appID];
    if (!data || !data.success) return {};

    return {
      descricao: data.data.short_description,
      precoAtual: data.data.price_overview?.final_formatted,
      precoAntigo: data.data.price_overview?.initial_formatted,
      categorias: data.data.genres?.map(g => g.description) || []
    };
  } catch {
    return {};
  }
}

async function buscarReviews(appID) {
  try {
    const res = await axios.get(
      `https://store.steampowered.com/appreviews/${appID}?json=1`
    );

    const d = res.data.query_summary;

    return {
      percent: d.total_reviews > 0 ? (d.total_positive / d.total_reviews) * 100 : 0,
      total: d.total_reviews || 0
    };
  } catch {
    return { percent: 0, total: 0 };
  }
}

async function traduzirTexto(texto) {
  if (!texto) return texto;

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pt&dt=t&q=${encodeURIComponent(texto)}`;
    const res = await axios.get(url);
    return res.data[0].map(item => item[0]).join("");
  } catch {
    return texto;
  }
}

// ==========================
async function enviarPromocoes() {

  const config = carregarConfig();
  const enviados = carregarEnviados();

  for (const guildId in config) {

    const canal = await client.channels.fetch(config[guildId]).catch(() => null);
    if (!canal) continue;

    const jogos = await buscarPromocoes();
    const processados = [];

    for (const jogo of jogos) {

      if (!jogo.steamAppID) continue;
      if (enviados.includes(jogo.dealID)) continue;
      if (jogo.title.toLowerCase().includes("dlc")) continue;

      const desconto = Math.round(100 - (jogo.salePrice / jogo.normalPrice) * 100);
      if (desconto < 50) continue;

      const dadosSteam = await buscarDadosSteam(jogo.steamAppID);
      const reviews = await buscarReviews(jogo.steamAppID);

      if (reviews.percent < 75 || reviews.total < 200) continue;

      const score = calcularScore(jogo, dadosSteam, reviews);

      processados.push({ jogo, dadosSteam, reviews, desconto, score });
    }

    processados.sort((a, b) => b.score - a.score);

    for (const item of processados.slice(0, 3)) {

      const { jogo, dadosSteam, reviews, desconto } = item;

      let descricao = await traduzirTexto(dadosSteam.descricao);

      const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle(`${definirCategoria(desconto)} - ${jogo.title}`)
        .setURL(`https://store.steampowered.com/app/${jogo.steamAppID}`)
        .setDescription(descricao)
        .addFields(
          { name: "💸 Preço", value: `${dadosSteam.precoAntigo} → ${dadosSteam.precoAtual}`, inline: true },
          { name: "📉 Desconto", value: `-${desconto}%`, inline: true },
          { name: "⭐ Avaliação", value: `${reviews.percent.toFixed(0)}% (${reviews.total})`, inline: true },
          { name: "🎮 Gênero", value: dadosSteam.categorias.slice(0, 2).join(", "), inline: true }
        )
        .setImage(`https://cdn.cloudflare.steamstatic.com/steam/apps/${jogo.steamAppID}/header.jpg`)
        .setFooter({ text: "HyandrinDasPromoção" });

      await canal.send({
        content: "🚨 SE LIGA NA PROMOÇÃO!  ||@everyone||",
        embeds: [embed]
      });

      enviados.push(jogo.dealID);
    }
  }

  salvarEnviados(enviados);
}

// ==========================
client.on("messageCreate", async (msg) => {

  if (msg.content === "!setcanal") {

    const config = carregarConfig();
    config[msg.guild.id] = msg.channel.id;
    salvarConfig(config);

    msg.reply("✅ Canal configurado!");
  }
});

// ==========================
client.on("guildCreate", async (guild) => {

  console.log(`📥 Entrei no servidor: ${guild.name}`);

  let canal = null;

  if (
    guild.systemChannel &&
    guild.systemChannel.permissionsFor(guild.members.me)?.has([
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ViewChannel
    ])
  ) {
    canal = guild.systemChannel;
  }

  if (!canal) {
    canal = guild.channels.cache
      .filter(c =>
        c.type === ChannelType.GuildText &&
        c.permissionsFor(guild.members.me)?.has([
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ViewChannel
        ])
      )
      .sort((a, b) => a.position - b.position)
      .first();
  }

  if (canal) {
    canal.send({
      content:
`# 👋 Olá! Me chamo **Hyandrin Das Promoções**

🔥 Trago as melhores ofertas da Steam pra você!

👉 Me configure usando:

**!setcanal**

📌 Dica: use o comando no canal onde quer receber as promoções 😉

⚠️ Lembre de me dar permissão no canal desejado.`
    }).catch(err => console.log("Erro ao enviar mensagem:", err));
  }
});

// ==========================
client.once("ready", () => {
  console.log(`🤖 Online como ${client.user.tag}`);

  setInterval(enviarPromocoes, 1000 * 60 * 10);
  enviarPromocoes();

  // 🔥 mantém Railway vivo
  setInterval(() => {
    console.log("🟢 Bot ativo...");
  }, 30000);
});


app.get("/", (req, res) => {
  res.send("Bot rodando 🚀");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
});

client.login(TOKEN);