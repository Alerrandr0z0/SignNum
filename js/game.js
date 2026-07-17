const LEVELS = [
  {
    id: 1,
    name: 'Iniciação',
    operation: 'add',
    operandsRange: [1, 6],
    answerRange: [2, 9],
    timeLimit: 10,
    description: 'Soma — resultados de 2 a 9',
  },
  {
    id: 2,
    name: 'Consolidação',
    operation: 'mixed',
    operandsRange: [1, 9],
    answerRange: [0, 9],
    timeLimit: 10,
    description: 'Adição e subtração — resultados de 0 a 9',
  },
  {
    id: 3,
    name: 'Domínio',
    operation: 'multiply',
    operandsRange: [2, 6],
    answerRange: [1, 36],
    timeLimit: 12,
    description: 'Multiplicação — resultados de 1 a 36',
  },
];

class Question {
  constructor(a, b, operation) {
    this.a = a;
    this.b = b;
    this.operation = operation;
    const { answer, displayA, displayB, symbol } = this._compute();
    this.answer = answer;
    this.displayA = displayA;
    this.displayB = displayB;
    this.symbol = symbol;
    this.display = `${displayA} ${symbol} ${displayB}`;
    this.isCompound = this.answer > 9;
  }

  _compute() {
    switch (this.operation) {
      case 'add':
        return { answer: this.a + this.b, displayA: this.a, displayB: this.b, symbol: '+' };
      case 'subtract':
        return { answer: this.a - this.b, displayA: this.a, displayB: this.b, symbol: '−' };
      case 'multiply':
        return { answer: this.a * this.b, displayA: this.a, displayB: this.b, symbol: '×' };
      case 'mixed': {
        const useAdd = Math.random() < 0.6;
        if (useAdd) {
          return { answer: this.a + this.b, displayA: this.a, displayB: this.b, symbol: '+' };
        }
        const big = Math.max(this.a, this.b);
        const small = Math.min(this.a, this.b);
        return { answer: big - small, displayA: big, displayB: small, symbol: '−' };
      }
      default:
        return { answer: this.a + this.b, displayA: this.a, displayB: this.b, symbol: '+' };
    }
  }
}

class Game {
  constructor() {
    this.level = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.totalCorrect = 0;
    this.totalAttempts = 0;
    this.currentQuestion = null;
    this.state = 'idle';
    this._transitioning = false;
    this.buffer = [];
    this.questionStartTime = 0;
    this.timeRemaining = 0;

    this.onScoreChange = null;
    this.onQuestionChange = null;
    this.onStateChange = null;
    this.onFeedback = null;
    this.onComboChange = null;
    this.onBufferUpdate = null;
  }

  start() {
    this.level = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.totalCorrect = 0;
    this.totalAttempts = 0;
    this.state = 'playing';
    this._transitioning = false;
    this.buffer = [];
    this.nextQuestion();
    if (this.onStateChange) this.onStateChange('playing');
  }

  nextQuestion() {
    const lvl = LEVELS[this.level];
    if (!lvl) return;

    let q;
    let attempts = 0;

    // Force uniqueness (don't repeat the exact same question immediately)
    do {
      const a = randInt(lvl.operandsRange[0], lvl.operandsRange[1]);
      const b = randInt(lvl.operandsRange[0], lvl.operandsRange[1]);
      let op = lvl.operation;

      if (lvl.operation === 'mixed') {
        op = Math.random() < 0.5 ? 'add' : 'subtract';
      }

      q = new Question(a, b, op);
      attempts++;
    } while (
      (q.answer < lvl.answerRange[0] ||
        q.answer > lvl.answerRange[1] ||
        (this.currentQuestion && q.display === this.currentQuestion.display)) &&
      attempts < 20
    );

    this.currentQuestion = q;
    this.buffer = [];
    this.questionStartTime = Date.now();
    this.timeRemaining = lvl.timeLimit;

    if (this.onQuestionChange) this.onQuestionChange(this.currentQuestion);
    if (this.onBufferUpdate) this.onBufferUpdate(null);
  }

  pause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.timeRemaining = this.questionStartTime
        ? Math.max(0, LEVELS[this.level].timeLimit - (Date.now() - this.questionStartTime) / 1000)
        : LEVELS[this.level].timeLimit;
      if (this.onStateChange) this.onStateChange('paused');
    }
  }

  resume() {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.questionStartTime =
        Date.now() - (LEVELS[this.level].timeLimit - this.timeRemaining) * 1000;
      if (this.onStateChange) this.onStateChange('playing');
    }
  }

  submitAnswer(digit) {
    // Reject input if game is not actively playing or if we're in the
    // transition window between resolving an answer and loading the next question.
    if (this.state !== 'playing' || this._transitioning) return;
    const q = this.currentQuestion;
    if (!q) return;

    if (!q.isCompound) {
      this._resolveAnswer(digit === q.answer);
    } else {
      this.buffer.push(digit);
      if (this.onBufferUpdate) this.onBufferUpdate(digit);

      if (this.buffer.length === 1) {
        if (this.onFeedback) {
          this.onFeedback(`Primeiro dígito: ${digit} — agora o segundo`, 'info');
        }
        return;
      }

      if (this.buffer.length === 2) {
        const composed = this.buffer[0] * 10 + this.buffer[1];
        this._resolveAnswer(composed === q.answer);
      }
    }
  }

  _resolveAnswer(correct) {
    this.totalAttempts++;
    this._transitioning = true; // block further input until next question loads
    const lvl = LEVELS[this.level];
    const q = this.currentQuestion;
    const timeLeft = this.questionStartTime
      ? (Date.now() - this.questionStartTime) / 1000
      : lvl.timeLimit;

    if (correct) {
      this.totalCorrect++;
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;

      let bonus = 0;
      if (timeLeft < 3) bonus = 5;
      else if (timeLeft < 5) bonus = 3;
      else if (timeLeft < 7) bonus = 1;

      const basePoints = lvl.id * 10;
      const comboMultiplier = 1 + Math.floor(this.combo / 5) * 0.5;
      const points = Math.round((basePoints + bonus) * comboMultiplier);

      this.score += points;

      if (this.onFeedback) this.onFeedback(`Correto! +${points} pts`, 'correct');
      if (this.onComboChange) this.onComboChange(this.combo);
      if (this.onScoreChange) this.onScoreChange(this.score);

      if (this.combo >= 10) {
        if (this.level < LEVELS.length - 1) {
          this.level++;
          if (this.onStateChange) this.onStateChange(`level_up:${this.level}`);
        }
        this.combo = 0;
        if (this.onComboChange) this.onComboChange(0);
      }

      setTimeout(() => {
        this._transitioning = false;
        if (this.state === 'playing') this.nextQuestion();
      }, 700);
    } else {
      this.combo = 0;
      if (this.onComboChange) this.onComboChange(0);
      if (this.onFeedback && q) this.onFeedback(`Erro! Resposta correta: ${q.answer}`, 'error');

      setTimeout(() => {
        this._transitioning = false;
        if (this.state === 'playing') this.nextQuestion();
      }, 1400);
    }
  }

  update(dt) {
    if (this.state !== 'playing' || !this.currentQuestion) return;
    const lvl = LEVELS[this.level];
    this.timeRemaining -= dt;
    if (this.timeRemaining <= 0) {
      this.timeRemaining = 0;
      this.combo = 0;
      if (this.onComboChange) this.onComboChange(0);
      if (this.onFeedback) {
        this.onFeedback(`Tempo esgotado! Resposta: ${this.currentQuestion.answer}`, 'error');
      }
      setTimeout(() => {
        if (this.state === 'playing') this.nextQuestion();
      }, 1200);
    }
  }

  getAnswerDigits() {
    if (!this.currentQuestion) return [];
    const ans = this.currentQuestion.answer;
    return String(ans).split('').map(Number);
  }
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export { Game, LEVELS, Question };
