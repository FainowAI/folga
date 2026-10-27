// Liberar sem processos reais: sonda e estado falsos (R07–R09, ADR 0003).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaser } from '../release.ts';
import { DEFAULT_SETTINGS, type AppGroup, type MemoryState, type ProbeCommand, type Settings } from '../types.ts';

const app = (key: string, pids: number[], over: Partial<AppGroup> = {}): AppGroup => ({
  key, name: key, pids, privateWorkingSet: 100, cpuPercent: 0, state: 'idle', reason: 'idle', lastFocusedAt: null, ...over,
});
const mem = (apps: AppGroup[], availPhys: number): MemoryState => ({
  t: 0, memLoad: 80, totalPhys: 1000, availPhys, apps, freed: [], settings: DEFAULT_SETTINGS, startedAt: 0,
  autoCare: { nextEligibleAt: null, lastRunAt: null },
});

function setup(before: MemoryState, after: MemoryState, measured: MemoryState, settings: Settings = DEFAULT_SETTINGS, platform?: NodeJS.Platform, killOk = true) {
  const dir = mkdtempSync(join(tmpdir(), 'folga-rel-'));
  const sent: Omit<ProbeCommand, 'id'>[] = [];
  const queue = [after, measured];
  const releaser = createReleaser({
    dataDir: dir,
    probe: { send: async cmd => { sent.push(cmd); return { type: 'reply', id: 'x', ok: cmd.type === 'close' || killOk, windowsClosed: 1 }; } },
    getState: () => before,
    getSettings: () => settings,
    waitForSnapshot: async () => queue.shift() ?? measured,
    closeWaitMs: 1, measureWaitMs: 1, platform,
  });
  return { dir, sent, releaser };
}

let passed = 0;
const ok = (name: string) => { passed++; console.log(`ok  ${name}`); };

{
  // fechou / ficou aberto / bandeja
  const before = mem([app('calc', [1]), app('notepad', [2]), app('teams', [3, 4]), app('explorer', [9], { state: 'protected', reason: 'system' })], 200);
  const after = mem([app('notepad', [2], { reason: 'idle' }), app('teams', [4], { state: 'protected', reason: 'no_window' }), app('explorer', [9])], 250);
  const measured = mem(after.apps, 330);
  const { dir, sent, releaser } = setup(before, after, measured, DEFAULT_SETTINGS, 'win32');
  const r = await releaser.release(['calc', 'notepad', 'teams'], 'manual');
  assert.ok(!('erro' in r));
  assert.deepEqual(r.results.map(x => [x.key, x.outcome]), [['calc', 'fechou'], ['notepad', 'ficou_aberto'], ['teams', 'bandeja']]);
  ok('R07: fechou, ficou aberto e bandeja');

  assert.equal(r.availAfter - r.availBefore, 130);   // não é a soma dos apps (300)
  ok('R08: liberados = disponível depois − antes, não a soma');

  assert.ok(sent.every(c => c.type === 'close'));
  ok('ADR 0003: sem mayForceQuit nunca manda kill');

  assert.deepEqual(sent, [{ type: 'close', pids: [1], key: 'calc' }, { type: 'close', pids: [2], key: 'notepad' }, { type: 'close', pids: [3, 4], key: 'teams' }]);
  ok('close leva a chave do grupo (a sonda do Mac só fecha pid cujo bundle id é a chave)');

  const log = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].origin, 'manual');
  assert.equal(log[0].availBefore, 200);
  assert.deepEqual(await releaser.readLog(10), log);
  assert.deepEqual(releaser.freed().map(f => f.key), ['calc']);
  ok('R14: uma linha no log.jsonl e calc em Liberados');
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

{
  // bandeja + mayForceQuit → encerrado
  const before = mem([app('teams', [3, 4])], 200);
  const after = mem([app('teams', [4], { state: 'protected', reason: 'no_window' })], 200);
  const settings = { ...DEFAULT_SETTINGS, mayForceQuit: ['teams'] };
  const { dir, sent, releaser } = setup(before, after, mem([], 400), settings, 'win32');
  const r = await releaser.release(['teams'], 'auto');
  assert.ok(!('erro' in r));
  assert.equal(r.results[0]!.outcome, 'encerrado');
  assert.deepEqual(sent.at(-1), { type: 'kill', pids: [4] });
  ok('P03: app de bandeja em mayForceQuit é encerrado, só os pids vivos');
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

{
  // R09: protegido recusa tudo e não manda nada para a sonda
  const before = mem([app('calc', [1]), app('explorer', [9], { state: 'protected', reason: 'system' })], 200);
  const { dir, sent, releaser } = setup(before, before, before);
  const r = await releaser.release(['calc', 'explorer'], 'manual');
  assert.ok('erro' in r && r.status === 409);
  assert.equal(sent.length, 0);
  ok('R09: pedido com protegido recusado inteiro, nada enviado');

  const none = await releaser.release(['sumiu'], 'manual');
  assert.ok('erro' in none && none.status === 409);
  ok('app que sumiu é ignorado; pedido vazio recusado');
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

{
  // menu da barra: o alerta pode ficar aberto; app que voltou a ser usado recusa o pedido, nada enviado
  const before = mem([app('calc', [1]), app('notepad', [2], { state: 'in_use' })], 200);
  const { dir, sent, releaser } = setup(before, before, before);
  const r = await releaser.release(['calc', 'notepad'], 'manual', true);
  assert.ok('erro' in r && r.status === 409 && /notepad voltou a ser usado/.test(r.erro));
  assert.equal(sent.length, 0);
  ok('onlyIdle: app que voltou a ser usado recusa tudo, nada enviado');
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

{
  // uma liberação por vez
  const before = mem([app('calc', [1])], 200);
  const { dir, releaser } = setup(before, mem([], 300), mem([], 300));
  const first = releaser.release(['calc'], 'manual');
  const second = await releaser.release(['calc'], 'manual');
  assert.ok('erro' in second && second.status === 409);
  await first;
  ok('uma liberação por vez (409 na segunda)');
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

{
  // Mac: Cmd+Q; quem não saiu fica aberto (com ou sem janela), forçar só sem janela e em mayForceQuit
  const before = mem([app('com.apple.textedit', [1]), app('com.apple.preview', [2]), app('com.spotify.client', [3, 4]), app('com.tinyapp', [5])], 200);
  const after = mem([app('com.apple.preview', [2]), app('com.spotify.client', [3], { state: 'protected', reason: 'no_window' }),
    app('com.tinyapp', [5], { state: 'protected', reason: 'no_window' })], 250);
  const { dir, sent, releaser } = setup(before, after, mem(after.apps, 300), { ...DEFAULT_SETTINGS, mayForceQuit: ['com.tinyapp', 'com.apple.preview'] }, 'darwin');
  const r = await releaser.release(['com.apple.textedit', 'com.apple.preview', 'com.spotify.client', 'com.tinyapp'], 'manual');
  assert.ok(!('erro' in r));
  assert.deepEqual(r.results.map(x => [x.key, x.outcome]), [['com.apple.textedit', 'fechou'], ['com.apple.preview', 'ficou_aberto'],
    ['com.spotify.client', 'ficou_aberto'], ['com.tinyapp', 'encerrado']]);
  assert.deepEqual(sent.filter(c => c.type === 'kill'), [{ type: 'kill', pids: [5] }]);   // Preview tem janela: nunca forçado
  ok('Mac: quem não saiu fica aberto; forçar só sem janela e em mayForceQuit');
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

{
  // kill que a sonda recusou (ok:false) mantém o desfecho anterior, nos dois sistemas
  const before = mem([app('teams', [3])], 200);
  const after = mem([app('teams', [3], { state: 'protected', reason: 'no_window' })], 200);
  const settings = { ...DEFAULT_SETTINGS, mayForceQuit: ['teams'] };
  for (const [platform, esperado] of [['win32', 'bandeja'], ['darwin', 'ficou_aberto']] as const) {
    const { dir, sent, releaser } = setup(before, after, after, settings, platform, false);
    const r = await releaser.release(['teams'], 'manual');
    assert.ok(!('erro' in r));
    assert.equal(r.results[0]!.outcome, esperado);
    assert.deepEqual(sent.at(-1), { type: 'kill', pids: [3] });
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  ok('kill com ok:false não vira encerrado (bandeja no Windows, ficou_aberto no Mac)');
}

{
  // probe.cs devolve ok:false se algum pid já tinha saído; o grupo sumido na leitura seguinte é encerrado igual
  const before = mem([app('teams', [3])], 200);
  const after = mem([app('teams', [3], { state: 'protected', reason: 'no_window' })], 200);
  const settings = { ...DEFAULT_SETTINGS, mayForceQuit: ['teams'] };
  for (const platform of ['win32', 'darwin'] as const) {
    const { dir, releaser } = setup(before, after, mem([], 400), settings, platform, false);
    const r = await releaser.release(['teams'], 'manual');
    assert.ok(!('erro' in r));
    assert.equal(r.results[0]!.outcome, 'encerrado');
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  ok('kill com ok:false e grupo sumido na leitura seguinte vira encerrado (Windows e Mac)');
}

{
  // pid reaproveitado por outro app durante a espera nunca é forçado
  const settings = { ...DEFAULT_SETTINGS, mayForceQuit: ['teams'] };
  const before = mem([app('teams', [3, 4])], 200);
  const after = mem([app('teams', [3], { state: 'protected', reason: 'no_window' }), app('intruso', [4])], 200);
  const { dir, sent, releaser } = setup(before, after, after, settings, 'win32');
  await releaser.release(['teams'], 'manual');
  assert.deepEqual(sent.filter(c => c.type === 'kill'), [{ type: 'kill', pids: [3] }]);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });

  const gone = mem([app('intruso', [4])], 200);   // teams sumiu; o pid 4 agora é de outro app
  const s2 = setup(before, gone, gone, settings, 'darwin');
  await s2.releaser.release(['teams'], 'manual');
  assert.equal(s2.sent.filter(c => c.type === 'kill').length, 0);
  await rm(s2.dir, { recursive: true, force: true, maxRetries: 5 });
  ok('kill só nos pids que seguem no mesmo grupo; grupo sumido = nada forçado');
}

console.log(`release: ${passed} casos ok`);
