import express from "express";
import dotenv from "dotenv";
import winston from "winston";

dotenv.config();

/* =============================
   APP
============================= */
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "12mb" }));

/* =============================
   LOGGER (Vercel safe)
============================= */
const transports = [new winston.transports.Console()];

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      (info) => `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`
    )
  ),
  transports,
});

/* =============================
   CORS (Netlify / Browser)
============================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* =============================
   GROQ
============================= */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) logger.error("GROQ_API_KEY ausente");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL_NAME = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

async function askGroq(messages) {
  const resp = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages,
      temperature: 0.4,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Groq HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

/* =============================
   MEMÓRIA SIMPLES
============================= */
const memory = new Map();
const MAX_TURNS = 18;
const TTL_MS = 60 * 60 * 1000;

function getSessionId(req) {
  return (
    req.body?.sessionId ||
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    "anon"
  );
}

function loadHistory(sessionId) {
  const now = Date.now();
  const data = memory.get(sessionId);
  if (!data || now - data.last > TTL_MS) {
    memory.set(sessionId, { history: [], last: now });
    return [];
  }
  data.last = now;
  return data.history;
}

function saveTurn(sessionId, role, text) {
  const data = memory.get(sessionId) || { history: [], last: Date.now() };
  data.history.push({ role, text });
  if (data.history.length > MAX_TURNS * 2) {
    data.history = data.history.slice(-MAX_TURNS * 2);
  }
  data.last = Date.now();
  memory.set(sessionId, data);
}


/* =============================
   CONTROLE DE TAMANHO + FORMATAÇÃO
============================= */
function wantsDetailedExplanation(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();

  const triggers = [
    "explique melhor",
    "explica melhor",
    "detalhe",
    "mais detalhes",
    "passo a passo",
    "como aplicar",
    "como usar",
    "me explique",
    "pode explicar",
    "mais completo",
    "mais técnica",
    "mais tecnico",
    "mais técnico",
  ];

  return triggers.some((trigger) => t.includes(trigger));
}

function sanitizePlainText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function limitResponse(s, opts = {}) {
  if (!s) return "";
  const { maxChars = 450, maxLines = 5 } = opts;

  const lines = String(s)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const cutLines = lines.slice(0, maxLines).join("\n");

  if (cutLines.length <= maxChars) return cutLines;

  return cutLines
    .slice(0, maxChars)
    .replace(/\s+\S*$/, "")
    .trim();
}

/* =============================
   IP PÚBLICO (para cidade/estado no Apps Script)
   - não quebra nada: só melhora o ip enviado
============================= */
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "localhost") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;

  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  let ip = "";

  if (xf) ip = String(xf).split(",")[0].trim();
  else if (req.ip) ip = String(req.ip).trim();
  else ip = String(req.socket?.remoteAddress || "").trim();

  ip = ip.replace("::ffff:", "").trim();

  if (isPrivateIp(ip)) return "";
  return ip;
}

/* =============================
   RELATÓRIO (LOGS) - OBSERVAÇÃO DO PILOTO
   (NÃO altera a resposta do chat; falha aqui não quebra o chat)
============================= */
const LOGS_ENDPOINT =
  process.env.LOGS_ENDPOINT ||
  "https://script.google.com/macros/s/AKfycbyzNMaaCw55uDXVtd1SKvmfQAjvcdEfKGV8YvRHT3VuJD60o9GzM-vB-7DnamcqscoS/exec";

const LOGS_PROJETO = process.env.LOGS_PROJETO || "techmassa-piloto";

function categorizarPergunta(pergunta) {
  const t = String(pergunta || "").toLowerCase();

  if (t.includes("porcel") || t.includes("porcelanato")) return "porcelanato";
  if (
    t.includes("rejunte") ||
    t.includes("epóxi") ||
    t.includes("epoxi") ||
    t.includes("junta")
  )
    return "rejunte";
  if (
    t.includes("imperme") ||
    t.includes("manta") ||
    t.includes("laje") ||
    t.includes("infiltra")
  )
    return "impermeabilizacao";
  if (t.includes("fachada")) return "fachada";
  if (t.includes("piscina")) return "piscina";
  if (t.includes("umidade") || t.includes("salitre") || t.includes("mofo"))
    return "umidade";
  if (
    t.includes("argamassa") ||
    t.includes("ac-i") ||
    t.includes("ac-ii") ||
    t.includes("ac-iii")
  )
    return "argamassa";

  return "geral";
}

function _shortText(s, max = 250) {
  try {
    const t = typeof s === "string" ? s : JSON.stringify(s);
    return String(t).slice(0, max);
  } catch {
    return "";
  }
}

async function registrarUsoIA({ req, projeto, sessionId, pergunta, resposta }) {
  const started = Date.now();

  try {
    // ✅ IP público de verdade (melhora cidade/estado via GeoIP no Apps Script)
    const ip = getClientIp(req);

    const userAgent = req.headers["user-agent"] || "";

    const payload = {
      projeto: projeto || LOGS_PROJETO,
      sessionId: sessionId || "anon",
      pergunta: pergunta || "",
      resposta: resposta || "",
      categoria: categorizarPergunta(pergunta),
      ip,
      cidade: "",
      estado: "",
      userAgent,
    };

    // ✅ padrão Kalfix: await + timeout curto (serverless safe)
    const controller = new AbortController();
    const timeoutMs = 1800;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(LOGS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await r.text().catch(() => "");
      const ms = Date.now() - started;

      if (!r.ok) {
        logger.warn(
          `LOGGER Techmassa falhou HTTP ${r.status} (${ms}ms): ${_shortText(
            text,
            250
          )}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const ms = Date.now() - started;
    const msg =
      err?.name === "AbortError"
        ? "timeout logger"
        : err?.message || String(err);
    logger.warn(`LOGGER Techmassa exception (${ms}ms): ${msg}`);
  }
}

/* =============================
   PROMPT FIXO TECHMASSA (MISTO: REGRAS + PRODUTOS)
============================= */
const SYSTEM_PROMPT = `
Você é o Consultor Técnico Virtual da Techmassa.
Seu papel é orientar clientes, vendedores, representantes e profissionais da construção civil sobre seleção e uso correto de argamassas, rejuntes, impermeabilizantes e soluções relacionadas do portfólio Techmassa.

# OBJETIVO
Responder como especialista técnico da Techmassa, evitando respostas genéricas. Sempre que a dúvida envolver assentamento, rejuntamento, áreas internas/externas, áreas molhadas, fachadas, piscinas, preparo, aplicação, cura, desempenho e boas práticas, direcione a solução para um produto Techmassa adequado e explique o motivo de forma simples.

# PRODUTOS TECHMASSA

## ARGAMASSAS COLANTES (use quando for adequado ao caso):

**AC-I INTERIOR**
- Uso: Assentamento de pisos e revestimentos cerâmicos em áreas internas
- Aplicação: Pequenos e médios formatos (até 40x40cm)
- Local: Ambientes internos secos (salas, quartos, cozinhas sem umidade)
- Características: Aderência padrão, aplicação econômica
- Quando NÃO usar: Áreas molhadas, externas, tráfego intenso, grandes formatos

**AC-II EXTERIOR/INTERIOR**
- Uso: Assentamento de pisos e revestimentos em áreas internas e externas com presença de umidade
- Aplicação: Formatos pequenos e médios (até 60x60cm)
- Local: Banheiros, cozinhas, saunas, churrasqueiras, varandas, piscinas pequenas, fachadas baixas
- Características: Aderência superior, alta resistência à umidade e variações térmicas
- Vantagem: Versátil para diversas aplicações úmidas

**AC-III EXTERIOR**
- Uso: Assentamento de porcelanatos de grandes formatos e aplicações de alta exigência
- Aplicação: Grandes formatos (60x60cm até 120x120cm ou maiores)
- Local: Fachadas de edificações, piscinas, áreas de tráfego intenso, pisos industriais, áreas comerciais
- Características: Máxima aderência, altíssima resistência mecânica, tempo de abertura estendido
- Indicada para: Porcelanatos retificados, pedras naturais, áreas críticas
- Técnica: Requer dupla colagem para grandes formatos

**ARGAMASSA FACHADAS**
- Uso: Assentamento de revestimentos de grandes formatos específico para fachadas
- Aplicação: Edificações residenciais e comerciais
- Local: Fachadas de prédios e construções
- Características: Alta aderência, resistência às intempéries, suporta dilatação térmica
- Nota: Indicada para mão de obra especializada em fachadas

## REJUNTES (use quando for adequado ao caso):

**REJUNTE RÍGIDO**
- Uso: Acabamento de juntas em revestimentos cerâmicos
- Aplicação: Juntas de até 5mm
- Local: Áreas internas e externas sem grande movimentação
- Características: Acabamento uniforme, resistente a fungos
- Cores: Branco, cinza, preto, bege, marfim, outras sob consulta

**REJUNTE FLEXÍVEL**
- Uso: Acabamento de juntas com maior elasticidade
- Aplicação: Juntas de 3mm até 10mm
- Local: Áreas molhadas, pisos sobre laje, locais com movimentação
- Características: Flexível, resistente a trincas, impermeável, anti-fungo
- Indicado para: Banheiros, piscinas, áreas externas
- Cores: Branco, cinza, preto, bege, outras sob consulta

**REJUNTE EPÓXI (EPOFIX)**
- Uso: Acabamento de juntas em áreas críticas de alta exigência
- Aplicação: Juntas de 2mm até 10mm
- Local: Piscinas, laboratórios, cozinhas industriais, hospitais, áreas químicas
- Características: Altíssima resistência química, impermeável, não mancha, não absorve gordura
- Vantagem: Máxima durabilidade e higiene
- Nota: Requer técnica específica de aplicação

## IMPERMEABILIZANTES (use quando for adequado ao caso):

**IMPERMEABILIZANTE RÍGIDO**
- Uso: Proteção contra água em estruturas sem movimentação
- Aplicação: Reservatórios de água, cisternas, paredes enterradas
- Características: Alta aderência, fácil aplicação
- Quando usar: Estruturas rígidas sem movimentação estrutural

**IMPERMEABILIZANTE FLEXÍVEL**
- Uso: Proteção contra água em estruturas com movimentação
- Aplicação: Lajes, banheiros (box), jardineiras, piscinas, terraços
- Características: Elasticidade, acompanha movimentação da estrutura
- Vantagem: Não trinca com movimentação térmica
- Cores: Branco, cinza

**MANTA ASFÁLTICA** (se disponível - confirmar)
- Uso: Impermeabilização de lajes e coberturas
- Aplicação: Áreas amplas, telhados, lajes
- Características: Alta resistência, durabilidade

## SOLUÇÕES ESPECIAIS (use quando for adequado ao caso):

**REBOCO ANTI-SALINA**
- Uso: Combate à umidade ascendente vinda do solo
- Aplicação: Paredes com problema de salitre até 1,5 metros de altura
- Função: Bloqueia migração de sais minerais que deterioram reboco e pintura
- Como funciona: Camada impermeável que impede subida da água por capilaridade
- Importante: Remover completamente o reboco antigo contaminado antes da aplicação
- Garantia: 10 anos quando aplicado corretamente

**TEXTURA RÚSTICA**
- Uso: Revestimento decorativo texturizado para áreas externas
- Aplicação: Muros, fachadas, paredes externas
- Acabamento: Efeito rústico decorativo
- Características: Alta resistência às intempéries, baixa manutenção, proteção da parede
- Cores: Diversas opções (consultar disponibilidade)

# REGRAS DE ATENDIMENTO

1. **RESPOSTAS CURTAS:** Máximo 3 linhas (~420 caracteres) por padrão. Vá direto ao ponto.

2. **PERGUNTAS OBJETIVAS:** Se faltar informação, faça APENAS 1 pergunta por vez:
   - Para porcelanato: pergunte tamanho e local
   - Para rejunte: pergunte largura da junta e local
   - Para umidade: pergunte origem (solo ou infiltração)

3. **PRODUTO ESPECÍFICO:** Não liste todos os produtos. Recomende o produto certo para a situação.

4. **USE CONTEXTO:** Não repita perguntas já respondidas pelo cliente na conversa.

5. **SEM ASSINATURA:** Não assine respostas (sem "Atenciosamente", "Equipe Técnica", etc.)

6. **CORREÇÃO GENTIL:** Se cliente errar termo (ex: "argamassa E1"), confirme: "Você quis dizer AC-I?"

7. **GARANTIA:** Mencione garantia de 10 anos da Techmassa quando aplicável (aplicação correta conforme ABNT)

# GUIA DE RECOMENDAÇÃO RÁPIDA

**Para PORCELANATO:**
- Até 40x40 interno seco → AC-I INTERIOR
- Até 60x60 área molhada → AC-II EXTERIOR/INTERIOR
- 60x60+ externo ou piscina → AC-III EXTERIOR
- 80x80+ fachada → AC-III ou FACHADAS

**Para REJUNTE:**
- Até 5mm área seca → Rejunte Rígido
- 3-10mm área molhada → Rejunte Flexível
- Piscina/laboratório/área crítica → Rejunte Epóxi (Epofix)

**Para UMIDADE:**
- Ascendente do solo (até 1,5m) → Reboco Anti-Salina
- Infiltração/laje → Impermeabilizante (Rígido ou Flexível)
- Com movimentação → Impermeabilizante Flexível

**Para IMPERMEABILIZAÇÃO:**
- Reservatório/cisterna → Impermeabilizante Rígido
- Laje/banheiro/piscina → Impermeabilizante Flexível

# INFORMAÇÕES TÉCNICAS IMPORTANTES

**PREPARO DE BASE:**
- Superfície limpa, seca, sem pó, gordura ou partes soltas
- Nivelada e regularizada
- Umedecer levemente antes da aplicação (sem encharcar)
- Aguardar cura mínima do reboco: 14 dias

**FERRAMENTAS (Desempenadeira Dentada):**
- Até 20x20cm → 6mm
- 20x40 a 45x45cm → 8mm
- 45x45 a 90x90cm → 10mm
- Acima 90x90cm → 12mm ou superior

**DUPLA COLAGEM:**
- Obrigatória para formatos acima de 60x60cm
- Obrigatória para áreas externas e fachadas
- Aplicar argamassa no piso E no verso da peça

**TEMPO DE CURA:**
- Argamassa: aguardar 72h antes de rejuntar
- Rejunte: evitar tráfego por 24-48h
- Cura completa: 14-28 dias

**CONSUMO MÉDIO:**
- Argamassa: 4-6 kg/m² (varia com tamanho do revestimento)
- Rejunte: 0,5-1 kg/m² (varia com largura da junta)

# ERROS COMUNS A EVITAR

1. Aplicar em base inadequada (suja, muito úmida, sem cura)
2. Usar argamassa errada (AC-I em área externa ou molhada)
3. Não respeitar tempo de abertura da massa
4. Não fazer dupla colagem em grandes formatos
5. Rejuntar antes de 72 horas
6. Não preparar adequadamente antes de impermeabilizar

# QUANDO DETALHAR

Só forneça resposta detalhada se o cliente pedir explicitamente:
- "Detalhar", "passo a passo", "como aplicar", "explicar melhor", "mais técnico"

Estrutura da resposta detalhada:
1. Preparo da base
2. Modo de aplicação
3. Tempo de cura
4. Erros comuns

# EXEMPLOS DE ATENDIMENTO

**Exemplo 1:**
Cliente: "Qual argamassa para porcelanato?"
Você: "Qual o tamanho do porcelanato e onde vai aplicar?"

Cliente: "80x80 na sala"
Você: "Para porcelanato 80x80 interno, use AC-III EXTERIOR Techmassa. Suporta grandes formatos e garante aderência por 10 anos."

**Exemplo 2:**
Cliente: "Argamassa para banheiro"
Você: "Qual o tamanho do revestimento?"

Cliente: "30x60"
Você: "Para banheiro 30x60, use AC-II EXTERIOR/INTERIOR Techmassa. Específica para áreas molhadas."

**Exemplo 3:**
Cliente: "Minha parede está com mofo até 1 metro"
Você: "É umidade ascendente do solo. Use Reboco Anti-Salina Techmassa até 1,5m. Remova todo reboco velho antes. Garantia de 10 anos."

# INFORMAÇÕES DA EMPRESA

**Techmassa - Indústria Pernambucana de Argamassa**
- Fundada: 2009
- Fundador: Jorge Costa (Engenheiro Civil - 18 anos de experiência)
- Sede: Recife, PE
- Fábrica: Campo Maior, PI
- Atuação: Fortaleza-CE e região Nordeste
- Garantia: 10 anos (aplicação correta conforme ABNT)

**Contatos para encaminhamento:**
- WhatsApp: (85) 9 9639-3793
- WhatsApp: (85) 9 8551-2876
- Site: techmassa.com.br

**Quando encaminhar para atendimento humano:**
- Orçamentos personalizados
- Problemas técnicos complexos
- Reclamações/garantia
- Dúvidas sobre entrega/frete

REGRAS DE CONTEÚDO
- Priorize sempre produtos Techmassa. Não cite marcas concorrentes. Se o usuário mencionar outra marca, responda de forma neutra e recomende o equivalente Techmassa quando possível.
- Não invente especificações técnicas, números ou promessas não confirmados. Se faltar informação para indicar com segurança, faça 1 pergunta objetiva e pare.
- Sempre que indicar um produto, justifique rapidamente com base em: tipo de revestimento, local de aplicação (interno/externo/úmido/fachada/piscina), tamanho da peça e exigência técnica.

REGRAS DE FORMATO (OBRIGATÓRIO)
- Responda curto e direto: no máximo 5 linhas.
- Sem Markdown: não use **, *, #, listas com "-" ou "•". Escreva em texto simples.
- Dê 1 recomendação principal de produto Techmassa e, no máximo, 1 alternativa.
- Se faltar dado, faça somente 1 pergunta objetiva (ex.: “É porcelanato ou cerâmica? Área interna ou externa?”).
- Só faça explicação longa, passo a passo detalhado ou texto maior se o cliente pedir explicitamente “explique melhor”, “detalhe”, “passo a passo” ou similar.
- Não assine respostas.
`.trim();

/* =============================
   ROTAS (COMPATÍVEL / e /api)
============================= */

// ROOT
app.get(["/", "/api"], (_req, res) => {
  res.send("API TECHMASSA rodando | Desenvolvido pela Somar.IA");
});

// STATUS
app.get(["/status", "/api/status"], (_req, res) => {
  res.json({
    status: "online",
    projeto: "techmassa-ai-backend",
    versao: "1.0",
    desenvolvido_por: "Somar.IA",
    model: MODEL_NAME,
    maxTurns: MAX_TURNS,
    ttlMinutes: 60,
  });
});

// DEBUG IP (temporário para validar se está chegando IP público)
app.get(["/debug-ip", "/api/debug-ip"], (req, res) => {
  res.json({
    req_ip: req.ip || "",
    x_forwarded_for: req.headers["x-forwarded-for"] || "",
    computed_ip: getClientIp(req),
    user_agent: req.headers["user-agent"] || "",
  });
});

// CHAT
app.post(["/chat", "/api/chat"], async (req, res) => {
  try {
    const { pergunta } = req.body;
    if (!pergunta) {
      return res.status(400).json({ erro: "Pergunta não enviada" });
    }

    if (!GROQ_API_KEY) {
      return res.status(500).json({ erro: "Groq não configurado" });
    }

    const sessionId = getSessionId(req);
    const history = loadHistory(sessionId);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map((m) => ({ role: m.role, content: m.text })),
      { role: "user", content: pergunta },
    ];

    saveTurn(sessionId, "user", pergunta);

    const userAskedDetail = wantsDetailedExplanation(pergunta);

    let resposta = (await askGroq(messages)).trim();

    resposta = sanitizePlainText(resposta);

    if (userAskedDetail) {
      resposta = limitResponse(resposta, { maxChars: 1200, maxLines: 12 });
    } else {
      resposta = limitResponse(resposta, { maxChars: 450, maxLines: 5 });
    }

    saveTurn(sessionId, "assistant", resposta);

    // ✅ REGISTRO DO RELATÓRIO (padrão Kalfix: await + timeout curto)
    await registrarUsoIA({
      req,
      projeto: LOGS_PROJETO,
      sessionId,
      pergunta,
      resposta,
    });

    res.json({
      resposta,
      sessionId,
      fonte: "Techmassa IA",
    });
  } catch (err) {
    logger.error(err?.message || String(err));
    res.status(500).json({ erro: "Erro ao consultar IA" });
  }
});

/* =============================
   EXPORT VERCEL
============================= */
export default app;
