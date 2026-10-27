import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore: JS puro, é o próprio script de montar o Folga.app
import { requirementWeak } from '../../scripts/mac-app.mjs';

// Requisito designado: é a conta que o TCC faz para manter as permissões do app depois de reinstalar.
assert.equal(requirementWeak('designated => identifier "local.folga.app"'), true);            // qualquer ad-hoc com o id herdaria o TCC
assert.equal(requirementWeak('designated => identifier "local.folga.app" or cdhash H"ab12"'), true);
assert.equal(requirementWeak('designated => cdhash H"ab12"'), false);                        // ad-hoc: seguro, mas muda a cada build
assert.equal(requirementWeak('designated => identifier "local.folga.app" and certificate leaf = H"9f00"'), false);
assert.equal(requirementWeak(''), true);

if (process.platform === 'darwin') {
  // check num caminho que não é um app: vermelho, sem estourar
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'scripts', 'mac-app.mjs'), 'check', '/nao/existe/Folga.app'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  // --out sem valor (ou com outra flag no lugar) recusa antes de montar qualquer coisa
  for (const args of [['build', '--out'], ['build', '--out', '--adhoc']]) {
    const o = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'scripts', 'mac-app.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(o.status, 1, o.stderr);
    assert.match(o.stderr, /--out precisa de um valor/);
  }
  // T10: install que falha no meio (swiftc da sonda sem Command Line Tools) não deixa a pasta de montagem para trás
  const tmp = mkdtempSync(join(tmpdir(), 'folga-macapp-')), dest = mkdtempSync(join(tmpdir(), 'folga-macapp-dest-'));
  try {
    const script = join(import.meta.dirname, '..', '..', 'scripts', 'mac-app.mjs');
    const i = spawnSync(process.execPath, [script, 'install'], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, FOLGA_INSTALL_DIR: dest, DEVELOPER_DIR: '/nao/existe' } });
    assert.equal(i.status, 1, i.stdout + i.stderr);
    assert.deepEqual(readdirSync(tmp).filter(n => n.startsWith('folga-install-')), [], 'pasta de montagem vazou');
    assert.deepEqual(readdirSync(dest), [], 'nada instalado');
    // uninstall avisa que o item de login continua carregado até sair da sessão
    writeFileSync(join(tmp, 'local.folga.app.plist'), '<plist/>');   // pasta de teste, nunca ~/Library/LaunchAgents
    mkdirSync(join(dest, 'Folga.app', 'Contents'), { recursive: true });   // não é app de verdade: lsregister -u não pode barrar
    const u = spawnSync(process.execPath, [script, 'uninstall'], { encoding: 'utf8', env: { ...process.env, FOLGA_INSTALL_DIR: dest, FOLGA_STARTUP_DIR: tmp } });
    assert.equal(u.status, 0, u.stderr);
    assert.match(u.stdout, /até você sair da sessão/);
    assert.ok(!existsSync(join(tmp, 'local.folga.app.plist')));
    assert.ok(!existsSync(join(dest, 'Folga.app')), 'app apagado mesmo com o lsregister -u');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); }
}
console.log('macapp: ok');
