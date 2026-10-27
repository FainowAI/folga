// Monta e confere o Folga.app (plano 3, ADR 0007). Só Mac.
//   node scripts/mac-app.mjs build [--adhoc] [--out <dir>]   -> <dir>/Folga.app (padrão build/)
//   node scripts/mac-app.mjs install | uninstall   -> ~/Applications/Folga.app (FOLGA_INSTALL_DIR troca a pasta, só para teste)
//   node scripts/mac-app.mjs check <app> [--previous <arquivo>]  -> sai 0 (verde) ou 1
// O --previous recebe a saída de `codesign -d -r- <app do build anterior>` gravada num arquivo: é a conta
// que o TCC faz para manter as permissões do app depois de reinstalar.
// Assinatura: ad-hoc (ramo B do ADR 0007). O spike da identidade "Folga Local" autoassinada falhou: o codesign
// não acha identidade sem confiança, e dar confiança abre janela de senha. `--adhoc` fica aceito (é o que a CI passa).
// O node vai DENTRO do bundle (Resources/folga/bin/node), selado junto: o app é o processo responsável no TCC,
// e um node fora do selo (~/.nvm, gravável pelo usuário) poderia ser trocado e herdar as permissões do app.
// folga.json guarda caminhos RELATIVOS a Contents/Resources (`node`, e as entradas do `path` sem "/" na frente):
// o app resolve na hora, então mover o .app (build/ -> ~/Applications) não quebra nada.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ID = 'local.folga.mac';   // não 'local.folga.app': o macOS guardou recusa de notificação para aquele id (ADR 0007)

/**
 * Requisito designado fraco = algum ramo do `or` não prende a um hash (cdhash ou certificado folha por hash).
 * Só `identifier` deixaria qualquer binário ad-hoc com o mesmo id herdar as permissões do app.
 * ponytail: corta no ` or ` sem olhar parênteses; erra para o lado de "fraco", nunca de "forte".
 */
export function requirementWeak(dr) {
  const expr = String(dr).replace(/^[#\s]*designated\s*=>\s*/, '').trim();
  if (!expr) return true;
  return expr.split(/\sor\s/).some(r => !/cdhash H"[0-9a-f]+"|certificate leaf = H"[0-9a-f]+"/i.test(r));
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { shell: false, encoding: 'utf8', ...opts });
  return { ok: !r.error && r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), stdout: (r.stdout ?? '').trim() };
}
/** Falha = exceção, nunca process.exit: o `finally` do install precisa rodar (sem pasta de montagem sobrando). */
const fail = msg => { throw new Error(msg); };
function must(cmd, args) {
  const r = run(cmd, args);
  if (!r.ok) fail(`falhou: ${cmd} ${args.join(' ')}\n${r.out}`);
  return r;
}
const NODE = 'bin/node';
const APP_PATH = 'folga/bin:/usr/bin:/bin:/usr/sbin:/sbin'; // nenhuma pasta do usuário
const NODE_ENTITLEMENTS = {
  'com.apple.security.cs.allow-jit': true,
  'com.apple.security.cs.allow-unsigned-executable-memory': true,
};
const nodeMajor = v => Number(/^v?(\d+)\./.exec(String(v))?.[1] ?? 0);
const version = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

function build(outDir) {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) fail('falta a interface: rode npm run build');
  const probe = join(ROOT, 'probe', 'bin', 'probe-mac');
  if (!existsSync(probe)) fail('falta a sonda: rode npm run build:probe');
  if (nodeMajor(process.version) < 24) fail(`o Folga precisa do Node 24 ou mais novo (este é ${process.version})`);

  const app = join(outDir, 'Folga.app');
  const res = join(app, 'Contents', 'Resources');
  const macos = join(app, 'Contents', 'MacOS');
  rmSync(app, { recursive: true, force: true });
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(res, 'folga', 'probe', 'bin'), { recursive: true });
  mkdirSync(join(res, 'folga', 'bin'), { recursive: true });

  must('/usr/bin/xcrun', ['swiftc', '-O', join(ROOT, 'mac', 'Folga.swift'), '-o', join(macos, 'Folga')]);

  // cpSync recursivo: o aviso do CLAUDE.md (caminho com acento) é do Windows; este script só roda no Mac
  const testes = join(ROOT, 'src', 'tests');
  cpSync(join(ROOT, 'src'), join(res, 'folga', 'src'), { recursive: true, filter: p => p !== testes && !p.startsWith(testes + sep) });
  cpSync(join(ROOT, 'dist'), join(res, 'folga', 'dist'), { recursive: true });
  cpSync(probe, join(res, 'folga', 'probe', 'bin', 'probe-mac'));
  cpSync(join(ROOT, 'package.json'), join(res, 'folga', 'package.json'));
  // o node de quem rodou o build, copiado para dentro do selo (ver cabeçalho)
  cpSync(process.execPath, join(res, 'folga', NODE));
  writeFileSync(join(res, 'folga.json'), JSON.stringify({ node: `folga/${NODE}`, path: APP_PATH }, null, 2) + '\n');

  const v = version();
  const plist = join(app, 'Contents', 'Info.plist');
  writeFileSync(plist, JSON.stringify({
    CFBundleIdentifier: ID, CFBundleExecutable: 'Folga', CFBundleName: 'Folga', CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: v, CFBundleVersion: v, LSUIElement: true, LSMinimumSystemVersion: '13.0',
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
  }));
  must('/usr/bin/plutil', ['-convert', 'xml1', plist]);

  // a sonda de dentro antes do bundle (o selo do bundle cobre o binário já assinado), mesma identidade
  // Tudo com hardened runtime: sem ele, DYLD_INSERT_LIBRARIES ou um depurador entrariam num processo que
  // carrega as permissões do app.
  const sign = (...a) => must('/usr/bin/codesign', ['--force', '-s', '-', '--options', 'runtime', ...a]);
  sign(join(res, 'folga', 'probe', 'bin', 'probe-mac'));
  // node: só os direitos de que o V8 precisa (JIT). Os da Node.js Foundation incluem get-task-allow,
  // allow-dyld-environment-variables e disable-library-validation, que reabririam a porta acima.
  const ent = join(mkdtempSync(join(tmpdir(), 'folga-ent-')), 'node.plist');
  writeFileSync(ent, JSON.stringify(NODE_ENTITLEMENTS));
  must('/usr/bin/plutil', ['-convert', 'xml1', ent]);
  sign('--entitlements', ent, join(res, 'folga', NODE));
  rmSync(dirname(ent), { recursive: true, force: true });
  sign(app);
  console.log(`ok: ${app}`);
}

/** Linha "designated => ..." da saída do `codesign -d -r-` (ou o próprio texto, se já for só o requisito). */
function designated(text) {
  const line = String(text).split('\n').find(l => l.includes('designated =>'));
  return (line ?? '').replace(/^[#\s]*designated\s*=>\s*/, '').trim();
}

function check(app, previous) {
  let falhas = 0;
  const caso = (nome, ok, detalhe = '') => {
    console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${nome}${!ok && detalhe ? `\n       ${detalhe}` : ''}`);
    if (!ok) falhas++;
  };
  const plist = join(app, 'Contents', 'Info.plist');
  const exe = join(app, 'Contents', 'MacOS', 'Folga');
  const probe = join(app, 'Contents', 'Resources', 'folga', 'probe', 'bin', 'probe-mac');
  if (!existsSync(plist) || !existsSync(exe)) { caso(`${app} é um Folga.app`, false); return 1; }

  let r = run('/usr/bin/plutil', ['-lint', plist]); caso('Info.plist válido', r.ok, r.out);
  r = run('/usr/bin/plutil', ['-extract', 'LSUIElement', 'raw', plist]); caso('LSUIElement verdadeiro', r.stdout === 'true', r.out);
  r = run(exe, ['--version']); caso(`Folga --version = folga ${version()}`, r.stdout === `folga ${version()}`, r.out);
  r = run(exe, ['--selftest']); caso('Folga --selftest', r.ok, r.out);
  r = run('/usr/bin/codesign', ['--verify', '--strict', app]); caso('assinatura do bundle', r.ok, r.out);
  r = run('/usr/bin/codesign', ['--verify', '--strict', probe]); caso('assinatura da sonda de dentro', r.ok, r.out);
  const node = join(app, 'Contents', 'Resources', 'folga', NODE);
  r = run(node, ['--version']); caso(`node de dentro roda e é ≥ 24 (${r.stdout || 'não rodou'})`, r.ok && nodeMajor(r.stdout) >= 24, r.out);
  r = run('/usr/bin/codesign', ['--verify', '--strict', node]); caso('assinatura do node de dentro', r.ok, r.out);
  for (const [nome, alvo] of [['app', app], ['sonda', probe], ['node', node]]) {
    r = run('/usr/bin/codesign', ['-dv', alvo]);
    caso(`hardened runtime no ${nome}`, /flags=0x[0-9a-f]*\([^)]*runtime/.test(r.out), r.out);
  }
  r = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', node]);
  const ents = [...r.stdout.matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1]).sort();
  caso(`node de dentro só com os direitos do JIT (${ents.join(', ')})`, ents.join() === Object.keys(NODE_ENTITLEMENTS).sort().join(), r.out);
  let cfg = {}; try { cfg = JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'folga.json'), 'utf8')); } catch {}
  caso('folga.json aponta para o node e o PATH de dentro', cfg.node === `folga/${NODE}` && cfg.path === APP_PATH, JSON.stringify(cfg));
  r = run('/usr/bin/codesign', ['-d', '-r-', app]);
  const dr = designated(r.stdout);
  caso(`requisito designado preso a hash (${dr || 'vazio'})`, r.ok && !requirementWeak(dr), r.out);
  if (previous) {
    const prev = designated(readFileSync(previous, 'utf8'));
    r = run('/usr/bin/codesign', ['--verify', `-R=${prev}`, app]);
    caso(`requisito do build anterior vale neste (${prev || 'vazio'})`, !!prev && r.ok, r.out);
  }
  return falhas ? 1 : 0;
}

// ---- install / uninstall ----
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
/** Registro no LaunchServices: sem ele o macOS recusa as notificações sem perguntar (ADR 0007). Falha só avisa. */
function lsregister(flag, app) {
  const r = run(LSREGISTER, [flag, app]);
  if (!r.ok) console.log(`aviso: lsregister ${flag} falhou (${r.out || 'sem saída'}); o resto segue`);
}
const installDir = () => resolve(process.env.FOLGA_INSTALL_DIR ?? join(homedir(), 'Applications'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** pids cujo executável é EXATAMENTE `exe` (nunca por nome: build/Folga.app e outras cópias ficam em paz). */
function pidsOf(exe) {
  try { exe = realpathSync(exe); } catch {}   // o ps mostra /private/var, não /var
  const r = run('/bin/ps', ['-axo', 'pid=,comm=']);
  return r.stdout.split('\n').map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(m => m && m[2] === exe).map(m => Number(m[1]));
}
async function waitFor(exe, running, ms) {
  for (let t = 0; t < ms; t += 200) { if ((pidsOf(exe).length > 0) === running) return true; await sleep(200); }
  return (pidsOf(exe).length > 0) === running;
}
async function stopApp(app) {
  const exe = join(app, 'Contents', 'MacOS', 'Folga');
  const pids = pidsOf(exe);
  if (!pids.length) return;
  console.log(`parando o Folga instalado (pid ${pids.join(', ')})`);
  for (const pid of pids) try { process.kill(pid, 'SIGTERM'); } catch {}
  if (!await waitFor(exe, false, 10000)) fail('o Folga instalado não saiu; nada foi trocado');
}

async function install() {
  const dir = installDir();
  const app = join(dir, 'Folga.app'), novo = join(dir, 'Folga.app.novo'), velho = join(dir, 'Folga.app.velho');
  const stage = mkdtempSync(join(tmpdir(), 'folga-install-'));
  try {
    // process.execPath, sem npx: o mesmo node que vai dentro do bundle
    must(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
    must(process.execPath, [join(ROOT, 'scripts', 'build-probe.mjs')]);
    build(stage);
    if (check(join(stage, 'Folga.app')) !== 0) fail('check vermelho: o instalado não foi tocado');
    mkdirSync(dir, { recursive: true });
    rmSync(novo, { recursive: true, force: true });
    must('/usr/bin/ditto', [join(stage, 'Folga.app'), novo]);
    await stopApp(app);
    const tinhaVelho = existsSync(app);
    rmSync(velho, { recursive: true, force: true });
    if (tinhaVelho) renameSync(app, velho);
    try { renameSync(novo, app); } catch (e) { if (tinhaVelho) renameSync(velho, app); throw e; }
    lsregister('-f', app);
    must('/usr/bin/open', [app]);
    if (!await waitFor(join(app, 'Contents', 'MacOS', 'Folga'), true, 10000)) {
      fail(`o novo Folga não abriu; o antigo, se havia, ficou em ${velho}`);
    }
    rmSync(velho, { recursive: true, force: true });
    console.log(`instalado e aberto: ${app}`);
  } finally {
    // o check roda o app da pasta temporária e o LaunchServices o registra: sem isto fica um 2º registro órfão
    // do mesmo bundle id a cada instalação (o que confunde LaunchServices e notificações, ADR 0007)
    run(LSREGISTER, ['-u', join(stage, 'Folga.app')]);   // falha = nunca foi registrado: nada a fazer
    rmSync(stage, { recursive: true, force: true });
  }
}

async function uninstall() {
  const app = join(installDir(), 'Folga.app');
  await stopApp(app);
  if (existsSync(app)) lsregister('-u', app);
  rmSync(app, { recursive: true, force: true });
  rmSync(join(installDir(), 'Folga.app.novo'), { recursive: true, force: true });
  rmSync(join(installDir(), 'Folga.app.velho'), { recursive: true, force: true });
  const startup = process.env.FOLGA_STARTUP_DIR ?? join(homedir(), 'Library', 'LaunchAgents');
  const plist = join(startup, 'local.folga.app.plist');
  if (existsSync(plist)) {
    rmSync(plist);
    console.log(`removido: ${plist} (o item de login continua carregado até você sair da sessão; no próximo login ele não volta)`);
  }
  console.log(`desinstalado: ${app}`);
  console.log(`seus dados continuam em ${join(homedir(), 'Library', 'Application Support', 'Folga')} (apague à mão se quiser).`);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = name => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    if (!v || v.startsWith('--')) { console.error(`${name} precisa de um valor`); process.exit(1); }
    return v;
  };
  if (process.platform !== 'darwin') { console.error('o Folga.app só existe no Mac'); process.exit(1); }
  try {
    if (cmd === 'build') build(resolve(opt('--out') ?? join(ROOT, 'build'))); // --adhoc: aceito, é o único ramo
    else if (cmd === 'install') await install();
    else if (cmd === 'uninstall') await uninstall();
    else if (cmd === 'check' && rest[0]) process.exitCode = check(resolve(rest[0]), opt('--previous'));
    else fail(`subcomando desconhecido: ${cmd ?? '(nenhum)'}\nuso: node scripts/mac-app.mjs install | uninstall | build [--adhoc] [--out <dir>] | check <app> [--previous <arquivo>]`);
  } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
}
