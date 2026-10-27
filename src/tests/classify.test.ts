import assert from 'node:assert/strict';
import { appKey, classify, emptyHistory } from '../classify.ts';
import type { ClassifyContext, ClassifyHistory } from '../classify.ts';
import type { AppGroup, ProbeProcess, ProbeSnapshot, Settings } from '../types.ts';
import { DEFAULT_SETTINGS } from '../types.ts';
import { defaultSettings } from '../platform.ts';

const MIN = 60_000;
const MB = 1024 * 1024;
const T0 = 1_000_000_000_000;
const settings: Settings = DEFAULT_SETTINGS;

const casos: string[] = [];
function caso(nome: string, fn: () => void) { fn(); casos.push(nome); }

let nextPid = 100;
const proc = (name: string, o: Partial<ProbeProcess> = {}): ProbeProcess => ({
  pid: nextPid++, ppid: 1, name, description: '', session: 1, privateWorkingSet: 100 * MB,
  cpuTimeMs: 0, hasVisibleWindow: true, accessible: true, ...o,
});
const snapOf = (processes: ProbeProcess[], t: number, foregroundPid: number | null = null): ProbeSnapshot => ({
  type: 'snapshot', t, memLoad: 70, totalPhys: 16 * 1024 * MB, availPhys: 4 * 1024 * MB, foregroundPid, processes,
});
const ctxAt = (now: number, o: Partial<ClassifyContext> = {}): ClassifyContext =>
  ({ selfPids: [], userSession: 1, startedAt: T0, now, ...o });
const find = (r: ReturnType<typeof classify>, key: string) => {
  const g = r.apps.find((a) => a.key === key);
  assert.ok(g, `grupo ${key} ausente`);
  return g;
};

caso('appKey: minúsculo e sem .exe', () => {
  assert.equal(appKey('Chrome.EXE'), 'chrome');
  assert.equal(appKey('chrome.exe'), 'chrome');
  assert.equal(appKey('Figma'), 'figma');
});

caso('a) primeira execução: app com janela, nunca em foco, 5 min -> in_use/recent', () => {
  const r = classify(snapOf([proc('figma.exe')], T0 + 5 * MIN), emptyHistory(), settings, ctxAt(T0 + 5 * MIN));
  const g = find(r, 'figma');
  assert.equal(g.state, 'in_use'); assert.equal(g.reason, 'recent'); assert.equal(g.lastFocusedAt, null);
  assert.equal(r.apps.filter((a) => a.state === 'idle').length, 0);
});

caso('b) mesmo app 31 min depois de startedAt -> idle', () => {
  const g = find(classify(snapOf([proc('figma.exe')], T0 + 31 * MIN), emptyHistory(), settings, ctxAt(T0 + 31 * MIN)), 'figma');
  assert.equal(g.state, 'idle'); assert.equal(g.reason, 'idle');
});

caso('c) app ocupado (delta de CPU de 50 %) -> in_use/busy mesmo parado há horas', () => {
  const p = proc('render.exe', { cpuTimeMs: 1000 });
  const now1 = T0 + 5 * 60 * MIN; // 5 h depois de startedAt, sem nunca ter tido foco
  const h = classify(snapOf([p], now1), emptyHistory(), settings, ctxAt(now1)).history;
  const now2 = now1 + 2000;
  // 1000 ms de CPU em 2000 ms de relógio = 50 %; média com a amostra 0 da primeira leitura = 25 %
  const g = find(classify(snapOf([{ ...p, cpuTimeMs: 2000 }], now2), h, settings, ctxAt(now2)), 'render');
  assert.equal(g.cpuPercent, 25);
  assert.deepEqual([g.state, g.reason], ['in_use', 'busy']);
  // sem a amostra zero, a média é os 50 % cheios
  const g2 = find(classify(snapOf([{ ...p, cpuTimeMs: 2000 }], now2), { ...h, cpuSamples: {} }, settings, ctxAt(now2)), 'render');
  assert.equal(g2.cpuPercent, 50);
});

caso('d) Chrome com 20 processos (1 com janela) -> 1 grupo, soma e pids certos', () => {
  const ps = Array.from({ length: 20 }, (_, i) =>
    proc(i % 2 ? 'chrome.exe' : 'Chrome.EXE', { privateWorkingSet: (i + 1) * MB, hasVisibleWindow: i === 0, description: i === 0 ? '' : 'Google Chrome' }));
  const r = classify(snapOf(ps, T0 + 31 * MIN), emptyHistory(), settings, ctxAt(T0 + 31 * MIN));
  assert.equal(r.apps.length, 1);
  const g = find(r, 'chrome');
  assert.equal(g.pids.length, 20);
  assert.equal(g.privateWorkingSet, (20 * 21 / 2) * MB);
  assert.equal(g.name, 'Google Chrome'); // primeira description não vazia
  assert.equal(g.state, 'idle');
});

caso('nome de exibição sem description: nome original sem .exe', () => {
  assert.equal(find(classify(snapOf([proc('Figma.exe')], T0), emptyHistory(), settings, ctxAt(T0)), 'figma').name, 'Figma');
});

caso('descrição que é só "x.exe" (apps empacotados) não vira nome: "mspaint.exe" -> "Mspaint"', () => {
  const p = { ...proc('mspaint.exe'), description: 'mspaint.exe' };
  assert.equal(find(classify(snapOf([p], T0), emptyHistory(), settings, ctxAt(T0)), 'mspaint').name, 'Mspaint');
});

caso('e) never_close (WindowsTerminal) e SYSTEM (explorer) -> protected', () => {
  const r = classify(snapOf([proc('WindowsTerminal.exe'), proc('explorer.exe')], T0 + 99 * MIN), emptyHistory(), settings, ctxAt(T0 + 99 * MIN));
  const wt = find(r, 'windowsterminal'); const ex = find(r, 'explorer');
  assert.deepEqual([wt.state, wt.reason], ['protected', 'never_close']);
  assert.deepEqual([ex.state, ex.reason], ['protected', 'system']);
});

caso('system: nenhum processo acessível -> protected/system', () => {
  const g = find(classify(snapOf([proc('avgsvc.exe', { accessible: false })], T0 + 99 * MIN), emptyHistory(), settings, ctxAt(T0 + 99 * MIN)), 'avgsvc');
  assert.deepEqual([g.state, g.reason], ['protected', 'system']);
});

caso('f) selfPids: msedge do usuário fica no grupo "msedge"; o do Folga vira "__self"', () => {
  const user = proc('msedge.exe'); const mine = proc('msedge.exe');
  const r = classify(snapOf([user, mine], T0 + 99 * MIN), emptyHistory(), settings, ctxAt(T0 + 99 * MIN, { selfPids: [mine.pid] }));
  assert.deepEqual(find(r, 'msedge').pids, [user.pid]);
  const s = find(r, '__self');
  assert.deepEqual(s.pids, [mine.pid]);
  assert.deepEqual([s.name, s.state, s.reason], ['Folga', 'protected', 'self']);
  const sem = classify(snapOf([user], T0), emptyHistory(), settings, ctxAt(T0, { selfPids: [999] }));
  assert.equal(sem.apps.some((a) => a.key === '__self'), false);
});

caso('g) sessão 0 -> other_session; sem janela na sessão do usuário -> no_window', () => {
  const r = classify(snapOf([proc('svchost.exe', { session: 0 }), proc('helper.exe', { hasVisibleWindow: false })], T0 + 99 * MIN),
    emptyHistory(), settings, ctxAt(T0 + 99 * MIN));
  const a = find(r, 'svchost'); const b = find(r, 'helper');
  assert.deepEqual([a.state, a.reason], ['protected', 'other_session']);
  assert.deepEqual([b.state, b.reason], ['protected', 'no_window']);
});

caso('h) foreground -> in_use/foreground e lastFocusedAt = now; 31 min sem foco -> idle', () => {
  const p = proc('slack.exe');
  const r1 = classify(snapOf([p], T0 + MIN, p.pid), emptyHistory(), settings, ctxAt(T0 + MIN));
  const g1 = find(r1, 'slack');
  assert.deepEqual([g1.state, g1.reason, g1.lastFocusedAt], ['in_use', 'foreground', T0 + MIN]);
  const t2 = T0 + MIN + 29 * MIN;
  assert.equal(find(classify(snapOf([p], t2), r1.history, settings, ctxAt(t2)), 'slack').reason, 'recent');
  const t3 = T0 + MIN + 31 * MIN;
  const g3 = find(classify(snapOf([p], t3), r1.history, settings, ctxAt(t3)), 'slack');
  assert.deepEqual([g3.state, g3.reason, g3.lastFocusedAt], ['idle', 'idle', T0 + MIN]);
});

caso('i) amostras de CPU com mais de 30 s são descartadas', () => {
  const p = proc('work.exe');
  let h = emptyHistory(); let cpuMs = 0; let r!: ReturnType<typeof classify>;
  // 20 s a 100 % de um núcleo, leitura a cada 2 s
  for (let t = 2000; t <= 20_000; t += 2000) {
    cpuMs += 2000;
    r = classify(snapOf([{ ...p, cpuTimeMs: cpuMs }], T0 + t), h, settings, ctxAt(T0 + t)); h = r.history;
  }
  assert.ok(find(r, 'work').cpuPercent >= 5);
  // depois 40 s sem consumir CPU: as amostras ocupadas saem da janela
  for (let t = 22_000; t <= 60_000; t += 2000) {
    r = classify(snapOf([{ ...p, cpuTimeMs: cpuMs }], T0 + t), h, settings, ctxAt(T0 + t)); h = r.history;
  }
  assert.equal(find(r, 'work').cpuPercent, 0);
  const amostras = h.cpuSamples['work'] ?? [];
  assert.ok(amostras.every((s) => T0 + 60_000 - s.t <= 30_000));
  assert.ok(amostras.length <= 16);
});

caso('history.cpu guarda a leitura atual e remove pids que sumiram', () => {
  const a = proc('a.exe'); const b = proc('b.exe');
  const h1 = classify(snapOf([a, b], T0), emptyHistory(), settings, ctxAt(T0)).history;
  assert.deepEqual(Object.keys(h1.cpu).map(Number).sort(), [a.pid, b.pid].sort());
  const h2 = classify(snapOf([a], T0 + 2000), h1, settings, ctxAt(T0 + 2000)).history;
  assert.deepEqual(Object.keys(h2.cpu).map(Number), [a.pid]);
});

caso('j) ordem: idle, in_use, protected; tamanho decrescente em cada um', () => {
  const ps = [
    proc('smallidle.exe', { privateWorkingSet: 10 * MB }),
    proc('bigidle.exe', { privateWorkingSet: 900 * MB }),
    proc('explorer.exe', { privateWorkingSet: 5000 * MB }),
    proc('code.exe', { privateWorkingSet: 400 * MB }),
    proc('fg.exe', { privateWorkingSet: 50 * MB }),
    proc('mididle.exe', { privateWorkingSet: 700 * MB }),
  ];
  const t = T0 + 31 * MIN;
  const r = classify(snapOf(ps, t, ps[4]!.pid), emptyHistory(), settings, ctxAt(t));
  assert.deepEqual(r.apps.map((a) => a.key), ['bigidle', 'mididle', 'smallidle', 'fg', 'explorer', 'code']);
  assert.deepEqual(r.apps.map((a) => a.state), ['idle', 'idle', 'idle', 'in_use', 'protected', 'protected']);
});

caso('k) áudio ativo com janela no fundo -> in_use/audio; sem audioPids volta a idle', () => {
  const sp = proc('Spotify.exe'); const helper = proc('Spotify.exe', { hasVisibleWindow: false });
  const t = T0 + 5 * 60 * MIN; // parado há horas, sem foco
  const comAudio = { ...snapOf([sp, helper], t), audioPids: [helper.pid] }; // o pid que toca pode ser o helper
  const g = find(classify(comAudio, emptyHistory(), settings, ctxAt(t)), 'spotify');
  assert.deepEqual([g.state, g.reason], ['in_use', 'audio']);
  const sem = find(classify(snapOf([sp, helper], t), emptyHistory(), settings, ctxAt(t)), 'spotify');
  assert.deepEqual([sem.state, sem.reason], ['idle', 'idle']);
  const vazio = find(classify({ ...snapOf([sp, helper], t), audioPids: [] }, emptyHistory(), settings, ctxAt(t)), 'spotify');
  assert.equal(vazio.state, 'idle');
  // never_close continua mandando mais que o áudio
  const wt = proc('WindowsTerminal.exe');
  const r = classify({ ...snapOf([wt], t), audioPids: [wt.pid] }, emptyHistory(), settings, ctxAt(t));
  assert.deepEqual([find(r, 'windowsterminal').state, find(r, 'windowsterminal').reason], ['protected', 'never_close']);
});

caso('l) histerese da R04: ocupado só volta a parado abaixo de 60 % da linha', () => {
  const p = proc('excel.exe');
  let h = emptyHistory(); let cpuMs = 0; let t = T0 + 5 * 60 * MIN;   // parado há horas, sem foco
  const ler = (pct: number) => {   // uma leitura 2 s depois, com pct % de um núcleo nesse intervalo
    t += 2000; cpuMs += 20 * pct;
    const r = classify(snapOf([{ ...p, cpuTimeMs: cpuMs }], t), h, settings, ctxAt(t)); h = r.history;
    return find(r, 'excel');
  };
  ler(0);
  for (let i = 0; i < 15; i++) ler(10);
  assert.equal(ler(10).reason, 'busy');                    // 30 s a 10 %
  for (let i = 0; i < 15; i++) ler(4);
  const g = ler(4);                                        // média em 4 %: abaixo de 5, acima de 3
  assert.deepEqual([g.cpuPercent, g.reason], [4, 'busy']); // sem histerese já seria idle
  for (let i = 0; i < 15; i++) ler(2);
  assert.equal(ler(2).state, 'idle');                      // abaixo de 3 %: volta a parado
  for (let i = 0; i < 15; i++) ler(4);
  assert.equal(ler(4).state, 'idle');                      // de parado, 4 % não basta: precisa chegar a 5
});

caso('m) R29: Chrome com 2 janelas, parado há horas -> in_use/multi_window; com 1 janela -> idle', () => {
  const t = T0 + 5 * 60 * MIN;
  const r = classify(snapOf([proc('chrome.exe', { windowCount: 2 }), proc('chrome.exe', { hasVisibleWindow: false, windowCount: 0 })], t),
    emptyHistory(), settings, ctxAt(t));
  const g = find(r, 'chrome');
  assert.deepEqual([g.state, g.reason, g.windows], ['in_use', 'multi_window', 2]);
  const uma = find(classify(snapOf([proc('chrome.exe', { windowCount: 1 })], t), emptyHistory(), settings, ctxAt(t)), 'chrome');
  assert.deepEqual([uma.state, uma.reason], ['idle', 'idle']);
  // app que não é navegador, com várias janelas, continua parado
  assert.equal(find(classify(snapOf([proc('winword.exe', { windowCount: 3 })], t), emptyHistory(), settings, ctxAt(t)), 'winword').state, 'idle');
});

caso('puro: snapshot e history recebidos não são alterados', () => {
  const p = proc('figma.exe', { cpuTimeMs: 500 });
  const snap = snapOf([p, proc('figma.exe')], T0 + 100, p.pid);
  const h: ClassifyHistory = { lastFocusedAt: { x: 1 }, cpu: { [p.pid]: { t: T0, cpuTimeMs: 100 } }, cpuSamples: { figma: [{ t: T0, percent: 3 }] } };
  const snapCopy = structuredClone(snap); const hCopy = structuredClone(h);
  const r = classify(snap, h, settings, ctxAt(T0 + 100));
  assert.deepEqual(snap, snapCopy); assert.deepEqual(h, hCopy);
  assert.notEqual(r.history, h);
});

// ===================== R36: de quem é o processo sem janela =====================
// Cenário real de 2026-10-19: 141 processos node sem janela, uns do Claude Code, outros do ChatGPT.
const semJanela = { hasVisibleWindow: false };
const keys = (g: AppGroup) => g.parents?.map((p) => p.key);

caso('R36: sobe pelo ppid pulando o console e para no app com janela', () => {
  // node <- cmd <- claude(com janela). O cmd no meio não é a resposta útil.
  const claude = proc('claude.exe', { pid: 10, ppid: 1 });
  const cmd = proc('cmd.exe', { pid: 11, ppid: 10, ...semJanela });
  const node = proc('node.exe', { pid: 12, ppid: 11, ...semJanela });
  const r = classify(snapOf([claude, cmd, node], T0), emptyHistory(), settings, ctxAt(T0));
  assert.deepEqual(keys(find(r, 'node')), ['claude']);
  assert.deepEqual(keys(find(r, 'cmd')), ['claude']);
  // o claude tem janela: está em never_close (R05), e aí não se pergunta de quem ele é
  assert.deepEqual([find(r, 'claude').reason, find(r, 'claude').parents], ['never_close', undefined]);
});

caso('R36: sem nenhum ancestral com janela, fica o primeiro app diferente (bandeja)', () => {
  // node <- ChatGPT(sem janela, na bandeja) <- sihost(sessão 0, corta)
  const sihost = proc('sihost.exe', { pid: 20, ppid: 1, session: 0, ...semJanela });
  const chat = proc('ChatGPT.exe', { pid: 21, ppid: 20, ...semJanela });
  const node = proc('node.exe', { pid: 22, ppid: 21, ...semJanela });
  const r = classify(snapOf([sihost, chat, node], T0), emptyHistory(), settings, ctxAt(T0));
  assert.deepEqual(keys(find(r, 'node')), ['chatgpt']);
});

caso('R36: a árvore do sistema não vira pai — nada de "serviço do explorer"', () => {
  const explorer = proc('explorer.exe', { pid: 30, ppid: 1 });
  const drive = proc('GoogleDriveFS.exe', { pid: 31, ppid: 30, ...semJanela });
  const r = classify(snapOf([explorer, drive], T0), emptyHistory(), settings, ctxAt(T0));
  assert.equal(find(r, 'googledrivefs').reason, 'no_window');
  assert.equal(find(r, 'googledrivefs').parents, undefined);
});

caso('R36: quem só lança não é pai (sihost) — nem com app do usuário no meio', () => {
  // codex <- sihost: "serviço do Shell Infrastructure Host" não diz nada ao usuário
  const sihost = proc('sihost.exe', { pid: 80, ppid: 1, ...semJanela });
  const codex = proc('codex.exe', { pid: 81, ppid: 80, ...semJanela });
  const r = classify(snapOf([sihost, codex], T0), emptyHistory(), settings, ctxAt(T0));
  assert.equal(find(r, 'codex').parents, undefined);
});

caso('R36: o próprio Folga também corta a subida', () => {
  const self = proc('node.exe', { pid: 40, ppid: 1, ...semJanela });
  const sonda = proc('powershell.exe', { pid: 41, ppid: 40, ...semJanela });
  const r = classify(snapOf([self, sonda], T0), emptyHistory(), settings, ctxAt(T0, { selfPids: [40] }));
  assert.equal(find(r, 'powershell').parents, undefined);
});

caso('R36: vários pais, maior primeiro por memória, todos na conta', () => {
  const MBp = (n: number) => ({ privateWorkingSet: n * MB, ...semJanela });
  const procs = [
    proc('claude.exe', { pid: 50, ppid: 1 }), proc('ChatGPT.exe', { pid: 51, ppid: 1 }),
    proc('cursor.exe', { pid: 52, ppid: 1 }), proc('codex.exe', { pid: 53, ppid: 1 }),
    proc('node.exe', { pid: 60, ppid: 51, ...MBp(100) }),   // ChatGPT: 100
    proc('node.exe', { pid: 61, ppid: 50, ...MBp(700) }),   // Claude: 700
    proc('node.exe', { pid: 62, ppid: 52, ...MBp(300) }),   // Cursor: 300
    proc('node.exe', { pid: 63, ppid: 53, ...MBp(10) }),    // Codex: 10, o menor, mas entra na conta
  ];
  const r = classify(snapOf(procs, T0), emptyHistory(), settings, ctxAt(T0));
  assert.deepEqual(keys(find(r, 'node')), ['claude', 'cursor', 'chatgpt', 'codex']);
  // os bytes vão junto: é deles que sai o "+ X em serviços" da linha do dono
  assert.deepEqual(find(r, 'node').parents?.map((p) => p.bytes / MB), [700, 300, 100, 10]);
});

caso('R36: laço de ppid termina em vez de travar', () => {
  const a = proc('a.exe', { pid: 70, ppid: 71, ...semJanela });
  const b = proc('b.exe', { pid: 71, ppid: 70, ...semJanela });
  const r = classify(snapOf([a, b], T0), emptyHistory(), settings, ctxAt(T0));
  assert.deepEqual(keys(find(r, 'a')), ['b']);   // o primeiro diferente, e para
  assert.deepEqual(keys(find(r, 'b')), ['a']);
});

caso('R36: só motivo no_window ganha pai', () => {
  const t = T0 + 60 * MIN;
  const r = classify(snapOf([proc('chrome.exe'), proc('explorer.exe')], t), emptyHistory(), settings, ctxAt(t));
  assert.equal(find(r, 'chrome').parents, undefined);     // idle
  assert.equal(find(r, 'explorer').parents, undefined);   // system
});

caso('Mac: helpers somam no bundle; Dock é sistema; Terminal nunca fecha', () => {
  const chrome = proc('com.google.Chrome', { description: 'Google Chrome', session: 501 });
  const helper = proc('com.google.Chrome', { description: 'Google Chrome', session: 501, hasVisibleWindow: false, ppid: chrome.pid });
  const r = classify(snapOf([chrome, helper, proc('com.apple.dock', { description: 'Dock', session: 501 }),
    proc('com.apple.Terminal', { description: 'Terminal', session: 501 })], T0 + 60 * MIN),
    emptyHistory(), defaultSettings('darwin'), ctxAt(T0 + 60 * MIN, { userSession: 501 }));
  assert.deepEqual(find(r, 'com.google.chrome').pids, [chrome.pid, helper.pid]);
  assert.equal(find(r, 'com.google.chrome').name, 'Google Chrome');
  assert.equal(find(r, 'com.google.chrome').state, 'idle');
  assert.equal(find(r, 'com.apple.dock').reason, 'system');
  assert.equal(find(r, 'com.apple.terminal').reason, 'never_close');
});

caso('Mac R29: Chrome pelo bundle id com 3 janelas, parado há 2 h -> in_use/multi_window; 1 janela -> idle', () => {
  const t = T0 + 2 * 60 * MIN;
  const mac = (windowCount: number) => find(classify(snapOf([proc('com.google.Chrome', { description: 'Google Chrome', session: 501, windowCount })], t),
    emptyHistory(), defaultSettings('darwin'), ctxAt(t, { userSession: 501 })), 'com.google.chrome');
  assert.deepEqual([mac(3).state, mac(3).reason, mac(3).windows], ['in_use', 'multi_window', 3]);
  assert.deepEqual([mac(1).state, mac(1).reason], ['idle', 'idle']);
});

casos.forEach((c) => console.log('ok  ' + c));
console.log(`classify: ${casos.length} casos ok`);
