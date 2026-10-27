// Servidor real numa porta alta, com pasta de dados temporária e sonda falsa (R15–R17, R07–R09, R14).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '../platform.ts';
import { type LogEntry, type MemoryState, type ReleaseResponse, type Settings, type Warning } from '../types.ts';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const dataDir = mkdtempSync(join(tmpdir(), 'folga-http-'));
const startupDir = mkdtempSync(join(tmpdir(), 'folga-início-'));   // nunca a pasta Inicializar real; acento como em C:\Users\Antônio
const filesRoot = mkdtempSync(join(tmpdir(), 'folga-files-'));   // varredura de teste: pasta vazia, nunca as pastas reais do usuário
const appBase = mkdtempSync(join(tmpdir(), 'folga-appdata-'));   // dados dos apps de teste: nunca o ~/Library real
mkdirSync(join(appBase, 'Claude', 'Cache'), { recursive: true });
writeFileSync(join(appBase, 'Claude', 'Cache', 'f'), 'x'.repeat(4096));
const root = join(import.meta.dirname, '..', '..');
// já no disco antes de subir: ui-token curto demais (B5) e settings.json com valor que iria para o comando da sonda (B7)
writeFileSync(join(dataDir, 'ui-token'), 'curto');
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ sampleSeconds: "2'); calc; ('", idleMinutes: 15 }));

const server = spawn(process.execPath, ['--no-warnings', join(root, 'src', 'server.ts')], {
  env: {
    ...process.env, FOLGA_NOTIFY: '0', FOLGA_PORT: String(PORT), FOLGA_DATA_DIR: dataDir,
    FOLGA_FAKE_PROBE: join(root, 'src', 'tests', 'fake-probe.mjs'),
    FOLGA_FILES_ROOTS: filesRoot, FOLGA_CLOSE_WAIT_MS: '300', FOLGA_MEASURE_WAIT_MS: '300', FOLGA_STARTUP_DIR: startupDir,
    FOLGA_APPDATA_BASES: JSON.stringify({ appSupport: appBase, roamingAppData: appBase }),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

type Res = { status: number; body: any; headers: Record<string, string | string[] | undefined> };
function call(method: string, path: string, opts: { body?: unknown; token?: string; host?: string; type?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${PORT}`, ...opts.headers };
    if (data !== undefined) headers['content-type'] = opts.type ?? 'application/json';
    if (opts.token) headers['x-folga-token'] = opts.token;
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers }, res => {
      let text = '';
      res.on('data', c => (text += c));
      res.on('end', () => { let body: any = text; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode ?? 0, body, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { const r = await call('GET', '/api/state'); if (r.status === 200) return r.body as MemoryState; } catch {}
    await sleep(100);
  }
  throw new Error('servidor não subiu');
}

let passed = 0;
const ok = (name: string) => { passed++; console.log(`ok  ${name}`); };

try {
  const state = await waitReady();
  assert.ok(state.apps.some(a => a.key === 'notepad' && a.state !== 'protected'));
  assert.equal(state.apps.find(a => a.key === 'explorer')?.reason, 'system');
  assert.equal(state.apps.find(a => a.key === 'svchost')?.reason, 'other_session');
  ok('estado: notepad candidato, explorer e svchost protegidos');

  // B7: o settings.json do disco passa pela mesma validação do PUT; inválido volta aos padrões (e o valor nunca chega à sonda)
  assert.deepEqual((await call('GET', '/api/settings')).body, defaultSettings());
  ok('B7: settings.json inválido no disco → padrões');

  // R34: voltar aos padrões não pode ser silencioso, e salvar em Ajustes (o que o aviso manda fazer) tem que resolver
  const avisos = () => call('GET', '/api/warnings').then(r => (r.body as Warning[]).filter(w => w.kind === 'ajustes'));
  const aviso = await avisos();
  assert.equal(aviso.length, 1, 'o settings.json inválido tem que virar aviso');
  assert.equal(aviso[0]!.severity, 'critico');
  assert.equal(aviso[0]!.view, 'ajustes');

  assert.equal((await call('GET', '/api/state', { host: 'evil.example:80' })).status, 403);
  assert.equal((await call('GET', '/api/state', { host: `localhost:${PORT}` })).status, 200);
  ok('R15: Host fora de 127.0.0.1/localhost recusado');

  const token = (await call('GET', '/api/token')).body.token as string;
  assert.equal(token, readFileSync(join(dataDir, 'ui-token'), 'utf8').trim());
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(token, 'curto');
  ok('token criado na pasta de dados e servido em /api/token; ui-token curto foi regerado (B5a)');

  assert.equal((await call('PUT', '/api/settings', { body: { idleMinutes: 10 } })).status, 403);
  assert.equal((await call('PUT', '/api/settings', { body: { idleMinutes: 10 }, token, type: 'text/plain' })).status, 415);
  assert.equal((await call('POST', '/api/release', { body: { keys: ['notepad'] } })).status, 403);
  ok('R16: sem token 403, sem JSON 415');

  // M6: o agente tem token próprio, que só existe durante um turno (arquivo criado e apagado pelo servidor; o
  // turno em si está em agent.test). Parado, não há agent-token no disco e nenhum valor antigo vale.
  assert.ok(!existsSync(join(dataDir, 'agent-token')), 'sem turno do assistente não há agent-token no disco');
  assert.equal((await call('POST', '/api/files/scan', { body: {}, token })).status, 200, 'o ui-token continua valendo na varredura');
  assert.equal((await call('POST', '/api/files/scan', { body: {}, token: 'x'.repeat(64) })).status, 403);
  ok('M6: agent-token só durante o turno; varredura com o ui-token, token qualquer dá 403');

  if (process.platform === 'darwin') {
    const w = await call('POST', '/api/window', { body: {}, token });
    assert.equal(w.status, 409);
    assert.equal(w.body.erro, 'abra pelo app Folga na barra de menus');
    ok('Mac: POST /api/window → 409 "abra pelo app Folga na barra de menus" (nada de Edge)');
  }

  const good = await call('PUT', '/api/settings', { body: { idleMinutes: 10, neverClose: ['Code.exe'] }, token });
  assert.equal(good.status, 200);
  assert.equal((good.body as Settings).idleMinutes, 10);
  assert.deepEqual((good.body as Settings).neverClose, ['code']);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).idleMinutes, 10);
  for (const bad of [{ autoCareThreshold: 120 }, { idleMinutes: '10' }, { naoExiste: 1 }, { neverClose: 'code' }, [1]]) {
    const r = await call('PUT', '/api/settings', { body: bad, token });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(!String(r.body.erro).includes('\\'), 'R17: erro sem caminho');
  }
  ok('PUT /api/settings valida faixa, tipo e campo, e grava settings.json');

  // a sonda do Windows não lê pressão de memória: gatilho por pressão lá seria um Auto Care que nunca dispara
  const pressao = await call('PUT', '/api/settings', { body: { autoCareTrigger: 'pressure' }, token });
  if (process.platform === 'win32') {
    assert.equal(pressao.status, 400);
    assert.match(String(pressao.body.erro), /Windows/);
    assert.equal((await call('GET', '/api/settings')).body.autoCareTrigger, 'percent');
  } else {
    assert.equal(pressao.status, 200);
    assert.equal((await call('PUT', '/api/settings', { body: { autoCareTrigger: 'percent' }, token })).status, 200);
  }
  ok(`PUT autoCareTrigger pressure: 400 no Windows, aceito fora dele (aqui: ${process.platform})`);

  // R34: o PUT acima gravou um arquivo válido, então o aviso tem que sair sozinho, sem reiniciar o Folga
  assert.deepEqual(await avisos(), [], 'salvar em Ajustes tira o aviso "seus ajustes não foram lidos"');
  ok('R34: aviso de ajustes aparece com arquivo inválido e some ao salvar');

  assert.equal((await call('POST', '/api/release', { body: { keys: ['explorer'] }, token })).status, 409);
  ok('R09: pedido com app protegido recusado');

  const rel = await call('POST', '/api/release', { body: { keys: ['notepad'] }, token });
  assert.equal(rel.status, 200);
  const r = rel.body as ReleaseResponse;
  assert.deepEqual(r.results.map(x => x.outcome), ['fechou']);
  assert.equal(r.availAfter - r.availBefore, 40e6);
  ok('R07/R08: liberar fecha o notepad e mede o disponível');

  const log = (await call('GET', '/api/log?limit=5')).body as LogEntry[];
  assert.equal(log.length, 1);
  assert.equal(log[0]!.origin, 'manual');
  assert.equal(log[0]!.results[0]!.key, 'notepad');
  const st = (await call('GET', '/api/state')).body as MemoryState;
  assert.ok(st.freed.some(f => f.key === 'notepad'));
  assert.ok(!st.apps.some(a => a.key === 'notepad'));
  ok('R14: registro gravado e Liberados no estado');

  assert.equal((await call('GET', '/api/startup')).body.on, false);
  assert.equal((await call('PUT', '/api/startup', { body: { on: true } })).status, 403);
  if (process.platform === 'win32') {
    assert.equal((await call('PUT', '/api/startup', { body: { on: true }, token })).body.on, true);
    assert.ok(existsSync(join(startupDir, 'Folga.lnk')));
  }
  assert.equal((await call('PUT', '/api/startup', { body: { on: false }, token })).body.on, false);
  assert.ok(!existsSync(join(startupDir, 'Folga.lnk')));
  ok('P04: atalho de inicialização liga e desliga (pasta temporária)');
  if (process.platform !== 'win32') {
    for (const t of ['ui-token']) assert.equal(statSync(join(dataDir, t)).mode & 0o777, 0o600, t);
    ok('tokens gravados em 0600');
  }

  if (process.platform === 'darwin') {
    // Mac: LaunchAgent só dentro do app (FOLGA_APP=1); sem ele o interruptor não existe e nada é escrito
    const plist = join(startupDir, 'local.folga.app.plist');
    assert.deepEqual((await call('GET', '/api/startup')).body, { on: false, available: false });
    assert.equal((await call('PUT', '/api/startup', { body: { on: true }, token })).status, 409);
    assert.ok(!existsSync(plist), 'sem FOLGA_APP nada é criado');

    const appStartup = async (appPath: string | undefined, fn: (c: (m: string, p: string, body?: unknown) => Promise<Res>, dir: string, x: { port: number; data: string; tk: string }) => Promise<void>,
      opts: { env?: Record<string, string>; settings?: string } = {}) => {
      const port = PORT + 1001 + Math.floor(Math.random() * 500);
      const dir = mkdtempSync(join(tmpdir(), 'folga-launchagents-'));
      const data = mkdtempSync(join(tmpdir(), 'folga-http-app-'));
      const env: Record<string, string | undefined> = { ...process.env, FOLGA_NOTIFY: '0', FOLGA_PORT: String(port), FOLGA_DATA_DIR: data, FOLGA_STARTUP_DIR: dir,
        FOLGA_FAKE_PROBE: join(root, 'src', 'tests', 'fake-probe.mjs'), FOLGA_APP: '1', FOLGA_APP_PATH: appPath };
      if (appPath === undefined) delete env.FOLGA_APP_PATH;
      Object.assign(env, opts.env);
      if (opts.settings !== undefined) writeFileSync(join(data, 'settings.json'), opts.settings);
      const child = spawn(process.execPath, ['--no-warnings', join(root, 'src', 'server.ts')], { env, stdio: ['pipe', 'ignore', 'inherit'] });   // stdin em pipe: FOLGA_APP=1 sai quando ele fecha
      const tk = 'ab'.repeat(32);
      child.stdin!.write(tk + '\n');   // como o Folga.app: o token chega na 1ª linha do stdin, nunca por arquivo
      try {
        let up = false;
        for (let i = 0; i < 100 && !up; i++) {
          try { up = (await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { 'x-folga-token': tk } })).status === 200; } catch { await sleep(100); }
          if (!up) await sleep(50);
        }
        assert.ok(up, 'servidor do app não subiu');
        await fn(async (m, p, body) => {
          const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'x-folga-token': tk, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
          return { status: r.status, body: await r.json().catch(() => null), headers: {} };
        }, dir, { port, data, tk });
      } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); await rm(data, { recursive: true, force: true, maxRetries: 5 }); }
    };

    // revisão de segurança: dentro do app a chave nunca vai para o disco e nenhuma /api/ responde sem ela
    await appStartup('/Users/x/Applications/Folga.app', async (_c, _dir, { port, data, tk }) => {
      const get = (p: string, h: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers: h }).then(r => r.status);
      assert.ok(!existsSync(join(data, 'ui-token')), 'ui-token não pode existir no disco dentro do app');
      assert.ok(!existsSync(join(data, 'agent-token')), 'agent-token só existe durante um turno do assistente');
      for (const p of ['/api/token', '/api/state', '/api/files/stale', '/api/suggestions', '/api/agent']) {
        assert.equal(await get(p), 403, `${p} sem token`);
        assert.equal(await get(p, { 'x-folga-token': 'cd'.repeat(32) }), 403, `${p} com token errado`);
      }
      assert.equal(await get('/api/token', { cookie: `folga_t=${tk}` }), 200, 'a janela (cookie) pega o token');
      assert.equal(await get('/api/state', { cookie: `outro=1; folga_t=${tk}` }), 200, 'cookie entre outros');
      assert.notEqual(await get('/', {}), 403, 'a página em si não pede token (404 na CI, que não monta a interface)');
    });
    ok('segurança (app): token só na memória; /api/ inteira recusa sem token, cookie da janela passa');

    await appStartup('/Users/x/Applications/Fol&ga.app', async (c, dir) => {
      const file = join(dir, 'local.folga.app.plist');
      assert.deepEqual((await c('GET', '/api/startup')).body, { on: false, available: true });
      assert.deepEqual((await c('PUT', '/api/startup', { on: true })).body, { on: true });
      assert.deepEqual((await c('GET', '/api/startup')).body, { on: true, available: true });
      const lint = spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
      const j = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }).stdout);
      assert.equal(j.Label, 'local.folga.app');
      assert.deepEqual(j.ProgramArguments, ['/Users/x/Applications/Fol&ga.app/Contents/MacOS/Folga', '--login']);
      assert.equal(j.RunAtLoad, true);
      assert.equal(j.LimitLoadToSessionType, 'Aqua');
      assert.equal(j.ProcessType, 'Interactive');
      assert.ok(readFileSync(file, 'utf8').includes('Fol&amp;ga.app'), '& escapado no XML');
      assert.deepEqual((await c('PUT', '/api/startup', { on: false })).body, { on: false });
      assert.ok(!existsSync(file));
    });
    await appStartup(`/Users/x/A<b>"c'd.app`, async (c, dir) => {
      const file = join(dir, 'local.folga.app.plist'), alvo = join(dir, 'alvo');
      writeFileSync(alvo, 'intacto');
      symlinkSync(alvo, file);   // link plantado no lugar do plist: trocado, nunca seguido
      assert.deepEqual((await c('PUT', '/api/startup', { on: true })).body, { on: true });
      assert.equal(readFileSync(alvo, 'utf8'), 'intacto');
      assert.ok(!lstatSync(file).isSymbolicLink());
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const j = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }).stdout);
      assert.deepEqual(j.ProgramArguments, [`/Users/x/A<b>"c'd.app/Contents/MacOS/Folga`, '--login']);
      assert.ok(readFileSync(file, 'utf8').includes('A&lt;b&gt;&quot;c&apos;d.app'), '< > " \' escapados no XML');
    });

    // I2: aviso crítico ('ajustes' com settings.json torto) num servidor de teste não dispara processo de notificação.
    // O Folga.app aqui é falso: só anota num arquivo que foi chamado. Controle positivo prova que o teste enxerga o disparo.
    const fake = mkdtempSync(join(tmpdir(), 'folga-fakeapp-'));
    try {
      const app = join(fake, 'Folga.app'), bin = join(app, 'Contents', 'MacOS');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'Folga'), '#!/bin/sh\necho "$@" >> "$FOLGA_TEST_MARK"\n', { mode: 0o755 });
      const disparos = async (notifyEnv: string) => {
        const mark = join(fake, `mark-${notifyEnv || 'on'}`);
        await appStartup(app, async c => {
          for (let i = 0; i < 30 && !existsSync(mark); i++) {
            if (notifyEnv === '0' && (await c('GET', '/api/warnings')).body.some((w: Warning) => w.kind === 'ajustes')) { await sleep(1500); break; }
            await sleep(100);
          }
        }, { env: { FOLGA_NOTIFY: notifyEnv, FOLGA_TEST_MARK: mark }, settings: '{ torto' });
        return existsSync(mark) ? readFileSync(mark, 'utf8') : '';
      };
      assert.equal(await disparos(''), '--notify\n', 'controle: sem FOLGA_NOTIFY=0 o aviso crítico chama o app (falso)');
      assert.equal(await disparos('0'), '', 'FOLGA_NOTIFY=0: nenhum processo de notificação');
    } finally { await rm(fake, { recursive: true, force: true }); }
    ok('I2: servidor de teste com FOLGA_NOTIFY=0 não dispara notificação; sem ele, dispara (controle)');
    for (const ruim of ['relativo/Folga.app', '/Users/x/Folga', undefined, '/Users/x/F\x01.app', '/Users/x/F\n.app', '/Users/x/F\x1f.app']) {
      await appStartup(ruim, async (c, dir) => {
        assert.equal((await c('PUT', '/api/startup', { on: true })).status, 409, String(ruim));
        assert.ok(!existsSync(join(dir, 'local.folga.app.plist')));
      });
    }
    ok('P04 Mac: LaunchAgent só com FOLGA_APP=1, plist válido e escapado, caminho torto → 409');
  }

  // A1: percent-encoding inválido derrubava o servidor (URIError numa rejeição não tratada)
  for (const bad of ['/%', '/%E0%A4%A', '/assets/%zz', '/%C0%80%']) assert.equal((await call('GET', bad)).status, 400, bad);
  assert.equal(server.exitCode, null, 'o servidor continua de pé');
  assert.equal((await call('GET', '/api/state')).status, 200);
  ok('A1: GET /% e /%E0%A4%A dão 400 e o servidor continua respondendo');

  // M1: contra iframe de outro site, MIME sniffing e carga de fora; em qualquer resposta
  const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  const seguras = [
    await call('GET', '/'),                  // estática (ou 404 se dist não existe): os cabeçalhos vêm igual
    await call('GET', '/%'),                 // erro 400
    await call('GET', '/api/state'),         // JSON
    await call('GET', '/api/state', { host: 'evil.example:80' }),   // 403
    await call('PUT', '/api/settings', { body: {} }),
    await call('GET', '/api/nao-existe'),
  ];
  for (const r of seguras) {
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['content-security-policy'], CSP);
  }
  assert.ok([200, 404].includes(seguras[0]!.status));
  ok('M1: X-Frame-Options, nosniff e CSP em resposta estática, JSON e de erro');

  // dados dos apps: medição pelas bases de teste; cartão de limpeza sem token é recusado
  const ad = await call('GET', '/api/appdata');
  assert.equal(ad.status, 200);
  assert.ok(Array.isArray(ad.body.entries) && ad.body.entries.some((e: any) => e.name === 'Claude'));
  assert.equal((await call('POST', '/api/suggestions', { body: { kind: 'dados_apps', title: 'x', reason: '', items: ['claude:Cache'] } })).status, 403);
  ok('GET /api/appdata mede as bases de teste; POST dados_apps sem token → 403');

  // B5b: requisição que outro site dispara (ex.: uma imagem embutida noutro site) é recusada em /api/*
  for (const p of ['/api/state', '/api/disk', '/api/quickclean', '/api/token']) {
    assert.equal((await call('GET', p, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, p);
  }
  assert.equal((await call('POST', '/api/files/scan', { body: {}, token, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  for (const v of ['same-origin', 'same-site', 'none']) assert.equal((await call('GET', '/api/state', { headers: { 'sec-fetch-site': v } })).status, 200, v);
  ok('B5b: Sec-Fetch-Site cross-site recusado em /api/*; same-origin, same-site e none passam');

  console.log(`http: ${passed} casos ok`);
} finally {
  server.kill();
  await sleep(300);
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  await rm(startupDir, { recursive: true, force: true, maxRetries: 5 });
  await rm(filesRoot, { recursive: true, force: true, maxRetries: 5 });
  await rm(appBase, { recursive: true, force: true, maxRetries: 5 });
}
