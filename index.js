require("dotenv").config();

const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField
} = require('discord.js');

const axios = require('axios');
const fs = require('fs');
const express = require("express");

const app = express();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.log("❌ TOKEN NÃO ENCONTRADO!");
  process.exit(1);
}

const ARQUIVO = "deals_enviados.json";
const CONFIG = "config.json";
const INTERVALO_PROMOCOES_MS = 1000 * 60 * 5;
const guildsEmProcessamento = new Set();

// ================= CONFIG =================
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

// ================= ENVIADOS =================
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

// ================= UTIL =================
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

function obterHorarioAtual() {
  return new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatarIntervalo(ms) {
  const totalSegundos = Math.floor(ms / 1000);
  const minutos = Math.floor(totalSegundos / 60);
  const segundos = totalSegundos % 60;

  if (minutos > 0 && segundos === 0) {
    return `${minutos} minuto${minutos === 1 ? "" : "s"}`;
  }

  if (minutos > 0) {
    return `${minutos} minuto${minutos === 1 ? "" : "s"} e ${segundos} segundo${segundos === 1 ? "" : "s"}`;
  }

  return `${segundos} segundo${segundos === 1 ? "" : "s"}`;
}

// ================= APIs =================
async function buscarPromocoes() {
  try {
    const res = await axios.get("https://www.cheapshark.com/api/1.0/deals?storeID=1");
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
  if (!texto) return "";

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pt&dt=t&q=${encodeURIComponent(texto)}`;
    const res = await axios.get(url);
    return res.data[0].map(item => item[0]).join("");
  } catch {
    return texto;
  }
}

// ================= PROMO =================
async function processarPromocoesGuild(guildId, dados, enviados, origem = "automatico") {
  if (guildsEmProcessamento.has(guildId)) {
    console.log(`⏳ Guild ${guildId} já está em processamento. Origem ignorada: ${origem}`);
    return { enviadas: 0, ignorada: true };
  }

  guildsEmProcessamento.add(guildId);

  try {
  const config = carregarConfig();
    const canal = await client.channels.fetch(dados.canal).catch(() => null);
    if (!canal) {
      console.log(`❌ Canal inválido na guild ${guildId}`);
      return { enviadas: 0, ignorada: false };
    }

    const jogos = await buscarPromocoes();
    const processados = [];
    let totalEnviadas = 0;

    console.log(`🎯 ${jogos.length} jogos recebidos na guild ${guildId} (${origem})`);

    // Pré-filtra sem chamar API externa: remove enviados, DLCs e baixo desconto
    const candidatos = jogos
      .filter(j => j.steamAppID && !enviados.includes(j.steamAppID) && !j.title.toLowerCase().includes("dlc"))
      .map(j => ({ ...j, desconto: Math.round(100 - (j.salePrice / j.normalPrice) * 100) }))
      .filter(j => j.desconto >= 30)
      .sort((a, b) => b.desconto - a.desconto)
      .slice(0, 15); // chama API externa só para os 15 melhores candidatos

    console.log(`🔍 ${candidatos.length} candidatos após pré-filtro`);

    for (const jogo of candidatos) {

      // Pausa entre chamadas para não ser bloqueado por rate limit da Steam
      await new Promise(r => setTimeout(r, 300));

      const dadosSteam = await buscarDadosSteam(jogo.steamAppID);
      const reviews = await buscarReviews(jogo.steamAppID);

      if (reviews.percent < 70) continue;

      // Pula jogos onde a Steam não retornou dados mínimos
      if (!dadosSteam.descricao && !dadosSteam.precoAtual && !dadosSteam.precoAntigo) {
        console.log(`⚠️ Sem dados Steam para ${jogo.title}, pulando`);
        continue;
      }

      const score = calcularScore(jogo, dadosSteam, reviews);
      processados.push({ jogo, dadosSteam, desconto: jogo.desconto, score });
    }

    processados.sort((a, b) => b.score - a.score);

    for (const item of processados.slice(0, 5)) {

      const { jogo, dadosSteam, desconto } = item;

      let descricao = await traduzirTexto(dadosSteam.descricao);
      if (!descricao) descricao = "Descrição indisponível.";

      const url = `https://store.steampowered.com/app/${jogo.steamAppID}`;

      // Usa preço da Steam se disponível, senão usa dados do CheapShark convertidos
      const precoOriginalUSD = parseFloat(jogo.normalPrice);
      const precoAtualUSD = parseFloat(jogo.salePrice);
      const precoAntigo = dadosSteam.precoAntigo
        || (precoOriginalUSD > 0 ? `US$ ${precoOriginalUSD.toFixed(2)}` : "Gratuito");
      const precoAtual = dadosSteam.precoAtual
        || (precoAtualUSD > 0 ? `US$ ${precoAtualUSD.toFixed(2)}` : "Gratuito");

      const embed = new EmbedBuilder()
        .setColor(0x2F3136)
        .setTitle(jogo.title)
        .setURL(url)
        .setDescription(descricao)
        .addFields(
          { name: "💰 Original", value: precoAntigo, inline: true },
          { name: "🏷️ Atual", value: precoAtual, inline: true },
          { name: "📉 Desconto", value: `${desconto}% OFF`, inline: true }
        )
        .setImage(`https://cdn.cloudflare.steamstatic.com/steam/apps/${jogo.steamAppID}/header.jpg`)
        .setFooter({ text: `Steam • ${obterHorarioAtual()}` });

      const botoes = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Ver na Steam")
          .setStyle(ButtonStyle.Link)
          .setURL(url)
      );

      await canal.send({ embeds: [embed], components: [botoes] });
      enviados.push(jogo.steamAppID);
      totalEnviadas += 1;
    }

    return { enviadas: totalEnviadas, ignorada: false };
  } finally {
    guildsEmProcessamento.delete(guildId);
  }
}

async function enviarPromocoes(origem = "automatico", guildIdManual = null) {
  console.log(`🔄 NOVO CICLO (${origem}):`, obterHorarioAtual());

  const config = carregarConfig();
  const enviados = carregarEnviados();

  const guildIds = guildIdManual ? [guildIdManual] : Object.keys(config);
  let totalEnviadas = 0;

  for (const guildId of guildIds) {
    const dados = config[guildId];
    if (!dados) continue;
    if (!guildIdManual && !dados?.ativo) continue;

    const resultado = await processarPromocoesGuild(guildId, dados, enviados, origem);
    totalEnviadas += resultado.enviadas;
  }

  if (enviados.length > 200) {
    enviados.splice(0, enviados.length - 200);
  }

  salvarEnviados(enviados);

  if (guildIdManual) {
    console.log(`✅ CICLO MANUAL FINALIZADO. ${totalEnviadas} promoções enviadas. O ciclo automático continua em paralelo.\n`);
    return totalEnviadas;
  }

  console.log(`✅ CICLO FINALIZADO. ${totalEnviadas} promoções enviadas. Próximo ciclo em ${formatarIntervalo(INTERVALO_PROMOCOES_MS)}.\n`);
  return totalEnviadas;
}

// ================= COMANDOS =================
client.on("messageCreate", async (msg) => {
  if (msg.author.bot || !msg.guild) return;

  if (msg.content === "!setcanal") {
    const config = carregarConfig();

    config[msg.guild.id] = {
      canal: msg.channel.id,
      ativo: false
    };

    salvarConfig(config);
    msg.reply("✅ Canal configurado! Use !iniciarpromo 🚀");
  }

  if (msg.content === "!iniciarpromo") {
    const config = carregarConfig();

    if (!config[msg.guild.id]) {
      return msg.reply("❌ Use !setcanal primeiro");
    }

    config[msg.guild.id].ativo = true;
    salvarConfig(config);

    msg.reply("🚀 Promoções ATIVADAS!");
  }

  if (msg.content === "!novaspromos") {
    const config = carregarConfig();
    const canalConfigurado = config[msg.guild.id]?.canal;

    if (!config[msg.guild.id]) {
      return msg.reply("❌ Use !setcanal primeiro");
    }

    if (guildsEmProcessamento.has(msg.guild.id)) {
      return msg.reply("⏳ Já estou buscando promoções agora. Aguarde terminar este ciclo.");
    }

    await msg.reply(`🔎 Buscando promoções novas agora. Vou enviar em <#${canalConfigurado}>.`);

    try {
      const totalEnviadas = await enviarPromocoes("manual", msg.guild.id);
      if (totalEnviadas === 0) {
        await msg.channel.send(`📭 Não encontrei promoções novas elegíveis neste momento para <#${canalConfigurado}>.`);
      } else {
        await msg.channel.send(`✅ Enviei ${totalEnviadas} ${totalEnviadas === 1 ? "promoção nova" : "promoções novas"} agora em <#${canalConfigurado}>.`);
      }
    } catch (error) {
      console.error("❌ Erro ao executar !novaspromos:", error);
      await msg.channel.send("❌ Não consegui buscar promoções agora. Tente novamente em instantes.");
    }
  }
});

// ================= ENTRADA =================
client.on("guildCreate", async (guild) => {

  console.log(`📥 Entrou em: ${guild.name}`);

  // Garante que o membro do bot esteja cacheado antes de checar permissões
  const meuMembro = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!meuMembro) {
    console.log("❌ Não consegui obter meu próprio membro no guild");
    return;
  }

  const mensagem = `👋 Fala pessoal!\n\nEu sou o **Hyandrin Das Promoções** 🔥\n\n👉 Digite:\n**!setcanal** — para definir o canal de promoções\n**!iniciarpromo** — para ativar o envio automático`;

  // Tenta primeiro o canal de sistema (canal padrão do servidor)
  if (guild.systemChannel) {
    const perm = guild.systemChannel.permissionsFor(meuMembro)?.has([
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ViewChannel
    ]);
    if (perm) {
      try {
        await guild.systemChannel.send(mensagem);
        console.log(`✅ Mensagem enviada em #${guild.systemChannel.name}`);
        return;
      } catch {}
    }
  }

  // Fallback: percorre todos os canais de texto procurando um com permissão
  const canais = await guild.channels.fetch().catch(() => null);
  if (!canais) return;

  for (const [, canal] of canais) {
    if (!canal || canal.type !== ChannelType.GuildText) continue;

    const perm = canal.permissionsFor(meuMembro)?.has([
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ViewChannel
    ]);

    if (!perm) continue;

    try {
      await canal.send(mensagem);
      console.log(`✅ Mensagem enviada em #${canal.name}`);
      return;
    } catch {}
  }

  console.log("❌ Não consegui enviar mensagem em nenhum canal");
});

// ================= READY =================
client.once("ready", async () => {
  console.log(`🤖 Online como ${client.user.tag}`);
  setInterval(enviarPromocoes, INTERVALO_PROMOCOES_MS);
  enviarPromocoes();
});

app.get("/", (req, res) => {
  res.send("Bot rodando 🚀");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Porta ${PORT}`);
});

client.login(TOKEN);