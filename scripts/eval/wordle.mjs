// Local interaction benchmark. The answer stays server-side and is never supplied to a model.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import assert from 'node:assert/strict';

export function feedback(answer, guess) {
  const result = Array(5).fill('absent');
  const remaining = [...answer];
  [...guess].forEach((letter, i) => {
    if (letter === answer[i]) { result[i] = 'correct'; remaining[i] = null; }
  });
  [...guess].forEach((letter, i) => {
    if (result[i] === 'correct') return;
    const match = remaining.indexOf(letter);
    if (match >= 0) { result[i] = 'present'; remaining[match] = null; }
  });
  return result;
}

assert.deepEqual(feedback('APPLE', 'ALLEY'), ['correct', 'present', 'absent', 'present', 'absent']);
assert.deepEqual(feedback('ABBEY', 'BOBBY'), ['present', 'absent', 'correct', 'absent', 'correct']);

const answers = 'BEACH BLEND BRICK CHAIR CHARM CHEST CHIME CLOUD COAST CRISP DANCE DREAM DRINK FIELD FLAME FLOAT FLOUR FRAME FRESH FROST GHOST GRACE GRAIN GRAPE GRASP HEART HONEY HOUSE LIGHT MANGO MAPLE MARCH METAL MIGHT MOUND MOUSE NIGHT OCEAN OLIVE PAINT PEACH PEARL PHASE PIANO PILOT PLANT PLATE POINT PRIDE PRIZE QUIET RADIO REACH ROAST ROUND SCALE SCARF SCENE SHAPE SHEET SHINE SHORE SIGHT SKILL SLATE SLICE SMILE SMOKE SOUND SPACE SPICE SPOON SPORT STAGE STAIR STAND STEAM STEEL STONE STORM STORY SUGAR SWEET TABLE TEACH THANK THING THUMB TIGER TITLE TOAST TOUCH TOWER TRACE TRACK TRAIL TRAIN TREAT TREND TRIAL TRUST TWICE UNDER UNION UNTIL VALUE VIDEO VISIT VOICE WASTE WATCH WATER WHEAT WHEEL WHITE WHOLE WOMAN WORLD WORTH WRITE YOUTH'.split(' ');
const words = new Set(readFileSync('/usr/share/dict/words', 'utf8').split(/\r?\n/)
  .filter(word => /^[a-z]{5}$/.test(word)).map(word => word.toUpperCase()));
for (const word of [...answers, 'CRANE', 'ADIEU', 'RAISE', 'ARISE', 'STARE', 'ROATE', 'SOARE', 'TARES']) words.add(word);
const answer = answers[randomInt(answers.length)];
const guesses = [];
const startedAt = new Date().toISOString();
const state = () => ({ startedAt, guesses, status: guesses.at(-1)?.word === answer ? 'won' : guesses.length === 6 ? 'lost' : 'playing',
  ...(guesses.length === 6 || guesses.at(-1)?.word === answer ? { answer } : {}) });
const html = readFileSync(new URL('./fixtures/wordle.html', import.meta.url));
let origin;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'GET' && req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/state') { res.end(JSON.stringify(state())); return; }
  if (req.method === 'POST' && req.url === '/guess' && req.headers.origin === origin) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 20) { res.writeHead(413); res.end('{}'); return; }
    }
    const word = body.trim().toUpperCase();
    let error = '';
    if (state().status !== 'playing') error = 'The game has finished.';
    else if (!/^[A-Z]{5}$/.test(word)) error = 'Enter five letters.';
    else if (!words.has(word)) error = 'That word is not in this local dictionary. Try another five-letter word.';
    else guesses.push({ word, feedback: feedback(answer, word), at: new Date().toISOString() });
    res.end(JSON.stringify({ ...state(), error })); return;
  }
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1', () => {
  origin = 'http://127.0.0.1:' + server.address().port;
  console.log('Local Wordle benchmark: ' + origin);
  console.log('Six guesses; hidden random answer; server validates dictionary and repeated-letter feedback.');
});
