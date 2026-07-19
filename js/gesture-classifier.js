// ─── Landmark indices ─────────────────────────────────────────────────────────
const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
};

// ─── Vector math helpers ──────────────────────────────────────────────────────
function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function mag(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function normalize(v) {
  const m = mag(v);
  if (m < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}
function dist3(a, b) {
  return mag(sub(a, b));
}
function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ─── Rotation-Invariant Local Coordinate Projection ──────────────────────────
//
// We construct a local coordinate system based on the palm structure:
//   Y-axis = normalized vector from WRIST (0) to MIDDLE_MCP (9).
//   Z-axis = normal vector to the palm plane (cross product of INDEX_MCP (5) to PINKY_MCP (17)).
//   X-axis = cross product of Y and Z to form an orthonormal basis.
//
// This local basis rotates and translates dynamically WITH the hand.
// By projecting all fingertip points onto this local basis, we eliminate all
// camera-rotation and hand-tilt dependencies.
//
// Extensions are measured as local Y displacement relative to the knuckle (MCP).
// E.g., if index_tip.localY - index_mcp.localY > threshold, it's EXTENDED.

function getLocalCoordinates(lm) {
  const origin = lm[LM.WRIST];

  // Primary direction (Y-axis pointing up from wrist to base of middle finger)
  const yAxis = normalize(sub(lm[LM.MIDDLE_MCP], origin));

  // Vector across the knuckles (INDEX to PINKY)
  const vKnuckles = sub(lm[LM.PINKY_MCP], lm[LM.INDEX_MCP]);

  // Z-axis (orthogonal to palm plane)
  const zAxis = normalize(cross(yAxis, vKnuckles));

  // X-axis (orthogonal to both)
  const xAxis = normalize(cross(yAxis, zAxis));

  // Transform all landmarks to this local space
  return lm.map((pt) => {
    const v = sub(pt, origin);
    return {
      x: dot(v, xAxis),
      y: dot(v, yAxis),
      z: dot(v, zAxis),
    };
  });
}

// ─── Rotation-Invariant Joint Angles ─────────────────────────────────────────
//
// Calculates joint flexion angles in 3D.
// Highly robust against scale and orientation.
function getJointAngle(lm, a, b, c) {
  const v1 = sub(lm[a], lm[b]);
  const v2 = sub(lm[c], lm[b]);
  const m = mag(v1) * mag(v2);
  if (m < 1e-9) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot(v1, v2) / m))) * 180) / Math.PI;
}

// Calculates the ratio of straight-line distance from MCP to TIP vs the sum of finger segments.
// 1.0 means perfectly straight, < 0.90 means bent/hooked.
function getFingerStraightness(lm, mcp, pip, dip, tip) {
  const dDirect = dist3(lm[mcp], lm[tip]);
  const dTrack = dist3(lm[mcp], lm[pip]) + dist3(lm[pip], lm[dip]) + dist3(lm[dip], lm[tip]);
  if (dTrack < 1e-9) return 0;
  return dDirect / dTrack;
}

// ─── Finger State Classification ─────────────────────────────────────────────
//
// Evaluates finger curl/extension using local Y coordinates.
// Values normalized by the length of the palm (WRIST to MIDDLE_MCP distance).

function getFingerStates(localLm, palmSize) {
  const getFState = (tip, mcp, thresholdExt, thresholdCurl) => {
    const localYDiff = (localLm[tip].y - localLm[mcp].y) / palmSize;
    if (localYDiff > thresholdExt) return 'E'; // Extended (pointing up relative to knuckle)
    if (localYDiff < thresholdCurl) return 'C'; // Curled (tucked down)
    return 'H'; // Half/bent
  };

  // The thumb is evaluated using relative lateral distance (local X) and MCP joint flexion
  const thumbLocalX = localLm[LM.THUMB_TIP].x / palmSize;
  const thumbFlexion = getJointAngle(localLm, LM.THUMB_CMC, LM.THUMB_MCP, LM.THUMB_IP);

  let thumbState = 'H';
  // Consider thumb extended if it is straight (flexion > 140) OR
  // (flexion > 100 AND sufficiently far from palm). This is highly rotation-invariant.
  if (thumbFlexion > 135) {
    thumbState = 'E';
  } else if (Math.abs(thumbLocalX) > 0.4 && thumbFlexion > 100) {
    thumbState = 'E';
  } else if (Math.abs(thumbLocalX) < 0.3 || thumbFlexion < 90) {
    thumbState = 'C';
  }

  return {
    thumb: thumbState,
    index: getFState(LM.INDEX_TIP, LM.INDEX_MCP, 0.45, 0.15),
    middle: getFState(LM.MIDDLE_TIP, LM.MIDDLE_MCP, 0.45, 0.15),
    ring: getFState(LM.RING_TIP, LM.RING_MCP, 0.45, 0.15),
    pinky: getFState(LM.PINKY_TIP, LM.PINKY_MCP, 0.4, 0.15),
  };
}

// ─── Libras Gesture Matches (Image-Based) ────────────────────────────────────
// Correct matching rules strictly mapped from the provided visual chart:
//
// 1: Indicador esticado (E), restantes fechados (C).
// 2: Indicador + Médio (E), restantes fechados (C). "V da paz".
// 3: Indicador + Médio + Anelar (E), mindinho e polegar fechados (C).
// 4: Indicador + Médio + Anelar + Mindinho (E), polegar fechado (C).
// 5: Indicador + Médio dobrados em gancho (H), restantes fechados (C).
// 6: Polegar estendido (E), restantes fechados (C). Mão apontando para CIMA/LADO.
// 7: Indicador + Polegar estendidos (E). Mão apontando para BAIXO.
// 8: Todos os dedos fechados em punho (C).
// 9: Polegar estendido (E), restantes fechados (C). Mão apontando para BAIXO.

function is(s, expected) {
  return s === expected;
}

function detectNumber(st, lm2d, localLm, palmSize, isRightHand, worldLandmarks) {
  if (!lm2d || !localLm) return null;

  // Se o dorso da mão estiver virado para a câmera, invalidamos a detecção.
  // Para a mão direita (isRightHand), o vetor normal do plano da palma (zAxis.z) deve ser positivo.
  // Para a mão esquerda (!isRightHand), o vetor normal deve ser negativo.
  if (isRightHand !== undefined && worldLandmarks) {
    const origin = worldLandmarks[LM.WRIST];
    const yAxis = normalize(sub(worldLandmarks[LM.MIDDLE_MCP], origin));
    const vKnuckles = sub(worldLandmarks[LM.PINKY_MCP], worldLandmarks[LM.INDEX_MCP]);
    const zAxis = normalize(cross(yAxis, vKnuckles));

    const isPalm = isRightHand ? zAxis.z < 0.15 : zAxis.z > -0.15;
    if (!isPalm) return null;
  }

  const palmSize2D = dist2(lm2d[LM.WRIST], lm2d[LM.MIDDLE_MCP]);

  // 0: Todos os dedos curvados formando um círculo (O), com as pontas tocando o polegar.
  if (
    (is(st.thumb, 'C') || is(st.thumb, 'H')) &&
    (is(st.index, 'C') || is(st.index, 'H')) &&
    (is(st.middle, 'C') || is(st.middle, 'H')) &&
    (is(st.ring, 'C') || is(st.ring, 'H')) &&
    (is(st.pinky, 'C') || is(st.pinky, 'H'))
  ) {
    // Usamos distâncias 3D reais (worldLandmarks) porque as 2D sobrepõem as pontas em ângulos fechados.
    // No 0, todas as pontas tocam no polegar fisicamente na vida real.
    // Num punho fechado (8), as pontas ficam escondidas, longe do polegar em 3D.
    const thumbIndexDist3D =
      dist3(worldLandmarks[LM.THUMB_TIP], worldLandmarks[LM.INDEX_TIP]) / palmSize;
    const thumbMiddleDist3D =
      dist3(worldLandmarks[LM.THUMB_TIP], worldLandmarks[LM.MIDDLE_TIP]) / palmSize;
    const thumbRingDist3D =
      dist3(worldLandmarks[LM.THUMB_TIP], worldLandmarks[LM.RING_TIP]) / palmSize;

    if (thumbIndexDist3D < 0.45 && thumbMiddleDist3D < 0.45 && thumbRingDist3D < 0.45) {
      return 0;
    }
  }

  // 1: Apenas Indicador estendido (Ignoramos o polegar para permitir que fique em qualquer posição lateral)
  if (is(st.index, 'E') && is(st.middle, 'C') && is(st.ring, 'C') && is(st.pinky, 'C')) return 1;

  // 5: Duas orelhas de coelho dobradas - Indicador + Médio em gancho (H ou E sob distorção do Z), mindinho fechado/dobrado, polegar livre
  if (
    (is(st.index, 'E') || is(st.index, 'H')) &&
    (is(st.middle, 'E') || is(st.middle, 'H')) &&
    (is(st.pinky, 'C') || is(st.pinky, 'H'))
  ) {
    const indexStraightness = getFingerStraightness(
      localLm,
      LM.INDEX_MCP,
      LM.INDEX_PIP,
      LM.INDEX_DIP,
      LM.INDEX_TIP,
    );
    const middleStraightness = getFingerStraightness(
      localLm,
      LM.MIDDLE_MCP,
      LM.MIDDLE_PIP,
      LM.MIDDLE_DIP,
      LM.MIDDLE_TIP,
    );

    // Calculamos o comprimento 2D projetado para detectar ganchos mesmo se o MediaPipe estimar as juntas como retas em 3D.
    const indexLength2D = dist2(lm2d[LM.INDEX_MCP], lm2d[LM.INDEX_TIP]) / palmSize2D;
    const middleLength2D = dist2(lm2d[LM.MIDDLE_MCP], lm2d[LM.MIDDLE_TIP]) / palmSize2D;
    const ringLength2D = dist2(lm2d[LM.RING_MCP], lm2d[LM.RING_TIP]) / palmSize2D;
    const pinkyLength2D = dist2(lm2d[LM.PINKY_MCP], lm2d[LM.PINKY_TIP]) / palmSize2D;
    const tipDist = dist2(lm2d[LM.INDEX_TIP], lm2d[LM.MIDDLE_TIP]) / palmSize2D;

    if (
      tipDist > 0.18 &&
      ringLength2D < 0.6 &&
      pinkyLength2D < 0.6 &&
      (indexStraightness < 0.94 ||
        middleStraightness < 0.94 ||
        indexLength2D < 0.68 ||
        middleLength2D < 0.68)
    ) {
      return 5;
    }
  }

  // 2 e 3: Ambos possuem Indicador + Médio estendidos e Anelar + Mindinho fechados.
  // No sinal de 3 do LIBRAS, os dedos estendidos são Indicador, Médio e Anelar (conforme a folha de referência).
  // Portanto, verificamos se o Anelar está E para retornar 3.
  if (
    is(st.index, 'E') &&
    is(st.middle, 'E') &&
    is(st.ring, 'E') &&
    (is(st.pinky, 'C') || is(st.pinky, 'H'))
  ) {
    return 3;
  }

  // 2: Indicador + Médio estendidos (V da paz)
  if (
    is(st.index, 'E') &&
    is(st.middle, 'E') &&
    (is(st.ring, 'C') || is(st.ring, 'H')) &&
    (is(st.pinky, 'C') || is(st.pinky, 'H'))
  ) {
    const tipDist = dist2(lm2d[LM.INDEX_TIP], lm2d[LM.MIDDLE_TIP]) / palmSize2D;
    if (tipDist > 0.22) {
      return 2;
    }
  }

  // 4: Indicador + Médio + Anelar + Mindinho estendidos.
  // O polegar deve estar recolhido sobre a palma (thumbX < 0.20) para distinguir da palma aberta (não numérica).
  if (is(st.index, 'E') && is(st.middle, 'E') && is(st.ring, 'E') && is(st.pinky, 'E')) {
    const thumbX = localLm[LM.THUMB_TIP].x / palmSize;
    if (Math.abs(thumbX) < 0.2) {
      return 4;
    }
  }

  // 7: Polegar e Indicador estendidos (L invertido), apontando para BAIXO.
  // Usamos diferenças no eixo Y em 2D para garantir robustez e independência de inclinação da mão.
  // Permitimos que o polegar seja classificado como E ou H (semi-esticado) contanto que esteja afastado lateralmente.
  const thumbX = localLm[LM.THUMB_TIP].x / palmSize;
  if ((is(st.thumb, 'E') || is(st.thumb, 'H')) && Math.abs(thumbX) > 0.22) {
    const indexPointingDown = lm2d[LM.INDEX_TIP].y > lm2d[LM.INDEX_MCP].y;
    const indexLength2d = (lm2d[LM.INDEX_TIP].y - lm2d[LM.INDEX_MCP].y) / palmSize2D;
    const indexMiddleYDiff = (lm2d[LM.INDEX_TIP].y - lm2d[LM.MIDDLE_TIP].y) / palmSize2D;
    const indexRingYDiff = (lm2d[LM.INDEX_TIP].y - lm2d[LM.RING_TIP].y) / palmSize2D;
    const indexPinkyYDiff = (lm2d[LM.INDEX_TIP].y - lm2d[LM.PINKY_TIP].y) / palmSize2D;

    if (
      indexPointingDown &&
      indexLength2d > 0.45 &&
      indexMiddleYDiff > 0.18 &&
      indexRingYDiff > 0.18 &&
      indexPinkyYDiff > 0.18
    ) {
      return 7;
    }
  }

  // 8, 6, 9: Dedos indicador, médio, anelar e mindinho fechados (C).
  if (is(st.index, 'C') && is(st.middle, 'C') && is(st.ring, 'C') && is(st.pinky, 'C')) {
    // Usamos distâncias 3D para evitar os falsos positivos das projeções 2D.
    // O eixo X local se inverte com rotações estranhas, e o 2D sobrepõe dedos que estão longe.

    // Distância 3D da ponta do polegar até o centro da palma (MIDDLE_MCP).
    // No punho fechado (8), o polegar dobra em cima da palma e a distância é curta.
    // No laço (6/9), o polegar se estica para a frente/lado e a distância é longa.
    const thumbDistToPalm3D =
      dist3(worldLandmarks[LM.THUMB_TIP], worldLandmarks[LM.MIDDLE_MCP]) / palmSize;

    // Distância 3D da ponta do indicador até o polegar (ponta ou junta) para checar o laço
    const distToTip3D = dist3(worldLandmarks[LM.THUMB_TIP], worldLandmarks[LM.INDEX_TIP]);
    const distToIP3D = dist3(worldLandmarks[LM.THUMB_IP], worldLandmarks[LM.INDEX_TIP]);
    const thumbIndexDist3D = Math.min(distToTip3D, distToIP3D) / palmSize;

    // Se o polegar está fisicamente colado no centro da mão, é o punho fechado (8).
    if (
      is(st.thumb, 'C') ||
      thumbDistToPalm3D < 0.7 ||
      (is(st.thumb, 'H') && thumbIndexDist3D > 0.4)
    ) {
      return 8;
    }

    // Se passou do 8 e o polegar está estendido/semi-estendido e as pontas do indicador e polegar estão fisicamente próximas, é 6 ou 9.
    if ((is(st.thumb, 'E') || is(st.thumb, 'H')) && thumbIndexDist3D < 0.45) {
      // 6 e 9 são o MESMO sinal, apenas rotacionados na câmera.
      // Não podemos usar coordenadas locais para distingui-los, pois na mão, o polegar aponta para a mesma direção em ambos.
      // Em 6, a mão aponta para cima na câmera. Em 9, a mão aponta para baixo.
      // Checamos a posição da ponta do polegar em relação à junta do dedo médio (em coordenadas 2D da tela).
      // No 6, o polegar aponta para cima na tela (menor Y que a junta). No 9, para baixo (maior Y que a junta).
      // Isso é imune à flexão e extensão do pulso.
      const handPointingUp = lm2d[LM.THUMB_TIP].y < lm2d[LM.MIDDLE_MCP].y;
      const handPointingDown = lm2d[LM.THUMB_TIP].y > lm2d[LM.MIDDLE_MCP].y;

      if (handPointingUp) return 6;
      if (handPointingDown) return 9;
    }
  }

  return null;
}

// ─── GestureClassifier Class ─────────────────────────────────────────────────
const BUFFER_SIZE = 10;
const STABILITY_RATIO = 0.6;
const MIN_HOLD_MS = 150;

class GestureClassifier {
  constructor() {
    this.buffer = [];
    this._stableSince = 0;
    this._lastStable = null;
  }

  classify(worldLandmarks, lm2d, isRightHand) {
    if (!worldLandmarks || worldLandmarks.length < 21) {
      this._push(null);
      return null;
    }

    const localLm = getLocalCoordinates(worldLandmarks);
    const palmSize = dist3(worldLandmarks[LM.WRIST], worldLandmarks[LM.MIDDLE_MCP]);
    const st = getFingerStates(localLm, palmSize);

    // Passamos o localLm (3D local), o palmSize e dados de orientação para ter acesso a dados espaciais detalhados nas regras
    const detected = detectNumber(st, lm2d, localLm, palmSize, isRightHand, worldLandmarks);

    this._push(detected);
    return this._stable();
  }

  _push(v) {
    this.buffer.push(v);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
  }

  _stable() {
    if (this.buffer.length < BUFFER_SIZE) {
      this._stableSince = 0;
      return null;
    }

    const counts = {};
    for (const v of this.buffer) {
      if (v !== null) counts[v] = (counts[v] || 0) + 1;
    }

    let best = null;
    let bestCount = 0;
    for (const [n, c] of Object.entries(counts)) {
      if (c > bestCount) {
        bestCount = c;
        best = Number(n);
      }
    }

    if (best === null || bestCount / BUFFER_SIZE < STABILITY_RATIO) {
      this._stableSince = 0;
      this._lastStable = null;
      return null;
    }

    const now = performance.now();
    if (this._lastStable !== best) {
      this._stableSince = now;
      this._lastStable = best;
    }
    if (now - this._stableSince < MIN_HOLD_MS) return null;

    return { number: best, confidence: bestCount / BUFFER_SIZE };
  }

  flush() {
    this.buffer = [];
    this._stableSince = 0;
    this._lastStable = null;
  }
}

// ─── Debug snapshot ───────────────────────────────────────────────────────────
function getDebugSnapshot(worldLandmarks, lm2d, isRightHand) {
  if (!worldLandmarks || worldLandmarks.length < 21) return null;

  const localLm = getLocalCoordinates(worldLandmarks);
  const palmSize = dist3(worldLandmarks[LM.WRIST], worldLandmarks[LM.MIDDLE_MCP]);
  const st = getFingerStates(localLm, palmSize);

  const indexStr = getFingerStraightness(
    localLm,
    LM.INDEX_MCP,
    LM.INDEX_PIP,
    LM.INDEX_DIP,
    LM.INDEX_TIP,
  ).toFixed(2);
  const middleStr = getFingerStraightness(
    localLm,
    LM.MIDDLE_MCP,
    LM.MIDDLE_PIP,
    LM.MIDDLE_DIP,
    LM.MIDDLE_TIP,
  ).toFixed(2);

  const localY = {
    index: `${((localLm[LM.INDEX_TIP].y - localLm[LM.INDEX_MCP].y) / palmSize).toFixed(2)} (s:${indexStr})`,
    middle: `${((localLm[LM.MIDDLE_TIP].y - localLm[LM.MIDDLE_MCP].y) / palmSize).toFixed(2)} (s:${middleStr})`,
    ring: ((localLm[LM.RING_TIP].y - localLm[LM.RING_MCP].y) / palmSize).toFixed(2),
    pinky: ((localLm[LM.PINKY_TIP].y - localLm[LM.PINKY_MCP].y) / palmSize).toFixed(2),
  };

  const thumbX = (localLm[LM.THUMB_TIP].x / palmSize).toFixed(2);
  const thumbFlex = getJointAngle(localLm, LM.THUMB_CMC, LM.THUMB_MCP, LM.THUMB_IP).toFixed(0);

  const matched = detectNumber(st, lm2d, localLm, palmSize, isRightHand, worldLandmarks);

  return { st, localY, thumbX, thumbFlex, isRightHand, matched };
}

export { GestureClassifier, getDebugSnapshot };
