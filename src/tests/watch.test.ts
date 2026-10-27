// F-20 / R30: o vigia propõe sozinho, respeita o freio e nunca executa nada.
import assert from 'node:assert/strict';
import { cleanDraft, createWatch, diskFreePct, memoryDraft, memoryLine, memoryPlan, systemDisk } from '../watch.ts';
import { EXPIRED } from '../suggestions.ts';
import { DEFAULT_SETTINGS, type AppGroup, type DiskInfo, type MemoryState, type QuickCleanItem, type Settings, type Suggestion, type SuggestionDraft } from '../types.ts';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const T0 = 1_700_000_000_000;
const casos: string[] = [];
const caso = (nome: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { casos.push(nome); });

const app = (key: string, mb: number, state: AppGroup['state'] = 'idle'): AppGroup => ({
  key, name: key, pids: [1], privateWorkingSet: mb * MB, cpuPercent: 0, state,
  reason: state === 'idle' ? 'idle' : 'busy', lastFocusedAt: null,
});
const mem = (memLoad: number, apps: AppGroup[], settings = DEFAULT_SETTINGS): MemoryState => ({
  t: T0, memLoad, totalPhys: 16 * GB, availPhys: 2 * GB, apps, freed: [], settings, startedAt: 0,
  autoCare: { nextEligibleAt: null, lastRunAt: null },
});
const set = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...o });

await caso('a linha vem do Auto Care: 7 pontos antes dele, ou 85 % com ele desligado', () => {
  assert.equal(memoryLine(set({ autoCareEnabled: true, autoCareThreshold: 92 })), 85);
  assert.equal(memoryLine(set({ autoCareEnabled: true, autoCareThreshold: 72 })), 70);   // piso
  assert.equal(memoryLine(set({ autoCareEnabled: false, autoCareThreshold: 92 })), 85);
});

await caso('modo pressão: a linha é a pressão amarela, não a porcentagem', () => {
  const pr = set({ autoCareTrigger: 'pressure' });
  assert.ok(memoryPlan({ ...mem(10, [app('chrome', 900)]), memPressure: 'warn' }, pr));
  assert.equal(memoryPlan({ ...mem(10, [app('chrome', 900)]), memPressure: 'normal' }, pr), null);
  assert.equal(memoryPlan(mem(99, [app('chrome', 900)]), pr), null);   // sem pressão (Windows): quieto
  assert.equal(memoryPlan({ ...mem(10, [app('chrome', 900)]), memPressure: 'warn' }, set({ autoCareTrigger: 'percent' })), null);   // percentual: nada muda
});

await caso('abaixo da linha, ou com pouca coisa parada, não propõe', () => {
  assert.equal(memoryPlan(mem(84, [app('chrome', 900)]), DEFAULT_SETTINGS), null);
  assert.equal(memoryPlan(mem(90, [app('chrome', 100)]), DEFAULT_SETTINGS), null);   // 100 MB < 500 MB
});

await caso('só apps parados entram, maiores primeiro e no máximo 5', () => {
  const apps = [app('a', 200), app('busy', 4000, 'in_use'), app('sys', 4000, 'protected'),
    app('b', 300), app('c', 150), app('d', 120), app('e', 110), app('f', 100)];
  const plan = memoryPlan(mem(90, apps), DEFAULT_SETTINGS);
  assert.ok(plan);
  assert.deepEqual(plan.keys, ['b', 'a', 'c', 'd', 'e']);
  assert.equal(plan.bytes, (300 + 200 + 150 + 120 + 110) * MB);
});

await caso('o cartão de memória diz a porcentagem, o tamanho e que o app pode perguntar antes', () => {
  const plan = memoryPlan(mem(91, [app('chrome', 700), app('excel', 300)]), DEFAULT_SETTINGS)!;
  const d = memoryDraft(plan, 91);
  assert.equal(d.kind, 'liberar_memoria');
  assert.deepEqual(d.items, ['chrome', 'excel']);
  assert.match(d.title, /91 %/);
  assert.match(d.title, /1\.000 MB/);   // 1000 MB ainda não é 1 GB (1024 MB)
  assert.match(d.reason, /chrome e excel/);
  assert.match(d.reason, /não salvo/);
  assert.ok(d.title.length <= 120 && d.reason.length <= 500);
});

await caso('disco: o do sistema, a porcentagem livre e o mínimo de 1 GB para valer o cartão', () => {
  const c: DiskInfo = { drive: 'C:', total: 100 * GB, free: 8 * GB };
  if (process.platform === 'win32') assert.deepEqual(systemDisk([{ drive: 'D:', total: 1, free: 1 }, c]), c);
  assert.equal(systemDisk([]), null);
  const mac = { drive: 'Macintosh HD', total: 1, free: 1 };
  assert.deepEqual(systemDisk([mac]), mac);
  if (process.platform !== 'win32') assert.deepEqual(systemDisk([mac, c]), mac);   // fora do Windows é o primeiro
  assert.equal(Math.round(diskFreePct(c)), 8);
  const pouco: QuickCleanItem[] = [{ category: 'temp_usuario', label: 'Temporários', bytes: 50 * MB, files: 9, actionable: true }];
  assert.equal(cleanDraft(pouco, c), null);
  const muito: QuickCleanItem[] = [
    { category: 'temp_usuario', label: 'Temporários', bytes: 900 * MB, files: 90, actionable: true },
    { category: 'cache_navegador', label: 'Cache', bytes: 800 * MB, files: 800, actionable: true },
    { category: 'lixeira', label: 'Lixeira', bytes: 9 * GB, files: 9, actionable: false },   // fora: não é acionável
  ];
  const d = cleanDraft(muito, c)!;
  assert.equal(d.kind, 'limpeza_rapida');
  assert.deepEqual(d.items, []);
  assert.match(d.title, /1,7 GB/);
  assert.match(d.reason, /Cookies e histórico ficam/);
});

// ---------------- ciclo, com tudo falso ----------------
type Fake = { watch: ReturnType<typeof createWatch>; drafts: SuggestionDraft[]; avisos: string[][]; feitas: Suggestion[]; agora: { t: number } };
function fake(o: { state?: MemoryState | null; settings?: Settings; disks?: DiskInfo[]; clean?: QuickCleanItem[]; recusa?: boolean } = {}): Fake {
  const drafts: SuggestionDraft[] = [];
  const avisos: string[][] = [];
  const feitas: Suggestion[] = [];
  const agora = { t: T0 };
  const watch = createWatch({
    getState: () => (o.state === undefined ? mem(95, [app('chrome', 900)]) : o.state),
    getSettings: () => o.settings ?? DEFAULT_SETTINGS,
    disks: async () => o.disks ?? [],
    quickClean: async () => o.clean ?? [],
    listSuggestions: () => feitas,
    propose: async d => { drafts.push(d); return o.recusa ? { erro: 'não deu', status: 400 } : { id: 'x' }; },
    notify: (t, b) => { avisos.push([t, b]); },
    now: () => agora.t,
  });
  return { watch, drafts, avisos, feitas, agora };
}
const posta = (f: Fake, s: Partial<Suggestion>) =>
  f.feitas.unshift({ id: String(f.feitas.length), t: f.agora.t, source: 'folga', kind: 'liberar_memoria', title: 't', reason: 'r', items: [], bytes: 0, status: 'pendente', ...s });

await caso('precisa de duas leituras seguidas acima da linha (como o Auto Care)', async () => {
  const f = fake();
  await f.watch.tick();
  assert.equal(f.drafts.length, 0, 'uma leitura só não propõe');
  await f.watch.tick();
  assert.equal(f.drafts.length, 1);
  assert.equal(f.drafts[0]!.kind, 'liberar_memoria');
});

await caso('uma leitura abaixo da linha zera a contagem', async () => {
  const alta = mem(95, [app('chrome', 900)]);
  const baixa = mem(10, [app('chrome', 900)]);
  let atual = alta;
  const f = fake();
  const w = createWatch({
    getState: () => atual, getSettings: () => DEFAULT_SETTINGS, disks: async () => [], quickClean: async () => [],
    listSuggestions: () => f.feitas, propose: async d => { f.drafts.push(d); }, now: () => f.agora.t,
  });
  await w.tick();
  atual = baixa; await w.tick();
  atual = alta; await w.tick();
  assert.equal(f.drafts.length, 0);
  await w.tick();
  assert.equal(f.drafts.length, 1);
});

await caso('desligado nos Ajustes, não propõe nada', async () => {
  const f = fake({ settings: set({ watchEnabled: false }) });
  await f.watch.tick(); await f.watch.tick(); await f.watch.tick();
  assert.equal(f.drafts.length, 0);
});

await caso('não propõe de novo enquanto o cartão está esperando resposta', async () => {
  const f = fake();
  posta(f, { status: 'pendente' });
  await f.watch.tick(); await f.watch.tick();
  assert.equal(f.drafts.length, 0);
});

await caso('depois de aprovado espera 1 h; depois de "ignorar" espera 6 h; expirar não conta como "não"', async () => {
  const feita = fake();
  posta(feita, { status: 'feita', doneAt: T0 });
  await feita.watch.tick(); await feita.watch.tick();
  assert.equal(feita.drafts.length, 0, 'logo depois de uma aprovação, não insiste');
  feita.agora.t = T0 + 61 * 60_000;
  await feita.watch.tick(); await feita.watch.tick();
  assert.equal(feita.drafts.length, 1, 'passada 1 h, propõe de novo');

  const nao = fake();
  posta(nao, { status: 'ignorada', doneAt: T0 });   // ignore() do usuário não grava result
  nao.agora.t = T0 + 2 * 60 * 60_000;
  await nao.watch.tick(); await nao.watch.tick();
  assert.equal(nao.drafts.length, 0, '"não" do usuário segura por mais tempo');
  nao.agora.t = T0 + 7 * 60 * 60_000;
  await nao.watch.tick(); await nao.watch.tick();
  assert.equal(nao.drafts.length, 1);

  const velho = fake();
  posta(velho, { status: 'ignorada', doneAt: T0, result: EXPIRED });   // ninguém viu: não é um "não"
  velho.agora.t = T0 + 2 * 60 * 60_000;
  await velho.watch.tick(); await velho.watch.tick();
  assert.equal(velho.drafts.length, 1);
});

await caso('o mesmo tipo não é proposto duas vezes dentro de 1 h, mesmo sem resposta nenhuma', async () => {
  const f = fake();
  await f.watch.tick(); await f.watch.tick();
  assert.equal(f.drafts.length, 1);
  for (let i = 0; i < 10; i++) await f.watch.tick();
  assert.equal(f.drafts.length, 1, 'não repete a cada minuto');
  f.agora.t = T0 + 61 * 60_000;
  await f.watch.tick(); await f.watch.tick();
  assert.equal(f.drafts.length, 2);
});

await caso('disco: só olha a limpeza quando está apertado, e propõe uma vez', async () => {
  let olhou = 0;
  const f = fake({ state: null, disks: [{ drive: 'C:', total: 100 * GB, free: 50 * GB }] });
  const folgado = createWatch({
    getState: () => null, getSettings: () => DEFAULT_SETTINGS,
    disks: async () => [{ drive: 'C:', total: 100 * GB, free: 50 * GB }],
    quickClean: async () => { olhou++; return []; },
    listSuggestions: () => [], propose: async d => { f.drafts.push(d); }, now: () => T0,
  });
  await folgado.tick();
  assert.equal(olhou, 0, 'disco com espaço: nem mede a limpeza');
  assert.equal(f.drafts.length, 0);

  const apertado = createWatch({
    getState: () => null, getSettings: () => DEFAULT_SETTINGS,
    disks: async () => [{ drive: 'C:', total: 100 * GB, free: 8 * GB }],
    quickClean: async () => { olhou++; return [{ category: 'temp_usuario', label: 'Temporários', bytes: 2 * GB, files: 90, actionable: true }]; },
    listSuggestions: () => [], propose: async d => { f.drafts.push(d); }, now: () => T0,
  });
  await apertado.tick();
  assert.equal(olhou, 1);
  assert.equal(f.drafts.length, 1);
  assert.equal(f.drafts[0]!.kind, 'limpeza_rapida');
  for (let i = 0; i < 5; i++) await apertado.tick();
  assert.equal(olhou, 1, 'medir a limpeza é caro: não repete a cada ciclo');
});

await caso('R31: avisa uma vez por proposta, com o título do cartão', async () => {
  const f = fake();
  await f.watch.tick(); await f.watch.tick();
  assert.equal(f.avisos.length, 1);
  assert.equal(f.avisos[0]![0], 'Folga');
  assert.match(f.avisos[0]![1]!, /^Memória em 95 %: dá para liberar .* — toque para decidir\.$/);
  for (let i = 0; i < 5; i++) await f.watch.tick();
  assert.equal(f.avisos.length, 1, 'não avisa de novo enquanto o cartão está lá');
});

await caso('R31: proposta recusada pelo servidor não vira aviso', async () => {
  const f = fake({ recusa: true });
  await f.watch.tick(); await f.watch.tick();
  assert.equal(f.drafts.length, 1);
  assert.equal(f.avisos.length, 0);
});

await caso('uma fonte que falha não derruba o ciclo nem a outra proposta', async () => {
  const drafts: SuggestionDraft[] = [];
  const w = createWatch({
    getState: () => mem(95, [app('chrome', 900)]),
    getSettings: () => DEFAULT_SETTINGS,
    disks: async () => { throw new Error('disco sumiu'); },
    quickClean: async () => [],
    listSuggestions: () => [], propose: async d => { drafts.push(d); }, now: () => T0,
  });
  await w.tick(); await w.tick();
  assert.equal(drafts.length, 1, 'a memória foi proposta mesmo com o disco falhando');
});

console.log(casos.map(c => 'ok  ' + c).join('\n'));
console.log(`watch: ${casos.length} casos ok`);
