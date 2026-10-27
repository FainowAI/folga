// Arquivos parados, revalidação e limpeza rápida. Só pastas temporárias criadas aqui: nunca toca em arquivo real
// do usuário e nunca chama a Lixeira de verdade (R21, R22, D16, D17).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createFiles, fdaNote, isPackageDir, lsofName, pathKey, pathShapeError, type FileMeta, type FilesDeps, type Inspected } from '../files.ts';
import { DEFAULT_SETTINGS } from '../types.ts';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const DAY = 86_400_000;
const MB = 1024 * 1024;
// nome com acento de propósito (o caminho real do usuário tem: C:\Users\Antônio)
const base = realpathSync(mkdtempSync(join(tmpdir(), 'folga-arq-ção-')));   // /var é link para /private/var no Mac: a limpeza recusa cache com link no caminho
const dir = (...p: string[]) => { const d = join(base, ...p); mkdirSync(d, { recursive: true }); return d; };
// Spotlight falso e neutro: no Mac nenhum teste depende do índice real (nem do binário, que a CI compila depois)
const noMeta = async (ps: string[]): Promise<FileMeta[]> => ps.map(() => ({ lastUsed: null, added: null, dataless: false, missing: false }));
const file = (path: string, bytes: number, daysOld: number) => {
  writeFileSync(path, '');
  truncateSync(path, bytes);
  const t = new Date(Date.now() - daysOld * DAY);
  utimesSync(path, t, t);
  return path;
};

let passed = 0;
const ok = (name: string) => { passed++; console.log(`ok  ${name}`); };

try {
  const downloads = dir('Downloads');
  const docs = dir('Documentos');
  const recent = dir('Recent');
  const mk = (over: Partial<FilesDeps> = {}) => createFiles({
    getSettings: () => DEFAULT_SETTINGS, roots: [downloads, docs], recentDir: recent, accessTracking: true,
    tempDirs: [join(base, 'sem-temp')], cacheDirs: {}, browsersOpen: async () => ({ chrome: false, edge: false }),
    trash: async () => ({ bytes: 0, files: 0 }), meta: noMeta, openFiles: async () => new Set(), ...over,
  });

  // ---------- allowedRoots ----------
  {
    const f = mk({ roots: [downloads, docs.toUpperCase(), docs, join(base, 'nao-existe'), join(downloads, '..', 'Downloads'), dir('Downloads', 'filha')] });
    const r = f.allowedRoots();
    assert.equal(r.length, 2, `esperava 2 raízes, veio ${r.join(' | ')}`);   // sem inexistente, sem duplicata, sem pasta dentro de outra
    assert.ok(r.every(x => existsSync(x)));
    await rm(join(downloads, 'filha'), { recursive: true });
    // as pastas reais do usuário: só existentes e sem duplicata
    const real = createFiles({ getSettings: () => DEFAULT_SETTINGS }).allowedRoots();
    assert.equal(new Set(real.map(x => x.toLowerCase())).size, real.length);
    assert.ok(real.every(x => existsSync(x)));
    ok('allowedRoots: só existentes, realpath, sem duplicata nem pasta dentro de pasta');
  }

  // ---------- scan ----------
  file(join(downloads, 'velho-grande.iso'), 5 * MB, 400);
  file(join(downloads, 'novo-grande.iso'), 5 * MB, 1);
  file(join(downloads, 'velho-pequeno.txt'), 100 * 1024, 400);
  file(join(dir('Documentos', 'a', 'b'), 'meio.zip'), 2 * MB, 200);
  file(join(dir('Documentos', 'node_modules', 'x'), 'ignorado.bin'), 3 * MB, 500);
  file(join(dir('Documentos', '.oculta'), 'ignorado.bin'), 3 * MB, 500);
  // 11 níveis de profundidade: passa do limite de 10
  let deep = docs;
  for (let i = 0; i < 11; i++) deep = join(deep, `n${i}`);
  mkdirSync(deep, { recursive: true });
  file(join(deep, 'fundo.bin'), 3 * MB, 500);
  // junção para fora das raízes: nunca atravessada
  const outside = dir('Fora');
  file(join(outside, 'fora.bin'), 8 * MB, 900);
  let junction = true;
  try { symlinkSync(outside, join(docs, 'atalho-fora'), 'junction'); } catch { junction = false; }

  {
    const f = mk();
    assert.equal(f.last(), null);
    const s = await f.scan({ olderThanDays: 30, minMB: 1 });
    assert.deepEqual(s.files.map(x => x.name), ['velho-grande.iso', 'meio.zip']);   // por tamanho decrescente
    assert.equal(s.totalBytes, 7 * MB);
    assert.equal(s.truncated, false);
    assert.equal(s.accessTracking, true);
    assert.equal(s.olderThanDays, 30);
    assert.equal(s.minBytes, MB);
    assert.equal(s.files[0]!.basis, MAC ? 'modificacao' : 'acesso');   // no Mac quem dá o uso é o Spotlight (neutro aqui)
    assert.equal(s.files[0]!.root.toLowerCase(), realpathSync.native(downloads).toLowerCase());
    assert.ok(s.scanned > 5 && s.durationMs >= 0 && s.t > 0);
    assert.equal(f.last(), s);
    ok(`scan: filtro de idade e tamanho, ignora node_modules/.oculta/profundidade >10${junction ? ' e junção' : ' (sem junção: pulado)'}`);

    const s2 = await f.scan({ olderThanDays: 300, minMB: 1 });
    assert.deepEqual(s2.files.map(x => x.name), ['velho-grande.iso']);
    ok('scan: parâmetros mudam o resultado');

    const def = await createFiles({ getSettings: () => ({ ...DEFAULT_SETTINGS, staleDays: 300, staleMinMB: 1 }), roots: [downloads, docs], recentDir: recent, accessTracking: true, meta: noMeta }).scan();
    assert.equal(def.files.length, 1);
    ok('scan: sem parâmetros usa os Ajustes (staleDays/staleMinMB)');
  }

  {
    const s = await mk({ accessTracking: false }).scan({ olderThanDays: 30, minMB: 1 });
    assert.equal(s.accessTracking, !!MAC);   // no Mac: o Spotlight respondeu
    assert.ok(s.files.every(x => x.basis === 'modificacao'));
    ok("scan: rastreio de acesso desligado → basis 'modificacao'");
  }

  if (WIN) {
    // atalho em Recent mais novo que o acesso → o arquivo "foi usado"; atalho mais velho → vale o acesso
    const used = file(join(downloads, 'usado-pelo-atalho.iso'), 4 * MB, 400);
    const lnk = join(recent, 'usado-pelo-atalho.iso.lnk');
    writeFileSync(lnk, 'x');
    const f = mk();
    let s = await f.scan({ olderThanDays: 30, minMB: 1 });
    assert.ok(!s.files.some(x => x.name === 'usado-pelo-atalho.iso'), 'atalho de hoje: não é parado');
    s = await f.scan({ olderThanDays: 5, minMB: 1 });   // atalho de hoje, mas agora o corte é 5 dias: atalho venceria, ainda recente
    assert.ok(!s.files.some(x => x.name === 'usado-pelo-atalho.iso'));
    const t = new Date(Date.now() - 100 * DAY);
    utimesSync(lnk, t, t);   // atalho de 100 dias, acesso de 400 → vale o atalho
    s = await f.scan({ olderThanDays: 30, minMB: 1 });
    const hit = s.files.find(x => x.name === 'usado-pelo-atalho.iso');
    assert.ok(hit);
    assert.equal(hit.basis, 'recentes');
    assert.ok(Math.abs(hit.lastUsed - t.getTime()) < 2000);
    s = await f.scan({ olderThanDays: 150, minMB: 1 });   // 100 d de atalho < 150: sai da lista
    assert.ok(!s.files.some(x => x.name === used.split('\\').pop()));
    ok("scan: basis 'recentes' pelo atalho de mesmo nome em Recent");
  }

  {
    const s = await mk({ maxEntries: 3 }).scan({ olderThanDays: 30, minMB: 1 });
    assert.equal(s.truncated, true);
    assert.ok(s.scanned <= 3);
    const t = await mk({ maxMs: -1 }).scan({ olderThanDays: 30, minMB: 1 });
    assert.equal(t.truncated, true);
    ok('scan: teto de entradas e de tempo → truncated');
  }

  {
    const many = dir('Documentos', 'muitos');
    for (let i = 0; i < 520; i++) file(join(many, `f${String(i).padStart(3, '0')}.bin`), 2000 + i, 400);
    const s = await mk().scan({ olderThanDays: 30, minMB: 0.001 });
    assert.equal(s.files.length, 500);
    assert.ok(s.files[0]!.size >= s.files[499]!.size);
    const expected = s.files.reduce((a, x) => a + x.size, 0);
    assert.ok(s.totalBytes > expected, 'totalBytes soma todos os achados, não só os 500');
    ok('scan: no máximo 500 achados, totalBytes de todos');
    await rm(many, { recursive: true });
  }

  {
    // uma varredura por vez: a segunda espera a primeira
    const f = mk();
    const order: string[] = [];
    const a = f.scan({ olderThanDays: 30, minMB: 1 }).then(r => { order.push('a'); return r; });
    const b = f.scan({ olderThanDays: 300, minMB: 1 }).then(r => { order.push('b'); return r; });
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(order, ['a', 'b']);
    assert.ok(ra.t <= rb.t);
    assert.equal(f.last(), rb);
    ok('scan: uma por vez, last() devolve a última');
  }

  // ---------- inspect / recycle (revalidação, R21) ----------
  {
    const f = mk();
    const good = join(downloads, 'velho-grande.iso');
    const r = await f.inspect([good, good.toUpperCase()]);
    assert.ok(!('erro' in r[0]!) && !('erro' in r[1]!));
    assert.equal((r[0] as { size: number }).size, 5 * MB);
    assert.equal((r[1] as { path: string }).path, (r[0] as { path: string }).path);   // caminho real, caixa corrigida
    const bad = [
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      join(docs, '..', '..', 'Windows', 'win.ini'),
      join(docs, '..', 'Fora', 'fora.bin'),
      '\\\\servidor\\compartilhado\\arquivo.txt',
      '\\\\?\\C:\\Windows\\win.ini',
      '\\\\.\\PhysicalDrive0',
      '//servidor/pasta/a.txt',
      'relativo\\arquivo.txt',
      join(downloads, 'velho-grande.iso') + ':fluxo',
      join(downloads, 'nao-existe.iso'),
      downloads,                                  // a própria raiz
      join(docs, 'a'),                            // pasta
      '', 'C:', 42 as unknown as string,
    ];
    const rb = await f.inspect(bad);
    rb.forEach((x, i) => assert.ok('erro' in x, `deveria recusar: ${String(bad[i])}`));
    if (junction) {
      const viaJunction = await f.inspect([join(docs, 'atalho-fora', 'fora.bin'), join(docs, 'atalho-fora')]);
      viaJunction.forEach(x => assert.ok('erro' in x, 'junção para fora não passa'));
    }
    ok('inspect: fora das raízes, travessia, UNC, \\\\?\\, dispositivo, fluxo NTFS, inexistente, pasta, junção → recusados');

    // recycle com caminhos inválidos: tudo em failed e a Lixeira nem é chamada
    const rr = await f.recycle(['C:\\Windows\\win.ini', join(downloads, 'nao-existe.iso')]);
    assert.deepEqual(rr.ok, []);
    assert.equal(rr.failed.length, 2);
    assert.ok(existsSync(good));
    assert.equal(rr.inTrash, 0);
    ok('recycle: caminho inválido vai para failed sem tocar em nada');

    // M4 (Windows): Lixeira falsa (antes/depois) — quem diz quantos entraram é a contagem da Lixeira, não o disco
    if (WIN) {
    let bin = 10, entram = 2, binIlegivel = false;
    const sent: string[][] = [];
    const fr = mk({
      trash: async () => { if (binIlegivel) throw new Error('sem resposta'); return { bytes: 0, files: bin }; },
      sendToTrash: async ps => { sent.push(ps); for (const p of ps) await rm(p); bin += entram; },   // "Lixeira": o arquivo sai da pasta
    });
    const par = (n: string) => [file(join(downloads, `${n}-1.bin`), 1000, 400), file(join(downloads, `${n}-2.bin`), 1000, 400)];
    let r2 = await fr.recycle(par('lixo-a'));
    assert.equal(r2.ok.length, 2); assert.equal(r2.failed.length, 0); assert.equal(r2.inTrash, 2);
    entram = 1;   // saíram 2 da pasta, só 1 apareceu na Lixeira (o Windows apagou de vez ou perguntou)
    r2 = await fr.recycle(par('lixo-b'));
    assert.equal(r2.ok.length, 2); assert.equal(r2.inTrash, 1);
    binIlegivel = true;
    r2 = await fr.recycle(par('lixo-c'));
    assert.equal(r2.ok.length, 2); assert.equal(r2.inTrash, null, 'Lixeira ilegível: desconhecido, não 0');
    binIlegivel = false;
    const antes = sent.length;
    r2 = await fr.recycle([join(downloads, 'nao-existe-mesmo.bin')]);
    assert.equal(r2.inTrash, 0); assert.equal(sent.length, antes, 'nada válido: a Lixeira nem é chamada');
    ok('recycle: inTrash = itens da Lixeira depois − antes (completo, parcial, ilegível, nada enviado)');
    }

    // espião da Lixeira: recebe só caminhos reais validados e as raízes; nada válido = nem é chamado
    const calls: Array<{ ps: string[]; roots: string[] }> = [];
    let trashCalls = 0;
    const fs = mk({
      trash: async () => { trashCalls++; return { bytes: 0, files: 0 }; },
      sendToTrash: async (ps, roots) => { calls.push({ ps, roots }); for (const p of ps) await rm(p); return MAC ? 1 : undefined; },   // Mac: "1 de 2 entrou"
    });
    const sys = WIN ? 'C:\\Windows\\win.ini' : '/etc/hosts';
    const linkOk = (() => { try { symlinkSync(good, join(downloads, 'link-espiao.iso')); return true; } catch { return false; } })();
    const um = file(join(downloads, 'espiao-1.bin'), 1000, 400), dois = file(join(downloads, 'espiao-2.bin'), 1000, 400);
    const reais = [um, dois].map(x => realpathSync.native(x));
    const rs = await fs.recycle([um, sys, ...(linkOk ? [join(downloads, 'link-espiao.iso')] : []), dois.toUpperCase()]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.ps, reais);
    assert.deepEqual(calls[0]!.roots, fs.allowedRoots());
    assert.equal(rs.ok.length, 2); assert.equal(rs.failed.length, linkOk ? 2 : 1);
    if (MAC) { assert.equal(rs.inTrash, 1, 'Mac: quem diz quantos entraram é o trashItem'); assert.equal(trashCalls, 0, 'Mac: a Lixeira nem é lida'); }
    const r0 = await fs.recycle([sys, join(downloads, 'nao-existe.bin')]);
    assert.equal(calls.length, 1, 'nada válido: o espião nem é chamado'); assert.equal(r0.inTrash, 0);
    if (linkOk) await rm(join(downloads, 'link-espiao.iso'));
    ok('recycle: só caminho real validado (e as raízes) chega à Lixeira; sistema e link não; Mac conta pelo retorno');
  }

  // ---------- R21 em caminho POSIX (puro: roda nos dois sistemas) ----------
  {
    for (const bad of ['', 'rel/a.txt', '/a/../b', '/a/./b', '/a/\u0000b', 'x'.repeat(1025), 42, 'C:\\a.txt'])
      assert.ok(pathShapeError(bad, 'darwin'), `POSIX deveria recusar ${String(bad)}`);
    assert.equal(pathShapeError('/Users/Antônio/Downloads/a.iso', 'darwin'), null);
    assert.ok(pathShapeError('/Users/v/a.txt', 'win32'));                       // Windows segue só com letra de unidade
    assert.equal(pathShapeError('C:\\Users\\v\\a.txt', 'win32'), null);
    assert.equal(isPackageDir('Fotos.photoslibrary'), true); assert.equal(isPackageDir('Projeto 2025'), false);
    const nfc = '/A/Ant\u00f4nio', nfd = '/a/Anto\u0302nio';
    assert.equal(pathKey(nfc, 'darwin'), pathKey(nfd, 'darwin'));             // APFS: mesma pasta
    assert.notEqual(pathKey(nfc, 'win32'), pathKey(nfd, 'win32'));            // NTFS não normaliza: arquivos distintos
    assert.equal(pathKey('C:\\A\\B.TXT', 'win32'), 'c:\\a\\b.txt');
    ok('pathShapeError/isPackageDir/pathKey: forma do caminho por sistema, pacote pelo nome, chave NFC sem caixa');
  }
  if (MAC) {
    // base criada em /var/folders: o real é /private/var/folders (firmlink); nome em NFD de propósito
    const nfd = file(join(downloads, 'Anto\u0302nio.iso'), 5 * MB, 400);
    const r = await mk({ roots: [downloads.replace(/^\/private/, '')] }).inspect([
      nfd.normalize('NFC'), nfd, '/private' + nfd.replace(/^\/private/, ''), nfd.replace(/^\/private/, ''),
    ]);
    r.forEach(x => assert.ok(!('erro' in x), JSON.stringify(x)));
    assert.equal(new Set(r.map(x => pathKey((x as Inspected).path))).size, 1);
    if (existsSync(nfd.toUpperCase())) assert.ok(!('erro' in (await mk().inspect([nfd.toUpperCase()]))[0]!));   // APFS sem caixa
    symlinkSync(outside, join(docs, 'link-fora'));                          // pasta-link para fora
    symlinkSync(join(outside, 'fora.bin'), join(downloads, 'link.bin'));    // arquivo-link
    const fora = await mk().inspect([join(docs, 'link-fora', 'fora.bin'), join(downloads, 'link.bin'),
      `${downloads}/../Fora/fora.bin`, '/etc/hosts', '/private/etc/hosts', '/tmp', downloads,
      file(join(dir('Downloads', 'Fotos.photoslibrary', 'originals'), 'img.heic'), 2 * MB, 400)]);
    fora.forEach(x => assert.ok('erro' in x, JSON.stringify(x)));
    assert.match((fora.at(-1) as { erro: string }).erro, /pacote/);
    assert.ok(!(await mk().scan({ olderThanDays: 30, minMB: 1 })).files.some(f => /photoslibrary/.test(f.path)));
    ok('Mac: firmlink /private, NFC/NFD, sem caixa, link para fora, /etc e pacote opaco');
  }

  if (MAC) {
    const META: Record<string, Partial<FileMeta>> = { 'nuvem.mov': { dataless: true }, 'aberto.iso': { lastUsed: Date.now() - 2 * DAY },
      'spot.iso': { lastUsed: Date.now() - 300 * DAY }, 'add.iso': { added: Date.now() - 250 * DAY },
      // aberto há 300 d, mas chegou na pasta há 10 d (ou 200 d): o mais novo vale
      'chegou.iso': { lastUsed: Date.now() - 300 * DAY, added: Date.now() - 10 * DAY }, 'mix.iso': { lastUsed: Date.now() - 300 * DAY, added: Date.now() - 200 * DAY } };
    const meta = async (ps: string[]) => ps.map(p => ({ lastUsed: null, added: null, dataless: false, missing: false, ...META[basename(p)] }));
    for (const n of Object.keys(META)) file(join(downloads, n), 3 * MB, 400);
    const f = mk({ meta });
    const s = await f.scan({ olderThanDays: 30, minMB: 1 });
    const by = (n: string) => s.files.find(x => x.name === n);
    assert.equal(by('nuvem.mov'), undefined);                 // só na nuvem: nunca entra
    assert.equal(by('aberto.iso'), undefined);                // aberto há 2 dias pelo Spotlight: não é parado
    assert.equal(by('spot.iso')!.basis, 'spotlight');
    assert.equal(by('add.iso')!.basis, 'adicionado');         // chegou há 250 d, mtime de 400 d: vale o mais novo
    assert.ok(Math.abs(by('add.iso')!.lastUsed - (Date.now() - 250 * DAY)) < 60_000);
    assert.equal(by('chegou.iso'), undefined);               // chegou há 10 dias: não é parado, mesmo aberto há 300
    assert.equal(by('mix.iso')!.basis, 'adicionado');
    assert.ok(Math.abs(by('mix.iso')!.lastUsed - (Date.now() - 200 * DAY)) < 60_000);
    assert.equal(s.accessTracking, true);
    assert.ok('erro' in (await f.inspect([join(downloads, 'nuvem.mov')]))[0]!);
    const ri = await f.inspect([join(downloads, 'spot.iso'), join(downloads, 'add.iso')]);
    assert.deepEqual(ri.map(x => (x as Inspected).basis), ['spotlight', 'adicionado']);   // a aprovação (M5) usa a mesma regra
    const sNull = await mk({ meta: async () => null }).scan({ olderThanDays: 30, minMB: 1 });
    assert.ok(sNull.files.every(x => x.basis === 'modificacao'));   // Spotlight fora: cai para mtime
    assert.ok(sNull.files.some(x => x.name === 'nuvem.mov') && sNull.accessTracking === false, 'sem Spotlight não esconde nada');
    // decisão 12: .app velho só como filho direto de Downloads, um item com o tamanho total
    const velho = dir('Downloads', 'Instalador.app', 'Contents'); file(join(velho, 'bin'), 2 * MB, 400); file(join(velho, 'res'), 2 * MB, 400);
    file(join(dir('Documentos', 'Outro.app', 'Contents'), 'bin'), 5 * MB, 400);
    file(join(dir('Downloads', 'pasta', 'Fundo.app', 'Contents'), 'bin'), 5 * MB, 400);
    symlinkSync('/Applications/Safari.app', join(downloads, 'Atalho.app'));
    const fa = mk({ meta, appRoot: realpathSync(downloads) });
    const sa = await fa.scan({ olderThanDays: 30, minMB: 1 });
    assert.deepEqual(sa.files.filter(x => x.isApp).map(x => [x.name, x.size]), [['Instalador.app', 4 * MB]]);
    assert.ok(!sa.files.some(x => /Outro\.app|Fundo\.app|Atalho\.app|Contents/.test(x.path)));
    const ia = await fa.inspect([join(downloads, 'Instalador.app'), join(docs, 'Outro.app'), join(downloads, 'pasta', 'Fundo.app'), join(downloads, 'Atalho.app'), '/Applications/Safari.app']);
    assert.ok(!('erro' in ia[0]!), JSON.stringify(ia[0])); ia.slice(1).forEach(x => assert.ok('erro' in x, JSON.stringify(x)));
    assert.equal((ia[0] as Inspected).size, 4 * MB);
    assert.ok('erro' in (await mk({ meta, appRoot: null }).inspect([join(downloads, 'Instalador.app')]))[0]!);
    file(join(dir('Fora', 'Solto.app', 'Contents'), 'bin'), 5 * MB, 400);
    assert.ok(!(await mk({ meta, appRoot: realpathSync(outside) }).scan({ olderThanDays: 30, minMB: 1 })).files.some(x => x.isApp), 'appRoot fora das raízes: nenhum .app');
    for (const n of [...Object.keys(META), 'Atalho.app']) await rm(join(downloads, n));
    for (const d of [join(downloads, 'Instalador.app'), join(downloads, 'pasta'), join(docs, 'Outro.app'), join(outside, 'Solto.app')]) await rm(d, { recursive: true });
    ok('Mac: Spotlight (spotlight/adicionado), só na nuvem fora, Spotlight fora → mtime; .app só filho direto de Downloads');
  }

  // ---------- limpeza rápida ----------
  {
    const tmp = dir('Temp');
    // M3: a idade é max(mtime, criação, ctime) e um arquivo de teste é criado agora; então o relógio do teste anda
    // 10 dias à frente, e "daysOld" vale em relação a esse relógio (mtime no futuro para o que deve parecer novo)
    const SKEW = 10 * DAY;
    const tfile = (path: string, bytes: number, daysOld: number) => file(path, bytes, daysOld - SKEW / DAY);
    tfile(join(tmp, 'velho.tmp'), 3000, 10);
    tfile(join(dir('Temp', 'sub', 'sub2'), 'velho2.tmp'), 2000, 30);
    tfile(join(tmp, 'novo.tmp'), 4000, 1);
    // fora do Windows não há trava de arquivo: a pasta sem escrita faz o unlink falhar do mesmo jeito
    const travado = tfile(join(WIN ? tmp : dir('Temp', 'trava'), 'travado.tmp'), 1000, 20);
    if (!WIN) chmodSync(join(tmp, 'trava'), 0o555);
    // arquivo travado de verdade: um PowerShell o abre sem compartilhar (o unlink do Windows falha)
    const holder = WIN ? spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "$f=[IO.File]::Open($env:FOLGA_LOCK,'Open','Read','None');'ready';Start-Sleep 60"],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, FOLGA_LOCK: travado } }) : null;
    if (holder) await new Promise<void>((res, rej) => { holder.stdout.once('data', () => res()); holder.once('error', rej); setTimeout(() => rej(new Error('PowerShell não travou o arquivo')), 15_000); });
    const chromeC = dir('Cache', 'chrome', 'Default', 'Cache', 'Cache_Data');
    const edgeC = dir('Cache', 'edge', 'Default', 'Code Cache');
    file(join(chromeC, 'data_0'), 5000, 0);
    file(join(chromeC, 'data_1'), 6000, 0);
    file(join(edgeC, 'js_1'), 7000, 0);
    const caches = { chrome: [chromeC], edge: [edgeC] };
    let open = { chrome: true, edge: false };
    const mkc = () => mk({ tempDirs: [tmp], cacheDirs: caches, browsersOpen: async () => open, trash: async () => ({ bytes: 123, files: 2 }), now: () => Date.now() + SKEW });

    let items = await mkc().quickCleanPreview();
    const by = (c: string) => items.find(i => i.category === c)!;
    assert.deepEqual(items.map(i => i.category), ['temp_usuario', 'cache_navegador', 'lixeira']);
    assert.equal(by('temp_usuario').files, 3);
    assert.equal(by('temp_usuario').bytes, 6000);
    assert.equal(by('temp_usuario').actionable, true);
    assert.equal(by('cache_navegador').bytes, 7000);   // só o Edge (fechado) é "a apagar"
    assert.equal(by('cache_navegador').files, 1);
    assert.equal(by('cache_navegador').actionable, true);
    assert.equal(by('cache_navegador').note, 'Chrome aberto: feche para limpar o cache');
    assert.equal(by('lixeira').actionable, false);
    assert.equal(by('lixeira').bytes, 123);
    if (WIN) assert.equal(by('lixeira').note, 'Esvazie pela Lixeira do Windows');
    if (MAC) { assert.equal(by('lixeira').label, 'Lixeira'); assert.equal(by('lixeira').note, 'Esvazie pelo Finder'); assert.equal(by('lixeira').unknown, undefined); }
    assert.ok(items.every(i => /[a-zç]/.test(i.label)));
    ok('quickCleanPreview: temporários > 7 dias, cache só de navegador fechado, Lixeira só informativa');

    open = { chrome: true, edge: true };
    items = await mkc().quickCleanPreview();
    assert.equal(by('cache_navegador').actionable, false);
    assert.equal(by('cache_navegador').bytes, 18000);
    assert.equal(by('cache_navegador').note, 'Chrome e Edge abertos: feche para limpar o cache');
    ok('quickCleanPreview: todos os navegadores abertos → não acionável');

    open = { chrome: true, edge: false };
    const r = await mkc().quickClean({ categories: ['temp_usuario'] });
    assert.equal(r.files, 2);
    assert.equal(r.bytes, 5000);
    assert.equal(r.skipped, 1);   // o travado
    assert.ok(existsSync(join(tmp, 'novo.tmp')) && existsSync(travado));
    assert.ok(!existsSync(join(tmp, 'velho.tmp')));
    assert.ok(existsSync(join(edgeC, 'js_1')), 'categoria fora do pedido não é tocada');
    ok('quickClean: só temporários antigos; novo e travado ficam; categorias limitadas ao pedido');

    const r2 = await mkc().quickClean();
    assert.equal(r2.files, 1);   // o cache do Edge; o do Chrome (aberto) fica; o travado continua travado e é pulado
    assert.ok(!existsSync(join(edgeC, 'js_1')));
    assert.ok(existsSync(join(chromeC, 'data_0')) && existsSync(join(chromeC, 'data_1')), 'cache de navegador aberto nunca é apagado');
    ok('quickClean: cache de navegador aberto não é apagado');

    // M2: o navegador abre entre a coleta e o apagar: confere de novo logo antes de apagar os arquivos dele
    const abreDepois = dir('Cache', 'abre-depois'); file(join(abreDepois, 'data_0'), 5000, 0);
    let consultas = 0;
    const rAbre = await mk({ cacheDirs: { edge: [abreDepois] }, browsersOpen: async () => ({ edge: consultas++ > 0 }) })
      .quickClean({ categories: ['cache_navegador'] });
    assert.ok(existsSync(join(abreDepois, 'data_0')), 'navegador aberto depois da coleta: cache fica');
    assert.deepEqual([rAbre.files, rAbre.skipped], [0, 1]);
    ok('M2: navegador aberto entre a coleta e o apagar → cache dele fica');

    if (!WIN) {
      // revisão de segurança: pasta de cache trocada por um link para uma pasta protegida não pode levar o
      // Folga a apagar o que está do outro lado (outro programa usaria as permissões de pasta do Folga)
      const protegida = dir('Protegida'); const vitima = file(join(protegida, 'tese.docx'), 10, 0);
      const falso = join(dir('CacheFalso'), 'Cache_Data'); symlinkSync(protegida, falso);
      const rLink = await mk({ cacheDirs: { chrome: [falso] } }).quickClean({ categories: ['cache_navegador'] });
      assert.ok(existsSync(vitima), 'cache que é link: nada do outro lado é apagado');
      assert.equal(rLink.files, 0);
      const pai = dir('CachePai'); const sub = join(pai, 'Cache_Data'); mkdirSync(sub);
      const isca = file(join(sub, 'tese.docx'), 10, 0);
      const alvo2 = file(join(dir('Protegida2'), 'tese.docx'), 10, 0);
      // a pasta vira link entre a coleta e o apagar: o arquivo com o mesmo nome do outro lado fica
      let trocou = false, chamadas = 0;
      const rTroca = await mk({ cacheDirs: { chrome: [sub] }, browsersOpen: async () => {
        if (chamadas++ === 1 && existsSync(isca)) { /* 2ª consulta = a de logo antes de apagar (M2) */ trocou = true; await rm(sub, { recursive: true }); symlinkSync(join(base, 'Protegida2'), sub); }
        return { chrome: false, edge: false };
      } }).quickClean({ categories: ['cache_navegador'] });
      assert.ok(trocou && existsSync(alvo2), 'pasta trocada por link depois da coleta: o arquivo do outro lado fica');
      assert.equal(rTroca.files, 0);
      ok('segurança: cache que é (ou vira) link para outra pasta não apaga nada do outro lado');
    }

    if (MAC) {
      const tempFiles = async () => (await mkc().quickCleanPreview()).find(i => i.category === 'temp_usuario')!.files;
      const antes = await tempFiles();
      const emUso = tfile(join(tmp, 'em-uso.db'), 1000, 30);
      utimesSync(emUso, new Date(Date.now() + SKEW), new Date(Date.now() - 30 * DAY));   // lido "agora", modificado há 30 d
      assert.equal(await tempFiles(), antes, 'o preview também conta o acesso recente');
      await mkc().quickClean({ categories: ['temp_usuario'] });
      assert.ok(existsSync(emUso), 'no Mac o unlink não respeita arquivo aberto: acesso recente segura');
      const safari = dir('Cache', 'safari'); file(join(safari, 'fsCachedData'), 4000, 0);
      const keys = new Set(['com.apple.safari']);
      const f2 = mk({ cacheDirs: { safari: [safari] }, runningKeys: () => keys });
      const c2 = (await f2.quickCleanPreview()).find(i => i.category === 'cache_navegador')!;
      assert.equal(c2.actionable, false);
      assert.match(c2.note!, /^Safari: /);   // nome exibido do Safari na nota
      assert.equal((await mk({ cacheDirs: { safari: [safari] }, runningKeys: () => null }).quickCleanPreview()).find(i => i.category === 'cache_navegador')!.actionable, false);
      // Safari fechado e pasta legível: continua só informativo; a limpeza nunca toca no cache do Safari
      const f3 = mk({ cacheDirs: { safari: [safari] }, runningKeys: () => new Set() });
      const c3 = (await f3.quickCleanPreview()).find(i => i.category === 'cache_navegador')!;
      assert.deepEqual([c3.actionable, c3.bytes, c3.files], [false, 0, 0]);
      assert.equal((await f3.quickClean({ categories: ['cache_navegador'] })).files, 0);
      assert.ok(existsSync(join(safari, 'fsCachedData')), 'cache do Safari fica, mesmo legível e com o Safari fechado');
      // pasta que o node não abre (no Mac de verdade: Acesso Total ao Disco): nada contado nem acionável, nota fdaNote()
      const trancado = dir('Cache', 'safari-trancado'); file(join(trancado, 'fsCachedData'), 4000, 0); chmodSync(trancado, 0o000);
      try {
        const c4 = (await mk({ cacheDirs: { safari: [trancado] }, runningKeys: () => new Set() }).quickCleanPreview()).find(i => i.category === 'cache_navegador')!;
        assert.deepEqual([c4.actionable, c4.bytes, c4.files, c4.note], [false, 0, 0, `Safari: ${fdaNote()}`]);
        assert.equal((await mk({ cacheDirs: { safari: [trancado] }, runningKeys: () => new Set() }).quickClean({ categories: ['cache_navegador'] })).files, 0);
      } finally { chmodSync(trancado, 0o755); }
      ok('Mac: temporário com acesso recente fica; cache do Safari só com o Safari fechado (sonda sem leitura = aberto)');
    }

    if (holder) { holder.kill(); await new Promise(r => holder.once('exit', r)); }   // solta o arquivo antes da limpeza
    else chmodSync(join(tmp, 'trava'), 0o755);

    // I2: o APFS só atualiza o atime se ele for mais velho que o mtime; arquivo aberto agora pode parecer parado há
    // 7 dias. Quem está na lista de abertos (lsof) fica; lista ilegível = nenhum temporário apagado nesta rodada
    const abertos = dir('Temp-abertos');
    const segurado = file(join(abertos, 'segurado.db'), 1000, 30);
    const solto = file(join(abertos, 'solto.tmp'), 1000, 30);
    const outro = file(join(abertos, 'outro.tmp'), 1000, 30);
    const comAbertos = (set: ReadonlySet<string> | null) => mk({ tempDirs: [abertos], openFiles: async () => set, now: () => Date.now() + 8 * DAY })   // ctime = agora: o relógio anda 8 dias;
    // native: como o realpath das pastas de temporários (no Windows expande o nome 8.3 do tmpdir)
    const rl = await comAbertos(new Set([realpathSync.native(segurado)])).quickClean({ categories: ['temp_usuario'] });
    assert.ok(existsSync(segurado), 'arquivo aberto por um processo fica');
    assert.ok(!existsSync(solto) && !existsSync(outro));
    assert.deepEqual([rl.files, rl.skipped], [2, 1]);
    const outro2 = file(join(abertos, 'outro2.tmp'), 1000, 30);
    const rn = await comAbertos(null).quickClean({ categories: ['temp_usuario'] });
    assert.equal(rn.files, 0);
    assert.ok(existsSync(segurado) && existsSync(outro2), 'sem lista de abertos: nenhum temporário apagado');
    // saída do `lsof -Fn` capturada ao vivo (21/10/2026) para 'é-nfc', 'a\b', 't<tab>ab', 'nl<quebra>x', 'car^et'
    assert.deepEqual(['/T/\\xc3\\xa9-nfc', '/T/a\\\\b', '/T/t\\tab', '/T/nl\\nx', '/T/car^et', '/T/\\\\x41'].map(lsofName),
      ['/T/é-nfc', '/T/a\\b', '/T/t\tab', '/T/nl\nx', '/T/car^et', '/T/\\x41']);
    ok('I2: temporário aberto (lsof) fica; sem a lista de abertos nenhum temporário é apagado');

    // M3: arquivo extraído de zip/copiado: mtime de 30 dias, mas criado agora → NÃO é apagado
    const chegou = dir('Temp-chegou');
    const extraido = file(join(chegou, 'extraido.tmp'), 3000, 30);
    assert.ok(statSync(extraido).mtimeMs < Date.now() - 29 * DAY, 'mtime antigo de verdade');
    // no Mac, pôr o mtime antes da criação puxa a criação junto (semântica BSD); quem marca "chegou agora" ali é o ctime
    assert.ok((WIN ? statSync(extraido).birthtimeMs : statSync(extraido).ctimeMs) > Date.now() - 60_000, 'criado agora');
    const real = () => mk({ tempDirs: [chegou] });   // relógio real
    assert.equal((await real().quickCleanPreview()).find(i => i.category === 'temp_usuario')!.files, 0);
    const rr3 = await real().quickClean({ categories: ['temp_usuario'] });
    assert.equal(rr3.files, 0);
    assert.ok(existsSync(extraido), 'mtime antigo mas criado agora: fica');
    // o mesmo arquivo, 8 dias depois: aí sim passou da idade (a criação é que decide, não o mtime)
    const depois = mk({ tempDirs: [chegou], now: () => Date.now() + 8 * DAY });
    assert.equal((await depois.quickCleanPreview()).find(i => i.category === 'temp_usuario')!.files, 1);
    // e a reconferência logo antes do unlink usa a mesma idade: preview velho não apaga o que "chegou" depois
    const rr4 = await depois.quickClean({ categories: ['temp_usuario'] });
    assert.equal(rr4.files, 1);
    assert.ok(!existsSync(extraido));
    ok('quickClean: idade = max(mtime, criação, ctime); mtime de 30 dias mas criado agora não é apagado');

    // B6: single-flight + cache de 30 s; quickClean invalida; fresh ignora o cache
    let clock = 5_000_000, trashCalls = 0;
    const fc = mk({ tempDirs: [dir('Temp-cache')], cacheDirs: {}, trash: async () => { trashCalls++; return { bytes: 0, files: 0 }; }, now: () => clock });
    const p1 = fc.quickCleanPreview(), p2 = fc.quickCleanPreview();
    assert.equal(p1, p2, 'chamadas concorrentes dividem a mesma promessa');
    await p1;
    assert.equal(trashCalls, 1);
    await fc.quickCleanPreview();
    clock += 29_000;
    await fc.quickCleanPreview();
    assert.equal(trashCalls, 1, 'dentro de 30 s: do cache');
    clock += 2_000;
    await fc.quickCleanPreview();
    assert.equal(trashCalls, 2, 'passou de 30 s: coleta de novo');
    await fc.quickClean();
    await fc.quickCleanPreview();
    assert.equal(trashCalls, 3, 'depois de um quickClean: coleta de novo');
    await fc.quickCleanPreview({ fresh: true });
    assert.equal(trashCalls, 4, 'fresh (aprovação) ignora o cache');
    ok('quickCleanPreview: single-flight, cache de 30 s, invalidado por quickClean, fresh coleta de novo');
  }

  // ---------- Lixeira ilegível e o pino do Acesso Total ao Disco (Review Focus 6) ----------
  {
    if (MAC) {
      const items = await mk({ trash: async () => ({ bytes: 0, files: 0, denied: true }) }).quickCleanPreview();
      const lx = items.find(i => i.category === 'lixeira')!;
      assert.deepEqual([lx.unknown, lx.bytes, lx.files, lx.note, lx.label], [true, 0, 0, fdaNote(), 'Lixeira']);
    }
    // decisão 17: o Folga não pede Acesso Total ao Disco. Uma nota só, dentro ou fora do app, sem caminho nos Ajustes
    assert.equal(fdaNote(), 'Não deu para ler: o macOS protege esta pasta e o Folga não pede essa permissão.');
    assert.doesNotMatch(fdaNote(), /Ajustes|Privacy_AllFiles|liberar|\bnode\b|Terminal|execPath/i);
    const repo = join(import.meta.dirname, '..', '..');
    const grep = (re: string) => { try { return execFileSync('git', ['grep', '-l', '-i', '-E', re, '--', 'src', 'web/src', 'scripts', 'probe', 'mac', ':!src/tests/files.test.ts'], { encoding: 'utf8', cwd: repo }).trim().split('\n').filter(Boolean); } catch { return []; } };
    // nenhum convite: nem o link do painel, nem o caminho "Ajustes do Sistema › Privacidade" (› ou >)
    assert.deepEqual(grep('Privacy_AllFiles|Ajustes do Sistema ?[›>] ?Privacidade'), []);
    const fontes = grep('Acesso Total ao Disco');
    assert.ok(fontes.length > 0, 'a busca não achou fonte nenhuma: o pino não está olhando nada');
    assert.ok(fontes.includes('mac/Folga.swift'), 'o pino precisa olhar o app (mac/)');
    for (const f of fontes) {
      const txt = readFileSync(join(repo, f), 'utf8');
      assert.doesNotMatch(txt, /Acesso Total ao Disco[^\n]{0,160}(\bnode\b|Terminal|execPath)/i, f);
    }
    ok(`Lixeira ilegível = desconhecida (não 0); nenhum texto manda dar Acesso Total ao Disco ao node (${fontes.length} fontes)`);
  }

  // ---------- D20: pasta de projeto de código fica de fora (busca e validação) ----------
  {
    const raiz = dir('Projetos-raiz');
    const solto = file(join(dir('Projetos-raiz', 'fotos'), 'solto.zip'), 2 * MB, 400);
    const noNode = file(join(dir('Projetos-raiz', 'app-node', 'dist'), 'bundle.js.map'), 2 * MB, 400);
    writeFileSync(join(raiz, 'app-node', 'package.json'), '{}');
    const noVenv = file(join(dir('Projetos-raiz', 'odysseus', 'venv', 'Lib'), 'onnx.pyd'), 2 * MB, 400);
    writeFileSync(join(raiz, 'odysseus', 'venv', 'pyvenv.cfg'), 'home = x');
    const noGit = file(join(dir('Projetos-raiz', 'repo', 'src'), 'modelo.onnx'), 2 * MB, 400);
    mkdirSync(join(raiz, 'repo', '.git'));
    const f = mk({ roots: [raiz] });
    const s = await f.scan({ olderThanDays: 30, minMB: 1 });
    assert.deepEqual(s.files.map(x => x.name), ['solto.zip'], `achou: ${s.files.map(x => x.path).join(' | ')}`);
    const checked = await f.inspect([solto, noNode, noVenv, noGit]);
    assert.ok(!('erro' in checked[0]!), 'arquivo solto passa');
    for (const c of checked.slice(1)) assert.ok('erro' in c && /projeto/.test(c.erro), `devia recusar: ${JSON.stringify(c)}`);
    ok('D20: pastas com package.json, pyvenv.cfg ou .git ficam fora da busca e da validação');
  }

  console.log(`files: ${passed} casos ok`);
} finally {
  try { chmodSync(join(base, 'Temp', 'trava'), 0o755); } catch { /* não criada ou já liberada */ }
  await rm(base, { recursive: true, force: true });
}
