// Texto do gatilho do Auto Care nas telas: percentual no Windows, pressão no Mac.
import assert from 'node:assert/strict';
import { autoCareAt, pressureName } from '../../web/src/format.ts';
import { DEFAULT_SETTINGS } from '../types.ts';

const NB = ' ';
assert.equal(autoCareAt({ ...DEFAULT_SETTINGS, autoCareThreshold: 92 }), `em 92${NB}%`);
assert.equal(autoCareAt({ ...DEFAULT_SETTINGS, autoCareTrigger: 'pressure', autoCarePressure: 'warn' }), 'na pressão amarela');
assert.equal(autoCareAt({ ...DEFAULT_SETTINGS, autoCareTrigger: 'pressure', autoCarePressure: 'critical' }), 'na pressão vermelha');
assert.deepEqual(['normal', 'warn', 'critical'].map(p => pressureName[p as 'normal']), ['verde', 'amarela', 'vermelha']);
console.log('format: 4 casos ok');
