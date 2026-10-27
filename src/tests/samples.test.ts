// Janela dos gráficos de linha: corta pelo tempo, não pela contagem.
import assert from 'node:assert/strict';
import { pushSample, freshWindowMs } from '../samples.ts';

let list = pushSample([], { t: 0, mem: 50, disk: null });
assert.deepEqual(list.map(s => s.t), [0]);
for (let t = 2_000; t <= 60_000; t += 2_000) list = pushSample(list, { t, mem: 50, disk: 1 });
assert.equal(list.length, 31, 'aos 60 s ainda guarda a leitura do instante 0');
list = pushSample(list, { t: 62_000, mem: 50, disk: 1 });
assert.equal(list[0]!.t, 2_000, 'a leitura de mais de 60 s sai');
assert.equal(list.length, 31);
// intervalo maior: menos pontos, mesma janela
let slow = [] as ReturnType<typeof pushSample>;
for (let t = 0; t <= 120_000; t += 10_000) slow = pushSample(slow, { t, mem: 1, disk: 1 });
assert.deepEqual(slow.map(s => s.t), [60_000, 70_000, 80_000, 90_000, 100_000, 110_000, 120_000]);
// janela de "leitura nova" para apagar cache: acompanha o intervalo da sonda (com 30 s, 10 s fixos viravam null quase sempre)
assert.equal(freshWindowMs(2), 10_000, 'intervalo curto: piso de 10 s');
assert.equal(freshWindowMs(30), 90_000, 'intervalo de 30 s: três leituras');
assert.equal(freshWindowMs(Number.NaN), 10_000, 'ajuste torto: piso');
console.log('ok  samples');
