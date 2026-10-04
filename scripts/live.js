'use strict';
// Modalità "live": avvia il server, controlla GitHub ogni 15 s e, se ci sono nuovi commit sul
// branch corrente, li scarica, aggiorna le dipendenze se servono e riavvia il server.
// Le pagine aperte nel browser si ricaricano da sole (le sessioni sono già salvate).
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
let child = null;

function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, LIVE: '1' } });
}
function restart() {
  if (!child) return start();
  child.once('exit', start);
  child.kill();
}
function check() {
  try {
    git('fetch', 'origin', branch);
    const local = git('rev-parse', 'HEAD'), remote = git('rev-parse', 'origin/' + branch);
    if (local === remote) return;
    if (git('merge-base', local, remote) !== local) { console.log('[live] il branch locale ha modifiche non allineate: aggiornamento saltato'); return; }
    const changed = git('diff', '--name-only', local, remote).split('\n');
    git('merge', '--ff-only', 'origin/' + branch);
    if (changed.some(f => f === 'package.json' || f === 'package-lock.json')) execFileSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    console.log(`[live] aggiornato a ${remote.slice(0, 7)}, riavvio il server`);
    restart();
  } catch (e) { console.log('[live] controllo aggiornamenti fallito:', e.message.split('\n')[0]); }
}
start();
console.log(`[live] controllo aggiornamenti del branch "${branch}" ogni 15 secondi`);
setInterval(check, 15000);
process.on('SIGINT', () => { if (child) child.kill(); process.exit(0); });
