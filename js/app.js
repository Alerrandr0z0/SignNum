import {
  FilesetResolver,
  HandLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18';
import { Game, LEVELS } from './game.js';
import { GestureClassifier, getDebugSnapshot } from './gesture-classifier.js';

// ─── One Euro Filter for Landmark Smoothing ────────────────────────────────
class OneEuroFilter {
  constructor(freq, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.lastTime = null;
    this.lastRawValue = null;
    this.lastFilteredValue = null;
  }

  getAlpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(value, timestamp) {
    const now = timestamp || Date.now() / 1000;
    let dt = this.lastTime ? now - this.lastTime : 1.0 / this.freq;
    if (dt <= 0) dt = 1.0 / this.freq;
    this.lastTime = now;

    let filteredValue;
    if (this.lastFilteredValue === null) {
      filteredValue = value;
    } else {
      const dx = (value - this.lastRawValue) / dt;
      const alphaD = this.getAlpha(this.dCutoff, dt);
      const edx = alphaD * dx + (1 - alphaD) * (this.lastFilteredValue - this.lastRawValue) / dt;
      const cutoff = this.minCutoff + this.beta * Math.abs(edx);
      const alpha = this.getAlpha(cutoff, dt);
      filteredValue = alpha * value + (1 - alpha) * this.lastFilteredValue;
    }

    this.lastRawValue = value;
    this.lastFilteredValue = filteredValue;
    return filteredValue;
  }
}

// 21 landmarks * 3 coordinates (x, y, z) for 2D screen space and 3D world space
class HandFilter {
  constructor() {
    this.filters2d = Array.from({ length: 21 }, () => ({
      x: new OneEuroFilter(30, 1.0, 0.1),
      y: new OneEuroFilter(30, 1.0, 0.1),
      z: new OneEuroFilter(30, 1.0, 0.1),
    }));
    this.filters3d = Array.from({ length: 21 }, () => ({
      x: new OneEuroFilter(30, 1.0, 0.1),
      y: new OneEuroFilter(30, 1.0, 0.1),
      z: new OneEuroFilter(30, 1.0, 0.1),
    }));
  }

  filter2d(landmarks, timestamp) {
    if (!landmarks) return null;
    return landmarks.map((pt, i) => ({
      x: this.filters2d[i].x.filter(pt.x, timestamp),
      y: this.filters2d[i].y.filter(pt.y, timestamp),
      z: this.filters2d[i].z.filter(pt.z, timestamp),
    }));
  }

  filter3d(worldLandmarks, timestamp) {
    if (!worldLandmarks) return null;
    return worldLandmarks.map((pt, i) => ({
      x: this.filters3d[i].x.filter(pt.x, timestamp),
      y: this.filters3d[i].y.filter(pt.y, timestamp),
      z: this.filters3d[i].z.filter(pt.z, timestamp),
    }));
  }

  reset() {
    for (let i = 0; i < 21; i++) {
      this.filters2d[i].x.lastFilteredValue = null;
      this.filters2d[i].y.lastFilteredValue = null;
      this.filters2d[i].z.lastFilteredValue = null;
      this.filters3d[i].x.lastFilteredValue = null;
      this.filters3d[i].y.lastFilteredValue = null;
      this.filters3d[i].z.lastFilteredValue = null;
    }
  }
}

const DOM = {
  video: null,
  canvas: null,
  ctx: null,
  question: null,
  score: null,
  combo: null,
  level: null,
  feedback: null,
  detected: null,
  detectedNumber: null,
  startBtn: null,
  overlay: null,
  loading: null,
  bufferDisplay: null,
  timeBar: null,
};

const STATE = {
  handLandmarker: null,
  classifier: null,
  game: null,
  running: false,
  lastVideoTime: -1,
  lastFrameTime: 0,
  animationId: null,
  handVisible: false,
  lastDetectedNumber: null,
  cooldownUntil: 0,
  debugMode: true,
  latestLandmarks: null,
  latestWorldLandmarks: null,
  isRightHand: true,
  handFilter: new HandFilter(),
  // visible region of the video after object-fit: cover (in video pixels)
  crop: null,
};

async function initMediaPipe() {
  DOM.loading.textContent = 'Carregando modelos de visão computacional...';
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
  );

  STATE.handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: '/models/hand_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 1,
    // Confianças bem baixas para garantir detecção super-robusta em contra-luz ou má iluminação.
    // O tremor proveniente da baixa confiança é anulado pelo OneEuroFilter.
    minHandDetectionConfidence: 0.2,
    minTrackingConfidence: 0.2,
    minHandPresenceConfidence: 0.2,
  });

  DOM.loading.textContent = '';
}

async function initCamera() {
  DOM.loading.textContent = 'Ativando câmera...';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  });
  DOM.video.srcObject = stream;
  await DOM.video.play();
  DOM.loading.textContent = '';
}

function drawLandmarks(landmarks) {
  const ctx = DOM.ctx;
  const w = DOM.canvas.width;
  const h = DOM.canvas.height;

  ctx.clearRect(0, 0, w, h);

  if (!landmarks) return;

  // Map from normalized video coordinates to canvas display pixels,
  // accounting for the video's object-fit: cover cropping.
  // This ensures the skeleton perfectly overlays the visible hand.
  let mx, my;
  if (STATE.crop) {
    const { visibleX, visibleY, visibleW, visibleH, vw, vh } = STATE.crop;
    mx = (lm) => ((lm.x * vw - visibleX) / visibleW) * w;
    my = (lm) => ((lm.y * vh - visibleY) / visibleH) * h;
  } else {
    mx = (lm) => lm.x * w;
    my = (lm) => lm.y * h;
  }

  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2;

  const connections = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [0, 5],
    [5, 6],
    [6, 7],
    [7, 8],
    [0, 9],
    [9, 10],
    [10, 11],
    [11, 12],
    [0, 13],
    [13, 14],
    [14, 15],
    [15, 16],
    [0, 17],
    [17, 18],
    [18, 19],
    [19, 20],
    [5, 9],
    [9, 13],
    [13, 17],
  ];

  for (const [i, j] of connections) {
    const a = landmarks[i];
    const b = landmarks[j];
    ctx.beginPath();
    ctx.moveTo(mx(a), my(a));
    ctx.lineTo(mx(b), my(b));
    ctx.stroke();
  }

  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    const x = mx(p);
    const y = my(p);

    ctx.fillStyle = i % 4 === 0 ? '#ff4488' : '#ffcc00';
    ctx.beginPath();
    ctx.arc(x, y, i % 4 === 0 ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();

    if (i % 4 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(i, x, y - 8);
    }
  }
}

function updateDebugPanel(snap) {
  const el = document.getElementById('debug-panel');
  if (!el) return;
  if (!snap) {
    el.innerHTML = '<span style="color:#888">sem landmarks</span>';
    return;
  }
  const { st, localY, thumbX, thumbFlex, isRightHand, matched } = snap;
  const c = (s) =>
    s === 'E'
      ? '<b style="color:#0f0">E</b>'
      : s === 'C'
        ? '<b style="color:#f44">C</b>'
        : '<b style="color:#fa0">H</b>';
  el.innerHTML = `
    <div>Mão: ${isRightHand ? 'DIR' : 'ESQ'} | T:${c(st.thumb)} x:${thumbX} flex:${thumbFlex}°</div>
    <div>I:${c(st.index)} M:${c(st.middle)} R:${c(st.ring)} P:${c(st.pinky)}</div>
    <div style="font-size:9px;color:#aaa">Y-local: I:${localY.index} M:${localY.middle} R:${localY.ring} P:${localY.pinky}</div>
    <div>Match: <b style="color:#ff0">${matched ?? '—'}</b> | E&gt;0.45 C&lt;0.15</div>
  `;
}

function processFrame(timestamp) {
  if (!STATE.running) return;

  const video = DOM.video;
  const canvas = DOM.canvas;

  // Sync canvas to the video's visible area after object-fit: cover.
  // object-fit: cover is not reliably supported on <canvas>, so we compute
  // the visible region of the video ourselves and position the canvas to match.
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const parent = canvas.parentElement;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;

    if (pw > 0 && ph > 0) {
      const scale = Math.max(pw / vw, ph / vh);
      const visibleW = pw / scale; // visible portion in video pixels
      const visibleH = ph / scale;
      const visibleX = (vw - visibleW) / 2;
      const visibleY = (vh - visibleH) / 2;

      STATE.crop = { visibleX, visibleY, visibleW, visibleH, vw, vh, pw, ph };

      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      canvas.style.width = `${pw}px`;
      canvas.style.height = `${ph}px`;
      canvas.style.left = '0px';
      canvas.style.top = '0px';
    }
  }

  // To prevent frozen/static landmarks when the video timestamp hasn't advanced,
  // we do NOT early-return anymore. Instead, we always run the drawing step.
  // We only skip the expensive MediaPipe classification if the frame is identical.
  let landmarksDetected = false;

  if (STATE.handLandmarker && video.currentTime !== STATE.lastVideoTime) {
    STATE.lastVideoTime = video.currentTime;
    const timestampMs = performance.now();
    const result = STATE.handLandmarker.detectForVideo(video, timestampMs);

    if (result.landmarks && result.landmarks.length > 0) {
      const seconds = timestampMs / 1000;
      STATE.latestLandmarks = STATE.handFilter.filter2d(result.landmarks[0], seconds);
      STATE.latestWorldLandmarks = STATE.handFilter.filter3d(result.worldLandmarks?.[0], seconds);
      const handednessLabel = result.handedness?.[0]?.[0]?.categoryName ?? 'Right';
      STATE.isRightHand = handednessLabel === 'Right';
      landmarksDetected = true;
    } else {
      STATE.latestLandmarks = null;
      STATE.latestWorldLandmarks = null;
      STATE.handFilter.reset();
    }
  } else if (STATE.latestLandmarks) {
    // Keep rendering existing landmarks if the frame hasn't updated yet
    landmarksDetected = true;
  }

  if (STATE.lastFrameTime === 0) STATE.lastFrameTime = timestamp;
  const dt = (timestamp - STATE.lastFrameTime) / 1000;
  STATE.lastFrameTime = timestamp;

  // Handle Game Updates
  if (STATE.game && STATE.game.state === 'playing') {
    STATE.game.update(dt);

    if (STATE.game.currentQuestion) {
      const lvl = LEVELS[STATE.game.level];
      const elapsed = (Date.now() - STATE.game.questionStartTime) / 1000;
      const remaining = Math.max(0, lvl.timeLimit - elapsed);
      const pct = (remaining / lvl.timeLimit) * 100;
      DOM.timeBar.style.width = `${pct}%`;
      DOM.timeBar.style.background = pct < 20 ? '#ff4488' : pct < 50 ? '#ffa726' : '#00ff88';
    }
  }

  // Draw the current state of landmarks (or clear canvas if none)
  drawLandmarks(STATE.latestLandmarks);

  if (landmarksDetected) {
    if (!STATE.handVisible) {
      STATE.handVisible = true;
      DOM.video.style.opacity = '0.4';
      if (DOM.handStatus) DOM.handStatus.classList.remove('visible');
    }

    const now = performance.now();

    if (STATE.latestWorldLandmarks) {
      if (STATE.debugMode) {
        const snap = getDebugSnapshot(STATE.latestWorldLandmarks, STATE.latestLandmarks, STATE.isRightHand);
        updateDebugPanel(snap);
      }

      if (now >= STATE.cooldownUntil) {
        const gesture = STATE.classifier.classify(STATE.latestWorldLandmarks, STATE.latestLandmarks);

        if (gesture) {
          DOM.detectedNumber.textContent = gesture.number;
          DOM.detectedNumber.className = 'detected-number visible';
          DOM.detected.style.opacity = '1';

          if (gesture.number !== STATE.lastDetectedNumber && STATE.game.state === 'playing') {
            STATE.lastDetectedNumber = gesture.number;
            STATE.game.submitAnswer(gesture.number);
            STATE.classifier.flush();
            STATE.cooldownUntil = now + 2000;
          }
        } else {
          STATE.lastDetectedNumber = null;
          DOM.detectedNumber.textContent = '—';
          DOM.detectedNumber.className = 'detected-number';
          DOM.detected.style.opacity = '0.5';
        }
      } else {
        DOM.detectedNumber.textContent = '—';
        DOM.detectedNumber.className = 'detected-number';
        DOM.detected.style.opacity = '0.5';
      }
    } else {
      // worldLandmarks null (known MediaPipe bug #5822):
      // keep hand visible, show skeleton, but can't classify
      if (STATE.debugMode) updateDebugPanel(null);
      DOM.detectedNumber.textContent = '—';
      DOM.detectedNumber.className = 'detected-number';
      DOM.detected.style.opacity = '0.5';
      STATE.lastDetectedNumber = null;
      STATE.classifier.flush();
    }
  } else {
    if (STATE.debugMode) updateDebugPanel(null);

    if (STATE.handVisible) {
      STATE.handVisible = false;
      DOM.video.style.opacity = '1';
      DOM.detected.style.opacity = '0.3';
      DOM.detectedNumber.className = 'detected-number';
      if (DOM.handStatus) DOM.handStatus.classList.add('visible');
    }
    STATE.lastDetectedNumber = null;
    STATE.classifier.flush();
  }

  STATE.animationId = requestAnimationFrame(processFrame);
}

function initUI() {
  DOM.video = document.getElementById('webcam');
  DOM.canvas = document.getElementById('overlay');
  DOM.ctx = DOM.canvas.getContext('2d');
  DOM.question = document.getElementById('question');
  DOM.score = document.getElementById('score');
  DOM.combo = document.getElementById('combo');
  DOM.level = document.getElementById('level');
  DOM.feedback = document.getElementById('feedback');
  DOM.detected = document.getElementById('detected');
  DOM.detectedNumber = document.getElementById('detected-number');
  DOM.startBtn = document.getElementById('start-btn');
  DOM.overlay = document.getElementById('game-overlay');
  DOM.loading = document.getElementById('loading');
  DOM.bufferDisplay = document.getElementById('buffer-display');
  DOM.timeBar = document.getElementById('time-bar');
  DOM.pauseBtn = document.getElementById('pause-btn');
  DOM.resumeBtn = document.getElementById('resume-btn');
  DOM.pauseOverlay = document.getElementById('pause-overlay');
  DOM.gameArea = document.getElementById('game-area');
  DOM.handStatus = document.getElementById('hand-status');

  DOM.startBtn.addEventListener('click', startGame);

  if (DOM.pauseBtn) {
    DOM.pauseBtn.addEventListener('click', () => {
      if (STATE.game && STATE.game.state === 'playing') STATE.game.pause();
    });
  }
  if (DOM.resumeBtn) {
    DOM.resumeBtn.addEventListener('click', () => {
      if (STATE.game && STATE.game.state === 'paused') STATE.game.resume();
    });
  }
}

// Flash the camera border on correct / error
function flashCamera(type) {
  if (!DOM.gameArea) return;
  DOM.gameArea.classList.remove('flash-correct', 'flash-error');
  void DOM.gameArea.offsetWidth; // reflow to restart animation
  DOM.gameArea.classList.add(type === 'correct' ? 'flash-correct' : 'flash-error');
  setTimeout(() => DOM.gameArea.classList.remove('flash-correct', 'flash-error'), 650);
}

// Floating +N score popup
function spawnScorePopup(points) {
  if (!DOM.gameArea) return;
  const el = document.createElement('div');
  el.className = 'score-popup';
  el.textContent = `+${points}`;
  el.style.left = `${30 + Math.random() * 40}%`;
  el.style.bottom = '80px';
  DOM.gameArea.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

// Update progress dots
function updateProgressDots(combo) {
  for (let i = 0; i < 10; i++) {
    const dot = document.getElementById(`dot-${i}`);
    if (dot) dot.classList.toggle('done', i < combo);
  }
}

async function startGame() {
  DOM.startBtn.style.display = 'none';
  DOM.overlay.style.display = 'none';

  if (!STATE.handLandmarker) {
    await initMediaPipe();
  }

  if (!DOM.video.srcObject) {
    await initCamera();
  }

  STATE.classifier = new GestureClassifier();
  STATE.game = new Game();

  STATE.game.onScoreChange = (score) => {
    DOM.score.textContent = score;
  };

  STATE.game.onComboChange = (combo) => {
    DOM.combo.textContent = `${combo}×`;
    updateProgressDots(combo);
    if (combo >= 5) {
      DOM.combo.className = 's-val combo-hot';
    } else if (combo >= 3) {
      DOM.combo.className = 's-val combo-warm';
    } else {
      DOM.combo.className = 's-val';
    }
  };

  STATE.game.onQuestionChange = (q) => {
    const diceA = document.getElementById('dice-a');
    const diceB = document.getElementById('dice-b');
    const opSymbol = document.getElementById('op-symbol');

    if (diceA && diceB && opSymbol) {
      diceA.classList.add('rolling');
      diceB.classList.add('rolling');
      opSymbol.textContent = q.symbol;

      // Stop animation and reveal numbers shortly after
      setTimeout(() => {
        diceA.classList.remove('rolling');
        diceA.textContent = q.displayA;
      }, 250);

      setTimeout(() => {
        diceB.classList.remove('rolling');
        diceB.textContent = q.displayB;
      }, 400);
    } else if (DOM.question) {
      DOM.question.textContent = `${q.display} = ?`;
    }

    DOM.feedback.textContent = '';
    DOM.feedback.className = '';
    DOM.bufferDisplay.textContent = '';
    DOM.bufferDisplay.className = '';

    if (q.isCompound) {
      DOM.bufferDisplay.textContent = 'Faça o sinal do 1º dígito...';
      DOM.bufferDisplay.className = 'buffer-active';
    }
  };

  STATE.game.onStateChange = (state) => {
    if (state.startsWith('level_up')) {
      const levelIdx = Number.parseInt(state.split(':')[1]);
      DOM.level.textContent = LEVELS[levelIdx].name;
      DOM.feedback.textContent = `★ Subiu para ${LEVELS[levelIdx].name}! ★`;
      DOM.feedback.className = 'feedback level-up';
    } else if (state === 'playing') {
      DOM.level.textContent = LEVELS[STATE.game.level].name;
      if (DOM.pauseOverlay) DOM.pauseOverlay.classList.remove('show');
    } else if (state === 'paused') {
      if (DOM.pauseOverlay) DOM.pauseOverlay.classList.add('show');
    }
  };

  STATE.game.onFeedback = (msg, type) => {
    DOM.feedback.textContent = msg;
    DOM.feedback.className = `feedback ${type}`;
    if (type === 'correct') {
      flashCamera('correct');
      // extract points from "Correto! +N pts"
      const m = msg.match(/\+(\d+)/);
      if (m) spawnScorePopup(m[1]);
    } else if (type === 'error') {
      flashCamera('error');
    }
  };

  STATE.game.onBufferUpdate = (digit) => {
    if (digit !== null) {
      DOM.bufferDisplay.textContent = `Dígito 1: ${digit} — agora o 2º...`;
      DOM.bufferDisplay.className = 'buffer-active';
    } else {
      DOM.bufferDisplay.textContent = '';
      DOM.bufferDisplay.className = '';
    }
  };

  STATE.game.start();
  STATE.running = true;
  STATE.lastFrameTime = 0;
  STATE.cooldownUntil = 0;
  STATE.lastDetectedNumber = null;

  DOM.level.textContent = LEVELS[0].name;
  DOM.score.textContent = '0';
  DOM.combo.textContent = '0×';
  updateProgressDots(0);

  processFrame();
}

function init() {
  initUI();

  DOM.startBtn.textContent = 'CARREGANDO...';
  DOM.startBtn.disabled = true;

  initMediaPipe()
    .then(() => initCamera())
    .then(() => {
      DOM.startBtn.textContent = '▶ COMEÇAR';
      DOM.startBtn.disabled = false;
    })
    .catch((err) => {
      DOM.loading.textContent = `Erro: ${err.message}. Use um servidor HTTP (ex: npx serve .)`;
      DOM.startBtn.textContent = 'ERRO — veja o console';
      console.error(err);
    });
}

document.addEventListener('DOMContentLoaded', init);
