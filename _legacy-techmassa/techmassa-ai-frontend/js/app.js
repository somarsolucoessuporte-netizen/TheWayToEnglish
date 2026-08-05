/* =========================
   CONFIG
========================= */
const API_CHAT = "/api/chat";
const API_STATUS = "/api/status";
const ASSETS_AVATAR = "./assets/animacao/";

const SPRITES = {
  neutral: "techmassa_pose_neutral.png",
  blink: "techmassa_face_blink.png",
  thinking: "techmassa_pose_thinking_chin.png",
};

const el = (id) => document.getElementById(id);

/* =========================
   ELEMENTS
========================= */
const intro = el("intro");
const introVideo = el("introVideo");
const introOverlay = el("introOverlay");
const btnStart = el("btnStart");

const avatarWrap = el("avatarWrap");
const avatarImg = el("avatarImg");
const talkVideo = el("talkVideo");
const avatarStateLabel = el("avatarStateLabel");

const chatLog = el("chatLog");
const chatForm = el("chatForm");
const chatInput = el("chatInput");

const connPill = el("connPill");
const statePill = el("statePill");

const btnMic = el("btnMic");
const btnStopSpeak = el("btnStopSpeak");

/* =========================
   DEVICE HELPERS (iOS real)
========================= */
const UA = navigator.userAgent || "";
const IS_IOS =
  /iPhone|iPad|iPod/i.test(UA) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(UA);
const IS_MOBILE = IS_IOS || IS_ANDROID;

/* =========================
   AUDIO FUNDO (com GainNode)
   arquivo: /assets/som/audio_fundo.mp3
========================= */
const bgAudio = document.getElementById("bgAudio") || new Audio("./assets/som/audio_fundo.mp3");
bgAudio.loop = true;
bgAudio.preload = "auto";
bgAudio.crossOrigin = "anonymous";

// >>> AJUSTE AQUI (1 SÓ LUGAR)
const USER_BG_GAIN = 1.0;

// bases (volume “percebido” no iPhone costuma ser MUITO mais alto)
const BASE_DESKTOP = 0.07;
const BASE_MOBILE = 0.02;

// ducking (reduções relativas)
const DUCK_TTS = 0.35;
const DUCK_STT = 0.45;

let bgMode = "off"; // "off" | "stt" | "tts"
let bgStarted = false;

// WebAudio graph
let audioCtx = null;
let bgSource = null;
let bgGainNode = null;
let bgFadeRAF = null;

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function getBaseGain() {
  const base = IS_MOBILE ? BASE_MOBILE : BASE_DESKTOP;
  return clamp(base * USER_BG_GAIN, 0, 1);
}

function getTargetGain(mode) {
  const base = getBaseGain();
  if (mode === "tts") return clamp(base * DUCK_TTS, 0, 1);
  if (mode === "stt") return clamp(base * DUCK_STT, 0, 1);
  return base;
}

function ensureAudioGraphUnlocked() {
  if (audioCtx && bgGainNode) return;

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;

  audioCtx = new AC();

  try {
    bgSource = audioCtx.createMediaElementSource(bgAudio);
    bgGainNode = audioCtx.createGain();
    bgGainNode.gain.value = getTargetGain(bgMode);

    bgSource.connect(bgGainNode);
    bgGainNode.connect(audioCtx.destination);
  } catch (e) {
    audioCtx = null;
    bgSource = null;
    bgGainNode = null;
  }
}

function applyBgGainNow(mode = bgMode) {
  const g = getTargetGain(mode);

  if (bgGainNode) {
    bgGainNode.gain.value = g;
  }

  bgAudio.volume = bgGainNode ? 1.0 : g;
}

function fadeBgTo(target, ms = 220) {
  if (bgFadeRAF) cancelAnimationFrame(bgFadeRAF);

  const startTime = performance.now();
  const startVal = bgGainNode ? bgGainNode.gain.value : bgAudio.volume;

  const step = (now) => {
    const t = clamp((now - startTime) / ms, 0, 1);
    const v = startVal + (target - startVal) * t;

    if (bgGainNode) bgGainNode.gain.value = v;
    else bgAudio.volume = v;

    if (t < 1) bgFadeRAF = requestAnimationFrame(step);
  };

  bgFadeRAF = requestAnimationFrame(step);
}

function setBgMode(mode) {
  bgMode = mode;
  const target = getTargetGain(mode);
  fadeBgTo(target, 220);
}

async function startBgAudio() {
  if (bgStarted) return;
  bgStarted = true;

  applyBgGainNow("off");

  try {
    await bgAudio.play();
  } catch {}

  setTimeout(() => applyBgGainNow(bgMode), 80);
  setTimeout(() => applyBgGainNow(bgMode), 300);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && bgStarted) {
    applyBgGainNow(bgMode);
  }
});

/* =========================
   UI HELPERS
========================= */
function setConn(text, ok = null) {
  connPill.textContent = text;
  connPill.style.borderColor = "rgba(255,255,255,.08)";
  if (ok === true) connPill.style.borderColor = "rgba(46,204,113,.55)";
  if (ok === false) connPill.style.borderColor = "rgba(229,57,53,.55)";
}

function setState(state, label) {
  statePill.textContent = `Estado: ${state}`;
  avatarStateLabel.textContent = label || state;
}

function addMsg(text, who = "bot") {
  const d = document.createElement("div");
  d.className = `msg ${who}`;
  d.textContent = text;
  chatLog.appendChild(d);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* ✅ setAvatar com diagnóstico (se 404 acontecer você vê no console) */
function setAvatar(file) {
  const url = ASSETS_AVATAR + file;

  avatarImg.onerror = () => {
    console.error("❌ Avatar não carregou:", url);
  };

  avatarImg.src = url;
}

/* ✅ Preload dos sprites (evita “não piscou” por atraso/erro) */
Object.values(SPRITES).forEach((f) => {
  const img = new Image();
  img.src = ASSETS_AVATAR + f;
});

/* =========================
   INTRO
========================= */
let started = false;

async function startPresentationWithAudio() {
  if (started) return;
  started = true;

  warmUpTTS();

  ensureAudioGraphUnlocked();
  if (audioCtx && audioCtx.state === "suspended") {
    try { await audioCtx.resume(); } catch {}
  }

  introVideo.muted = false;
  introVideo.currentTime = 0;

  try { await introVideo.play(); } catch {}

  introOverlay.classList.add("hidden");
  btnStart.disabled = true;

  introVideo.addEventListener("ended", () => {
    intro.classList.add("hidden");
    avatarWrap.classList.remove("hidden");

    startBgAudio();
    startIdle();
  }, { once: true });
}

btnStart.addEventListener("click", startPresentationWithAudio);

/* =========================
   BACKEND
========================= */
async function pingStatus() {
  try {
    const r = await fetch(API_STATUS);
    if (!r.ok) throw new Error();
    setConn("Conexão: ok", true);
    return true;
  } catch {
    setConn("Conexão: falhou", false);
    return false;
  }
}

async function callAI(pergunta) {
  const r = await fetch(API_CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pergunta }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${t}`);
  }

  const j = await r.json().catch(() => ({}));
  if (!j || typeof j.resposta !== "string") {
    throw new Error("Resposta inválida do backend");
  }
  return j.resposta;
}

/* =========================
   AVATAR STATES
========================= */
let idleTimer = null;

function startIdle() {
  clearInterval(idleTimer);

  setState("idle", "Pronto");
  setAvatar(SPRITES.neutral);
  stopTalkingVisual();

  if (bgStarted) setBgMode("off");

  // ✅ Blink real
  idleTimer = setInterval(() => {
    if (Math.random() < 0.2) {
      setAvatar(SPRITES.blink);
      setTimeout(() => setAvatar(SPRITES.neutral), 120);
    }
  }, 1500);
}

function setThinking() {
  clearInterval(idleTimer);
  setState("thinking", "Pensando…");
  setAvatar(SPRITES.thinking);
}

/* =========================
   TALK VIDEO
========================= */
function startTalkingVisual() {
  talkVideo.classList.remove("hidden");
  talkVideo.currentTime = 0;
  talkVideo.play().catch(() => {});
}

function stopTalkingVisual() {
  try { talkVideo.pause(); } catch {}
  talkVideo.classList.add("hidden");
}

/* =========================
   TTS
========================= */
function warmUpTTS() {
  if (!("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch {}
}

function getBestVoicePtBrPreferMale() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voices.length) return null;

  const pt = voices.filter(v => (v.lang || "").toLowerCase().startsWith("pt"));
  const ptbr = pt.filter(v => (v.lang || "").toLowerCase() === "pt-br");

  const maleHints = ["male", "masc", "daniel", "ricardo", "alex", "felipe"];
  const pickByHints = (arr) => {
    for (const hint of maleHints) {
      const found = arr.find(v => (v.name || "").toLowerCase().includes(hint));
      if (found) return found;
    }
    return arr[0] || null;
  };

  return pickByHints(ptbr) || pickByHints(pt) || voices[0];
}

function speakTTS(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve(false);

    try {
      if (bgStarted) setBgMode("tts");

      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "pt-BR";

      const chosen = getBestVoicePtBrPreferMale();
      if (chosen) u.voice = chosen;

      u.rate = 1.02;
      u.pitch = 1.0;
      u.volume = 1;

      setState("speaking", "Respondendo…");
      startTalkingVisual();

      u.onend = () => {
        if (bgStarted) setBgMode("off");
        stopTalkingVisual();
        startIdle();
        resolve(true);
      };

      u.onerror = () => {
        if (bgStarted) setBgMode("off");
        stopTalkingVisual();
        startIdle();
        resolve(false);
      };

      speechSynthesis.speak(u);
    } catch {
      if (bgStarted) setBgMode("off");
      stopTalkingVisual();
      startIdle();
      resolve(false);
    }
  });
}

function stopTTS() {
  try { speechSynthesis.cancel(); } catch {}
  if (bgStarted) setBgMode("off");
  stopTalkingVisual();
  startIdle();
}

/* =========================
   STT (1 CLIQUE, AUTOMÁTICO)
========================= */
let recognition = null;
let isListening = false;

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const r = new SR();
  r.lang = "pt-BR";
  r.continuous = false;
  r.interimResults = false;

  let finalText = "";

  r.onstart = () => {
    isListening = true;
    setState("listening", "Ouvindo…");
    if (bgStarted) setBgMode("stt");
  };

  r.onresult = (e) => {
    try {
      finalText = (e.results?.[0]?.[0]?.transcript || "").trim();
    } catch {
      finalText = "";
    }
  };

  r.onend = () => {
    isListening = false;
    if (bgStarted) setBgMode("off");

    if (finalText) {
      addMsg(finalText, "user");
      handleQuestion(finalText);
    } else {
      addMsg("Não consegui entender. Pode repetir?", "bot");
      startIdle();
    }
  };

  r.onerror = () => {
    isListening = false;
    if (bgStarted) setBgMode("off");
    addMsg("Falha no microfone. Pode digitar a pergunta.", "bot");
    startIdle();
  };

  return r;
}

function startSTT() {
  if (isListening) return;
  recognition = recognition || setupRecognition();
  if (!recognition) {
    addMsg("Este navegador não suporta fala. Digite sua pergunta.", "bot");
    return;
  }
  try {
    recognition.start();
  } catch {
    addMsg("Falha ao iniciar microfone. Tente novamente ou digite.", "bot");
    if (bgStarted) setBgMode("off");
  }
}

/* =========================
   FLOW
========================= */
let busy = false;

async function handleQuestion(text) {
  if (busy) return;
  busy = true;

  setThinking();

  try {
    const ok = await pingStatus();
    if (!ok) throw new Error("status");

    const resposta = await callAI(text);
    addMsg(resposta, "bot");

    const spoke = await speakTTS(resposta);
    if (!spoke) startIdle();
  } catch {
    addMsg("Erro ao consultar a IA.", "bot");
    startIdle();
  } finally {
    busy = false;
  }
}

/* =========================
   EVENTS
========================= */
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const t = (chatInput.value || "").trim();
  if (!t) return;
  chatInput.value = "";
  addMsg(t, "user");
  handleQuestion(t);
});

btnMic.addEventListener("click", startSTT);
btnStopSpeak.addEventListener("click", stopTTS);

/* =========================
   INIT
========================= */
(function init() {
  setConn("Conexão: aguardando…");
  setState("idle", "Aguardando início…");
  setAvatar(SPRITES.neutral);
  introVideo.muted = true;

  // popula vozes
  if ("speechSynthesis" in window) {
    setTimeout(() => { try { speechSynthesis.getVoices(); } catch {} }, 200);
    speechSynthesis.onvoiceschanged = () => {
      try { speechSynthesis.getVoices(); } catch {}
    };
  }

  addMsg("Olá! Pode falar ou digitar sua dúvida técnica.", "bot");
})();

/* === UI ONLY: acende o botão "Falar" quando o estado mostrar "Ouvindo" === */
(() => {
  const btnMic = document.getElementById("btnMic");
  const stateLabel = document.getElementById("avatarStateLabel");
  if (!btnMic || !stateLabel) return;

  const apply = () => {
    const t = (stateLabel.textContent || "").toLowerCase();
    const listening = t.includes("ouvindo") || t.includes("escutando") || t.includes("listening");
    btnMic.classList.toggle("btn-mic-on", listening);
  };

  apply();
  new MutationObserver(apply).observe(stateLabel, { childList: true, characterData: true, subtree: true });
})();
