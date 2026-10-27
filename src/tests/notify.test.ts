// R31: o aviso do Windows. O texto nunca entra no script (vai por ambiente), e uma falha não insiste.
// O disparo real contra o Windows não entra no `npm test`: encheria a tela de avisos a cada execução.
// Ele foi conferido à mão em 2026-10-18, com título e corpo cheios de aspas, <tag>, & e $(...): saiu com 0.
import assert from 'node:assert/strict';
import { createNotify, notifyCommand, SCRIPT } from '../notify.ts';

const casos: string[] = [];
const caso = (nome: string, fn: () => void) => { fn(); casos.push(nome); };

caso('o script não tem aspas duplas: o -Command do powershell.exe as embaralha', () => {
  assert.ok(!SCRIPT.includes('"'), SCRIPT);
  assert.ok(SCRIPT.includes('$Q = [char]34'), 'a aspa é montada dentro do script');
});

caso('o texto não é interpolado no script: só os nomes das variáveis de ambiente aparecem', () => {
  for (const v of ['FOLGA_TOAST_TITLE', 'FOLGA_TOAST_BODY', 'FOLGA_TOAST_URL']) {
    assert.ok(SCRIPT.includes(`$env:${v}`), v);
  }
  assert.ok(SCRIPT.includes('SecurityElement]::Escape'), 'e tudo passa pelo escape de XML');
});

caso('manda título, corpo e o endereço local do Folga', () => {
  const vistos: string[][] = [];
  const n = createNotify({ port: 4321, run: (t, b, u) => vistos.push([t, b, u]) });
  n.toast('Folga', 'liberar 1 GB — toque para decidir.');
  assert.deepEqual(vistos, [['Folga', 'liberar 1 GB — toque para decidir.', 'http://127.0.0.1:4321']]);
});

caso('se o Windows recusar uma vez, não insiste a cada proposta', () => {
  let n = 0;
  const notify = createNotify({ port: 1, run: () => { n++; throw new Error('sem toast aqui'); } });
  notify.toast('a', 'b');
  notify.toast('c', 'd');
  notify.toast('e', 'f');
  assert.equal(n, 1, 'tentou uma vez e desistiu');
});

caso('avisar nunca derruba quem chamou', () => {
  const notify = createNotify({ port: 1, run: () => { throw new Error('falhou'); } });
  assert.doesNotThrow(() => notify.toast('a', 'b'));
});

caso('Mac dentro do app: o próprio Folga --notify', () => {
  assert.deepEqual(notifyCommand('darwin', { FOLGA_APP: '1', FOLGA_APP_PATH: '/Applications/Folga.app' }),
    { cmd: '/Applications/Folga.app/Contents/MacOS/Folga', args: ['--notify'] });
});

caso('Mac fora do app (ou com caminho torto): osascript com -e fixo que lê o ambiente', () => {
  for (const vars of [{}, { FOLGA_APP: '1', FOLGA_APP_PATH: 'rel/Folga.app' }, { FOLGA_APP: '1', FOLGA_APP_PATH: '/x/Folga' }]) {
    const c = notifyCommand('darwin', vars)!;
    assert.equal(c.cmd, '/usr/bin/osascript');
    assert.equal(c.args[0], '-e');
    assert.ok(c.args[1]!.includes('system attribute "FOLGA_TOAST_TITLE"') && c.args[1]!.includes('system attribute "FOLGA_TOAST_BODY"'));
  }
});

caso('o texto nunca vai nos argumentos, só no ambiente', () => {
  const mau = '"; do shell script "rm -rf ~"';
  for (const vars of [{}, { FOLGA_APP: '1', FOLGA_APP_PATH: '/A/Folga.app' }]) {
    const c = notifyCommand('darwin', { ...vars, FOLGA_TOAST_TITLE: mau })!;
    assert.ok(!c.args.join(' ').includes('rm -rf'));
  }
});

caso('Windows segue o PowerShell de hoje (null)', () => {
  assert.equal(notifyCommand('win32', {}), null);
});

const macApp = { FOLGA_APP: '1', FOLGA_APP_PATH: '/A/Folga.app' };
const APP = '/A/Folga.app/Contents/MacOS/Folga';
/** app responde com os códigos de `appCodes` (um por tentativa); o osascript com `osaCodes` (0 quando acabam) */
function cenario(appCodes: (number | null)[], toques: number[], osaCodes: number[] = []) {
  const vistos: string[] = [];
  let t = 0;
  const n = createNotify({ port: 1, platform: 'darwin', vars: macApp, now: () => t,
    spawnCmd: (cmd, _a, _x, done) => { vistos.push(cmd === APP ? 'app' : 'osa'); done(cmd === APP ? appCodes.shift() ?? 0 : osaCodes.shift() ?? 0); } });
  for (const quando of toques) { t = quando; n.toast('a', 'b'); }
  return vistos;
}

caso('app com autorização pendente (3): osascript desta vez; o app volta depois do recuo de 10 min', () => {
  assert.deepEqual(cenario([3, 0], [0, 1000, 10 * 60_000 + 1, 10 * 60_000 + 2]),
    ['app', 'osa', 'osa', 'app', 'app']);
});

caso('app sem autorização (4): recua 10 min como o 3 (o Vittorio pode ligar depois em Ajustes)', () => {
  assert.deepEqual(cenario([4, 0], [0, 1000, 10 * 60_000 + 1]), ['app', 'osa', 'osa', 'app']);
});

caso('osascript de reserva falhando não cala o app: depois do recuo o aviso volta a sair pelo Folga', () => {
  assert.deepEqual(cenario([4, 0], [0, 11 * 60_000], [1]), ['app', 'osa', 'app']);
});

caso('fora do app, osascript que falha uma vez não insiste (mesma regra do Windows)', () => {
  const vistos: string[] = [];
  const n = createNotify({ port: 1, platform: 'darwin', vars: {}, spawnCmd: (cmd, _a, _x, done) => { vistos.push(cmd); done(1); } });
  n.toast('a', 'b'); n.toast('c', 'd');
  assert.deepEqual(vistos, ['/usr/bin/osascript']);
});

caso('FOLGA_NOTIFY=0 (testes que sobem o servidor): nenhum processo é disparado', () => {
  const vistos: string[] = [];
  for (const platform of ['darwin', 'win32']) {
    createNotify({ port: 1, platform, vars: { FOLGA_NOTIFY: '0' }, spawnCmd: (cmd, _a, _x, done) => { vistos.push(cmd); done(0); } }).toast('a', 'b');
  }
  assert.deepEqual(vistos, []);
});

caso('app ausente (126/127): nunca mais é tentado', () => {
  assert.deepEqual(cenario([127], [0, 99 * 60_000]), ['app', 'osa', 'osa']);
  assert.deepEqual(cenario([126], [0, 99 * 60_000]), ['app', 'osa', 'osa']);
});

caso('falha ao lançar o app (ENOENT/EACCES) é permanente; outro erro de spawn só recua', () => {
  for (const [codigo, depois] of [['ENOENT', 'osa'], ['EACCES', 'osa'], ['EAGAIN', 'app']] as const) {
    const vistos: string[] = [];
    let t = 0;
    const n = createNotify({ port: 1, platform: 'darwin', vars: macApp, now: () => t,
      spawnCmd: (cmd, _a, _x, done) => { vistos.push(cmd === APP ? 'app' : 'osa'); cmd === APP ? done(null, Object.assign(new Error(codigo), { code: codigo })) : done(0); } });
    n.toast('a', 'b'); t = 11 * 60_000; n.toast('a', 'b');
    assert.equal(vistos[1], 'osa', `${codigo}: o primeiro aviso saiu pelo osascript`);
    assert.equal(vistos[2], depois, codigo);
  }
});

caso('o texto nunca vai nos argumentos: só no ambiente extra', () => {
  const mau = '"; do shell script "rm -rf ~"';
  for (const vars of [{}, macApp]) {
    const vistos: { args: string[]; extra: Record<string, string> }[] = [];
    createNotify({ port: 1, platform: 'darwin', vars, spawnCmd: (_c, args, extra, done) => { vistos.push({ args, extra }); done(0); } }).toast(mau, 'corpo-secreto');
    assert.equal(vistos.length, 1);
    assert.ok(!vistos[0]!.args.join(' ').includes('rm -rf') && !vistos[0]!.args.join(' ').includes('corpo-secreto'));
    assert.equal(vistos[0]!.extra.FOLGA_TOAST_TITLE, mau);
    assert.equal(vistos[0]!.extra.FOLGA_TOAST_BODY, 'corpo-secreto');
  }
});

console.log(casos.map(c => 'ok  ' + c).join('\n'));
console.log(`notify: ${casos.length} casos ok`);
