import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lerData, lerValor } from '../src/manual.ts';

test('lerData: DD/MM usa o ano atual; data impossível falha', () => {
  const hoje = new Date(2026, 10, 8);
  assert.equal(lerData('10/11', hoje), '2026-11-10');
  assert.equal(lerData('1/2/2027', hoje), '2027-02-01');
  assert.equal(lerData('2026-11-30', hoje), '2026-11-30');
  for (const s of ['31/11', '2026-02-30', '10-11-2026', 'ontem']) assert.throws(() => lerData(s, hoje), /Data inválida/);
});

test('lerValor: vírgula nos centavos, sempre positivo, até 2 casas', () => {
  assert.equal(lerValor('45,90'), 45.9);
  assert.equal(lerValor('1.234,56'), 1234.56);
  assert.equal(lerValor('R$ 1500'), 1500);
  assert.equal(lerValor('0,10'), 0.1);
  for (const s of ['0', '-10', '10,005', 'abc', '']) assert.throws(() => lerValor(s), /Valor inválido/);
});
