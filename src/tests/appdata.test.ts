// Dados dos apps: mede tudo, limpa só cache da allowlist de app fechado. Só pastas temporárias criadas aqui,
// com bases e plataforma injetadas: nunca toca em pasta real de app (R22).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAppData, newestVersion, parseAppDataBases } from '../appdata.ts';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'folga-appdata-')));
function file(p: string, n = 4096) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.alloc(n, 1)); return p; }
const tryLink = (target: string, p: string, type?: 'junction') => { try { symlinkSync(target, p, type); return true; } catch { return false; } };

try {
  // --- Mac ---
  {
    const root = join(tmp, 'mac');
    const appSupport = join(root, 'AppSupport'), caches = join(root, 'Caches');
    const containers = join(root, 'Containers'), groupContainers = join(root, 'GroupContainers');
    const fora = join(root, 'fora');
    const claudeDir = join(appSupport, 'Claude');
    for (const d of ['Cache', 'GPUCache']) file(join(claudeDir, d, 'data_0'));
    file(join(claudeDir, 'vm_bundles', 'claudevm.bundle', 'rootfs.img'), 100_000);
    file(join(claudeDir, 'claude-code', '2.0.9', 'claude'));
    file(join(claudeDir, 'claude-code', '2.0.14', 'claude'));
    file(join(claudeDir, 'Local Storage', 'leveldb', '000.log'));
    for (const b of ['com.spotify.client', 'com.google.chrome', 'com.google.Chrome.ShipIt', 'notion.id.ShipIt', 'com.onevcat.Kingfisher.ImageCache.default', 'com.apple.Safari', 'pip']) file(join(caches, b, 'x'));
    mkdirSync(containers, { recursive: true }); mkdirSync(groupContainers, { recursive: true });
    const user = file(join(fora, 'conversa.json'), 10);
    const isca = tryLink(user, join(claudeDir, 'Cache', 'isca'));   // link dentro do cache para arquivo do usuário

    let running: ReadonlySet<string> | null = new Set(['com.google.chrome', 'notion.id']);
    const installedIds = async () => new Set(['com.spotify.client', 'com.google.chrome', 'notion.id']);
    const ad = createAppData({ platform: 'darwin', bases: { appSupport, caches, containers, groupContainers }, runningKeys: () => running, installedIds });
    const s = await ad.preview();
    const ids = s.entries.flatMap(e => e.items.filter(i => i.actionable).map(i => i.id)).sort();
    assert.deepEqual(ids, ['caches:com.spotify.client', 'claude:Cache', 'claude:GPUCache', 'claude:claude-code/2.0.9']);
    const claude = s.entries.find(e => e.name === 'Claude')!;
    assert.ok(claude.notes.some(n => /máquina virtual/.test(n.text) && n.bytes > 0));
    assert.ok(claude.bytes >= claude.items.reduce((a, i) => a + i.bytes, 0) && claude.items.every(i => i.bytes > 0));
    assert.ok(!s.entries.some(e => e.items.some(i => /vm_bundles|Local Storage|com\.apple|pip|2\.0\.14/.test(i.id))));
    const chrome = s.entries.find(e => e.name === 'com.google.chrome')!;
    assert.ok(chrome.items.length === 1 && !chrome.items[0]!.actionable && /aberto/.test(chrome.items[0]!.note ?? ''));
    const item = (n: string) => s.entries.find(e => e.name === n)!.items[0]!;
    assert.ok(!item('notion.id.ShipIt').actionable && /aberto/.test(item('notion.id.ShipIt').note ?? ''), 'ShipIt de id de 2 partes é do notion.id');
    assert.ok(!item('com.onevcat.Kingfisher.ImageCache.default').actionable && /sem app identificado/.test(item('com.onevcat.Kingfisher.ImageCache.default').note ?? ''));
    assert.ok(s.entries.find(e => e.name === 'pip')!.notes.some(n => /Sem cache reconhecido/.test(n.text)));
    assert.equal(s.totalBytes, s.entries.reduce((a, e) => a + e.bytes, 0));
    // fechar o app destrava o item sem medir de novo: o cache guarda tamanhos, o veredito sai a cada preview
    running = new Set(['notion.id']);
    const chrome2 = (await ad.preview()).entries.find(e => e.name === 'com.google.chrome')!.items[0]!;
    assert.ok(chrome2.actionable && chrome2.note === undefined && chrome2.bytes === chrome.items[0]!.bytes, 'Chrome fechado: acionável no cache');
    running = new Set(['com.google.chrome', 'notion.id']);
    assert.ok(!(await ad.preview()).entries.find(e => e.name === 'com.google.chrome')!.items[0]!.actionable, 'reabriu: trava de novo');

    const r = await ad.clean(['claude:Cache', 'claude:../../Documents', 'caches:com.google.chrome', 'claude:claude-code/2.0.14', 'claude:claude-code/2.0.9']);
    assert.equal(r.skipped, 3);
    assert.equal(existsSync(user), true, 'link dentro do cache: some o link, nunca o alvo');
    assert.ok(!existsSync(join(claudeDir, 'Cache')) && !existsSync(join(claudeDir, 'claude-code', '2.0.9')));
    assert.ok(existsSync(join(claudeDir, 'claude-code', '2.0.14')) && existsSync(join(caches, 'com.google.chrome')));
    assert.ok(existsSync(join(claudeDir, 'vm_bundles', 'claudevm.bundle', 'rootfs.img')));
    running = new Set(['com.anthropic.claudefordesktop']);   // app abriu entre o preview e o clique
    assert.equal((await ad.clean(['claude:GPUCache'])).files, 0); assert.ok(existsSync(join(claudeDir, 'GPUCache')));
    running = null; assert.ok((await ad.preview({ fresh: true })).entries.every(e => e.items.every(i => !i.actionable)));
    assert.equal((await ad.clean(['caches:com.spotify.client'])).files, 0); assert.ok(existsSync(join(caches, 'com.spotify.client')));
    console.log(`ok  mac: só allowlist de app fechado, versão mais nova e máquina virtual ficam${isca ? ', link no cache não leva o alvo' : ' (sem link: pulado)'}`);

    // com.apple sozinho também é da Apple; com.applefoo não
    const cs5 = join(tmp, 'mac-apple');
    for (const b of ['com.apple', 'com.applefoo.cache']) file(join(cs5, b, 'x'));
    const adApple = createAppData({ platform: 'darwin', bases: { caches: cs5 }, runningKeys: () => new Set(), installedIds: async () => new Set(['com.apple', 'com.applefoo']) });
    assert.deepEqual((await adApple.preview()).entries.flatMap(e => e.items.map(i => i.id)), ['caches:com.applefoo.cache']);
    console.log('ok  caches: com.apple e com.apple.* nunca viram item; com.applefoo sim');

    // pasta de regra que é link (Claude → outra pasta): nada é oferecido nem apagado
    const root2 = join(tmp, 'mac-link'), as2 = join(root2, 'AppSupport'), real = join(root2, 'claude-real');
    file(join(real, 'Cache', 'data_0'));
    mkdirSync(as2, { recursive: true });
    if (tryLink(real, join(as2, 'Claude'), 'junction')) {
      const ad2 = createAppData({ platform: 'darwin', bases: { appSupport: as2 }, runningKeys: () => new Set() });
      assert.ok((await ad2.preview()).entries.every(e => e.items.length === 0));
      assert.equal((await ad2.clean(['claude:Cache'])).skipped, 1);
      assert.ok(existsSync(join(real, 'Cache', 'data_0')));
      console.log('ok  pasta de regra que é link não oferece nada');
    } else console.log('ok  pasta-link (sem link: pulado)');

    // pedaço do meio do caminho é link (Google → outra pasta): o caminho real muda, nada é oferecido
    const root3 = join(tmp, 'mac-meio'), as3 = join(root3, 'AppSupport'), g = join(root3, 'google-real');
    file(join(g, 'Chrome', 'Default', 'GPUCache', 'f'));
    mkdirSync(as3, { recursive: true });
    if (tryLink(g, join(as3, 'Google'), 'junction')) {
      const ad3 = createAppData({ platform: 'darwin', bases: { appSupport: as3 }, runningKeys: () => new Set() });
      assert.equal((await ad3.clean(['chrome:Default/GPUCache'])).skipped, 1);
      assert.ok(existsSync(join(g, 'Chrome', 'Default', 'GPUCache', 'f')));
      console.log('ok  link no meio do caminho não oferece nada');
    }

    // dono abre durante a coleta do clean: a reconferência logo antes do rm segura
    const root4 = join(tmp, 'mac-corrida'), cs4 = join(root4, 'Caches');
    file(join(cs4, 'com.spotify.client', 'x'));
    let calls = 0;
    const ad4 = createAppData({ platform: 'darwin', bases: { caches: cs4 }, installedIds, runningKeys: () => (calls++ ? new Set(['com.spotify.client']) : new Set()) });
    assert.equal((await ad4.clean(['caches:com.spotify.client'])).skipped, 1);
    assert.ok(existsSync(join(cs4, 'com.spotify.client', 'x')));
    console.log('ok  dono aberto na hora do rm: nada some');

    // sem lista de apps instalados: nada do Caches é limpável
    const ad5 = createAppData({ platform: 'darwin', bases: { caches: cs4 }, installedIds: async () => null, runningKeys: () => new Set() });
    assert.ok((await ad5.preview()).entries.every(e => e.items.every(i => !i.actionable)));
    assert.equal((await ad5.clean(['caches:com.spotify.client'])).skipped, 1);

    // medição do alvo cortada pelo orçamento: não apaga
    for (const f of ['a', 'b', 'c']) file(join(cs4, 'com.spotify.client', f));
    const ad6 = createAppData({ platform: 'darwin', bases: { caches: cs4 }, installedIds, runningKeys: () => new Set(), maxEntries: 1 });
    assert.equal((await ad6.clean(['caches:com.spotify.client'])).skipped, 1);
    assert.ok(existsSync(join(cs4, 'com.spotify.client', 'a')));
    const ok7 = await createAppData({ platform: 'darwin', bases: { caches: cs4 }, installedIds, runningKeys: () => new Set() }).clean(['caches:com.spotify.client']);
    assert.ok(ok7.files === 4 && ok7.bytes > 0 && !existsSync(join(cs4, 'com.spotify.client')));
    console.log('ok  caches: só app instalado e fechado; medição cortada não apaga');
  }

  // --- Windows (plataforma injetada) ---
  {
    const root = join(tmp, 'win');
    const localAppData = join(root, 'Local'), roamingAppData = join(root, 'Roaming');
    const ud = join(localAppData, 'Google', 'Chrome', 'User Data');
    for (const d of ['Cache', 'Code Cache', 'GPUCache']) file(join(ud, 'Default', d, 'f'));
    file(join(ud, 'Profile 2', 'GPUCache', 'f'));
    file(join(ud, 'Estranho', 'GPUCache', 'f'));            // não é perfil
    file(join(root, 'perfil-fora', 'GPUCache', 'f'));
    tryLink(join(root, 'perfil-fora'), join(ud, 'Profile 3'), 'junction');   // perfil que é link: nada
    file(join(roamingAppData, 'Claude', 'Cache', 'f'));
    file(join(roamingAppData, 'Claude', 'claude-code', '1.0.0', 'x'));
    file(join(roamingAppData, 'Claude', 'claude-code', '1.0.1', 'x'));
    let running: ReadonlySet<string> | null = new Set(['claude']);
    const ad = createAppData({ platform: 'win32', bases: { localAppData, roamingAppData }, runningKeys: () => running });
    const s = await ad.preview();
    const all = s.entries.flatMap(e => e.items);
    assert.deepEqual(all.filter(i => i.actionable).map(i => i.id).sort(), ['chrome:Default/GPUCache', 'chrome:Profile 2/GPUCache']);
    assert.ok(!all.some(i => ['chrome:Default/Cache', 'chrome:Default/Code Cache'].includes(i.id) || i.id.includes('Estranho')), 'Cache/Code Cache do Chrome são da limpeza rápida');
    assert.ok(all.some(i => i.id === 'claude:Cache' && !i.actionable) && all.some(i => i.id === 'claude:claude-code/1.0.0'));
    const r = await ad.clean(['chrome:Default/GPUCache', 'chrome:Default/Cache', 'claude:Cache']);
    assert.equal(r.skipped, 2);
    assert.ok(!existsSync(join(ud, 'Default', 'GPUCache')) && existsSync(join(ud, 'Default', 'Cache')) && existsSync(join(roamingAppData, 'Claude', 'Cache')));
    console.log('ok  windows: GPUCache do Chrome fechado; Cache/Code Cache ficam para a limpeza rápida; Claude aberto fica');
  }

  // I1: FOLGA_APPDATA_BASES torto não cai nas pastas reais nem em '/': o servidor não sobe
  const abs = process.platform === 'win32' ? 'C:\\tmp\\a' : '/tmp/a';
  for (const raw of ['null', '"/"', '/', '["/"]', '{"x":"/"}', '{"caches":1}', '{"caches":""}', '{"caches":"rel/a"}', '{"__proto__":"/tmp/a"}', '[]'])
    assert.throws(() => parseAppDataBases(raw), Error, raw);
  assert.deepEqual(parseAppDataBases(JSON.stringify({ caches: abs })), { caches: abs });
  console.log('ok  parseAppDataBases: só objeto com bases conhecidas e caminho absoluto');

  assert.equal(newestVersion(['2.0.9', '2.0.14', '2.0.10']), '2.0.14'); assert.equal(newestVersion(['2.0.9', 'latest']), null);
  assert.equal(newestVersion([]), null); assert.equal(newestVersion(['2.0', '2.0.0']), null);
  console.log('ok  newestVersion');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
