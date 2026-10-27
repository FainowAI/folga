import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessText, dataDir, readPrivate, writePrivate, defaultSettings, MAC_NEVER_CLOSE, userFolders } from '../platform.ts';
import { DEFAULT_SETTINGS } from '../types.ts';

const casos: string[] = [];
function caso(nome: string, fn: () => void) { fn(); casos.push(nome); }

caso('dataDir: darwin, win32 e FOLGA_DATA_DIR', () => {
  assert.equal(dataDir('darwin', {}, '/Users/v'), join('/Users/v', 'Library', 'Application Support', 'Folga'));
  assert.equal(dataDir('win32', { LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }, 'x'), join('C:\\Users\\A\\AppData\\Local', 'Folga'));
  assert.equal(dataDir('darwin', { FOLGA_DATA_DIR: '/tmp/f' }, '/Users/v'), '/tmp/f');
});

caso('accessText (R32, decisão 17): servidor com Acesso Total ao Disco é sinalizado para desligar; sem link', () => {
  assert.equal(accessText('/A/Folga', 'não', 'não'), 'responsável /A/Folga · acesso ao disco: servidor não · assistente não');
  const sim = accessText('/A/Folga', 'sim', 'não');
  assert.match(sim, /servidor sim .*O Folga está com Acesso Total ao Disco — desligue em Ajustes \(não é necessário\)/);
  assert.doesNotMatch(sim, /Privacy|›|:\/\//);
  assert.match(accessText('?', '?', 'sim'), /assistente SIM$/);
});

caso('writePrivate/readPrivate: 0600, nunca segue link (nem no .tmp), 0644 antigo vira 0600', () => {
  const d = mkdtempSync(join(tmpdir(), 'folga-priv-'));
  try {
    const f = join(d, 'ui-token');
    writePrivate(f, 'abc');
    assert.equal(readPrivate(f), 'abc');
    if (process.platform === 'win32') return;
    assert.equal(statSync(f).mode & 0o777, 0o600);
    const alvo = join(d, 'alvo'); writeFileSync(alvo, 'intacto');
    writeFileSync(join(d, 't'), 'x', { mode: 0o644 });
    assert.equal(readPrivate(join(d, 't')), 'x');
    assert.equal(statSync(join(d, 't')).mode & 0o777, 0o600, '0644 antigo fechado em 0600');
    symlinkSync(alvo, join(d, 'link'));
    assert.equal(readPrivate(join(d, 'link')), '', 'link lido como ausente');
    writePrivate(join(d, 'link'), 'novo');
    assert.ok(!lstatSync(join(d, 'link')).isSymbolicLink() && readFileSync(alvo, 'utf8') === 'intacto', 'link trocado, alvo intacto');
    symlinkSync(alvo, join(d, 'p.tmp'));
    writePrivate(join(d, 'p'), 'novo');
    assert.equal(readFileSync(alvo, 'utf8'), 'intacto', '.tmp plantado não é seguido');
    assert.ok(!existsSync(join(d, 'p.tmp')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

caso('defaultSettings: win32 intacto; darwin muda neverClose e o gatilho', () => {
  assert.deepEqual(defaultSettings('win32'), DEFAULT_SETTINGS);
  const mac = defaultSettings('darwin');
  assert.deepEqual(mac.neverClose, MAC_NEVER_CLOSE);
  assert.ok(mac.neverClose.includes('com.apple.terminal') && mac.neverClose.includes('com.anthropic.claudefordesktop'));
  assert.ok(mac.neverClose.every(k => k === k.toLowerCase()));
  assert.deepEqual({ ...mac, neverClose: DEFAULT_SETTINGS.neverClose, autoCareTrigger: 'percent' }, DEFAULT_SETTINGS);
  assert.equal(mac.autoCareTrigger, 'pressure');
  assert.equal(defaultSettings('win32').autoCareTrigger, 'percent');
  assert.equal(mac.autoCarePressure, 'warn');
  assert.equal(defaultSettings('win32').autoCarePressure, 'warn');
});

caso('userFolders: as 6 do Mac (sem iCloud Drive) e a lista de hoje do Windows', () => {
  assert.deepEqual(userFolders('darwin', {}, '/Users/v'), ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Movies', 'Music']
    .map(n => join('/Users/v', n)));
  const nomes = ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Videos', 'Music'];
  assert.deepEqual(userFolders('win32', { OneDrive: 'D:\\OD' }, 'C:\\Users\\A'), ['C:\\Users\\A', 'D:\\OD'].flatMap(b => nomes.map(n => join(b, n))));
});

casos.forEach((c) => console.log('ok  ' + c));
console.log(`platform: ${casos.length} casos ok`);
