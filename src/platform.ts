import { spawn } from 'node:child_process';
import { closeSync, constants, fchmodSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from './types.ts';

// Bundle ids (minúsculos) que o Mac nunca fecha por padrão: terminais, editores, Claude e Codex.
export const MAC_NEVER_CLOSE: readonly string[] = [
  'com.apple.terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'dev.warp.warp-stable',
  'com.microsoft.vscode', 'com.todesktop.230313mzl4w4u92', 'com.anthropic.claudefordesktop',
  'com.openai.codex', 'com.apple.dt.xcode',
  'net.kovidgoyal.kitty', 'org.alacritty', 'dev.zed.zed', 'com.jetbrains.toolbox',
  'com.jetbrains.intellij', 'com.jetbrains.intellij.ce', 'com.jetbrains.pycharm', 'com.jetbrains.pycharm.ce',
  'com.jetbrains.webstorm', 'com.jetbrains.goland', 'com.jetbrains.rider', 'com.google.android.studio',
];

export function dataDir(
  platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir(),
): string {
  if (env.FOLGA_DATA_DIR) return env.FOLGA_DATA_DIR;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Folga');
  return join(env.LOCALAPPDATA ?? join(import.meta.dirname, '..'), 'Folga');
}

/** Gravação atômica (ADR 0005) e privada: .tmp novo em 0600 (o 'wx' falha num link plantado, que antes é removido),
 *  e o rename troca o próprio nome, nunca segue um link no destino. No Windows o modo é ignorado. */
export function writePrivate(file: string, content: string) {
  const tmp = file + '.tmp';
  try { unlinkSync(tmp); } catch { /* não havia */ }
  writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
  renameSync(tmp, file);
}

/** Lê sem seguir link e fecha em 0600 o que ficou 0644 de antes. Ausente, link ou erro → ''. */
export function readPrivate(file: string): string {
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (process.platform !== 'win32') fchmodSync(fd, 0o600);
      return readFileSync(fd, 'utf8').trim();
    } finally { closeSync(fd); }
  } catch { return ''; }
}

/** Linha R32 do server.log dentro do app. Decisão 17: o Folga não pede Acesso Total ao Disco; se o servidor lê a
 *  Lixeira, alguém ligou a permissão e a linha manda desligar (só texto). "assistente SIM" é bug. */
export function accessText(responsavel: string, servidor: string, assistente: string): string {
  const aviso = servidor === 'sim' ? ' — O Folga está com Acesso Total ao Disco — desligue em Ajustes (não é necessário)' : '';
  return `responsável ${responsavel} · acesso ao disco: servidor ${servidor}${aviso} · assistente ${assistente === 'sim' ? 'SIM' : assistente}`;
}

export function defaultSettings(platform: NodeJS.Platform = process.platform): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (platform === 'darwin') { s.neverClose = [...MAC_NEVER_CLOSE]; s.autoCareTrigger = 'pressure'; }
  return s;
}

/** Pastas do usuário onde a busca de arquivos parados olha (as que não existem caem fora no allowedRoots). */
export function userFolders(
  platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir(),
): string[] {
  if (platform === 'darwin') {
    return ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Movies', 'Music']
      .map(n => join(home, n));
  }
  const bases = [home, env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((x): x is string => !!x);
  return bases.flatMap(b => ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Videos', 'Music'].map(n => join(b, n)));
}

/**
 * Modo de uma vez só da sonda do Mac (`probe-mac --meta|--trash|--size|--volume`): JSON no stdin, JSON no stdout.
 * Falha, tempo esgotado, saída ≠ 0 ou JSON quebrado → null. Fora do Mac, null sem spawn.
 */
export function macHelper(args: string[], input: unknown, timeoutMs: number): Promise<unknown | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise(res => {
    // shell:false e caminho absoluto, como o run() de files.ts
    const c = spawn(join(import.meta.dirname, '..', 'probe', 'bin', 'probe-mac'), args, { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => c.kill(), timeoutMs);
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', d => { out += d; });
    c.on('error', () => { clearTimeout(timer); res(null); });
    c.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return res(null);
      try { res(JSON.parse(out)); } catch { res(null); }
    });
    c.stdin.on('error', () => {});
    c.stdin.end(input === null || input === undefined ? undefined : JSON.stringify(input), 'utf8');
  });
}
