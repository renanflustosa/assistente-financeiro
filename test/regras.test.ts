import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Transacao } from '../src/ofx.ts';
import { CATEGORIAS_PADRAO } from '../src/planilha.ts';
import { classificar, importar, reclassificar, validarRegras, type Regra } from '../src/regras.ts';

const cats = CATEGORIAS_PADRAO;
const regras: Regra[] = [
  { contem: 'Pagamento recebido', ignorar: true },
  { contem: 'pagamento de fatura', conta: 'Nubank PJ', categoria: 'PJ - Pagamento fatura cartão' },
  { contem: 'pagamento de fatura', categoria: 'PF - Pagamento fatura cartão' },
  { contem: ['supermercado', 'ASSAÍ'], categoria: 'PF - Mercado' },
];

test('classificar: sem acento e sem caixa, primeira regra vence, conta restringe', () => {
  assert.deepEqual(classificar('Compra ASSAI ATACADISTA', true, 'Nubank PF', regras, cats), { ignorar: false, categoria: 'PF - Mercado' });
  assert.deepEqual(classificar('Pagamento de fatura', true, 'Nubank PJ', regras, cats), { ignorar: false, categoria: 'PJ - Pagamento fatura cartão' });
  assert.deepEqual(classificar('Pagamento de fatura', true, 'Nubank PF', regras, cats), { ignorar: false, categoria: 'PF - Pagamento fatura cartão' });
  assert.deepEqual(classificar('Pagamento recebido', false, 'Cartão', regras, cats), { ignorar: true });
  assert.deepEqual(classificar('Algo novo', true, 'Nubank PF', regras, cats), { ignorar: false, categoria: '' });
});

test('classificar: categoria de saída numa entrada fica em branco, com aviso', () => {
  const c = classificar('Estorno SUPERMERCADO', false, 'Nubank PF', regras, cats);
  assert.equal(c.ignorar, false);
  assert.ok(!c.ignorar && c.categoria === '' && /saída.*entrada/.test(c.aviso ?? ''));
});

test('validarRegras lista todos os erros de uma vez', () => {
  assert.throws(
    () => validarRegras([{ contem: '' }, { contem: 'x', categoria: 'Não existe' }], cats),
    (e: Error) => /regras\[0\]\.contem/.test(e.message) && /regras\[0\] precisa de "categoria"/.test(e.message) && /"Não existe" não existe/.test(e.message),
  );
});

const t = (data: string, valor: number, descricao: string, idBanco?: string): Transacao => ({ data, valor, descricao, ...(idBanco ? { idBanco } : {}) });

test('importar: deduplica por FITID e por hash, mantém compras iguais no mesmo dia', () => {
  const extrato = [t('2026-11-05', -30, 'Supermercado X'), t('2026-11-05', -30, 'Supermercado X'), t('2026-11-06', -10, 'Padaria'), t('2026-11-07', 0, 'Zerado'), t('2026-11-08', -5, 'Pagamento recebido')];
  const r1 = importar([], extrato, 'Nubank PF', regras, cats);
  assert.equal(r1.novos.length, 3);
  assert.equal(r1.ignorados, 2);
  assert.equal(new Set(r1.novos.map((l) => l.id)).size, 3);
  assert.deepEqual(
    r1.novos.map((l) => [l.categoria, l.valor, l.id.slice(0, 2)]),
    [['PF - Mercado', 30, 'S-'], ['PF - Mercado', 30, 'S-'], ['', 10, 'S-']],
  );

  // Reimportar o mesmo extrato (ou um que se sobrepõe) não duplica.
  const r2 = importar(r1.novos, [...extrato, t('2026-11-09', 100, 'Pix recebido')], 'Nubank PF', regras, cats);
  assert.equal(r2.novos.length, 1);
  assert.equal(r2.duplicados, 3);
  assert.equal(r2.novos[0]?.id.slice(0, 2), 'E-');

  // O mesmo texto em outra conta é outra transação.
  assert.equal(importar(r1.novos, extrato, 'Nubank PJ', regras, cats).novos.length, 3);

  const comFitid = [t('2026-11-05', -30, 'A', 'f1')];
  const r3 = importar([], comFitid, 'Nubank PF', regras, cats);
  assert.equal(importar(r3.novos, [t('2026-11-05', -30, 'A descrição mudou', 'f1')], 'Nubank PF', regras, cats).duplicados, 1);
});

test('reclassificar preenche só importados sem categoria, respeitando o sinal do ID', () => {
  const r = importar([], [t('2026-11-05', -30, 'Mercadinho SUPERMERCADO'), t('2026-11-05', 30, 'Estorno supermercado')], 'Nubank PF', [], cats);
  const manual = { data: '2026-11-01', conta: 'Dinheiro', categoria: '', descricao: 'supermercado', valor: 5, id: '' };
  const lancs = [...r.novos, manual];
  assert.equal(reclassificar(lancs, regras, cats), 1);
  assert.deepEqual(lancs.map((l) => l.categoria), ['PF - Mercado', '', '']);
});
