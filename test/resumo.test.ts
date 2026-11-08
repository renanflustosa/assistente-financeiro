import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avalanche, mesesParaQuitar, orcamento, painel, type Total } from '../src/resumo.ts';

const t = (escopo: 'PF' | 'PJ', tipo: 'Entrada' | 'Saída', motivo: string, categoria: string, total: number): Total => ({ escopo, tipo, motivo, categoria, total });
const mes: Total[] = [
  t('PJ', 'Entrada', 'Receita', 'PJ - Faturamento de clientes', 6000),
  t('PJ', 'Saída', 'Imposto', 'PJ - Impostos (DAS/Simples)', 360),
  t('PJ', 'Saída', 'Essencial', 'PJ - Infra e hospedagem', 140),
  t('PJ', 'Saída', 'Transferência', 'PJ - Pró-labore / lucros pagos', 4000),
  t('PF', 'Entrada', 'Receita', 'PF - Pró-labore / lucros recebidos', 4000),
  t('PF', 'Saída', 'Essencial', 'PF - Mercado', 900),
  t('PF', 'Saída', 'Escolha', 'PF - Lazer', 400),
  t('PF', 'Saída', 'Investimento', 'PF - Aporte em FII', 500),
  t('PF', 'Saída', 'Transferência', 'PF - Pagamento fatura cartão', 1300),
];

test('painel: transferências não contam como gasto nem como saída operacional', () => {
  const p = painel(mes);
  assert.deepEqual(p.pj, { entradas: 6000, saidasOperacionais: 500, impostos: 360, lucro: 5500, proLabore: 4000, ficaNoCaixa: 1500 });
  assert.equal(p.pf.gastos, 1300);
  assert.equal(p.pf.poupanca, 500);
  assert.equal(p.pf.sobra, 2200);
  assert.equal(p.pf.taxaPoupanca, 0.125);
  assert.equal(p.pf.pctEscolha, 0.1);
  assert.equal(painel([]).pf.taxaPoupanca, 0);
});

test('orcamento: junta planejado e realizado, marca o que estourou', () => {
  const o = orcamento(mes, [
    { categoria: 'PF - Mercado', motivo: 'Essencial', planejado: 800 },
    { categoria: 'PF - Saúde', motivo: 'Essencial', planejado: 200 },
  ]);
  assert.deepEqual(
    o.map((x) => [x.categoria, x.planejado, x.realizado, x.estourou]),
    [
      ['PF - Aporte em FII', 0, 500, false],
      ['PF - Lazer', 0, 400, false],
      ['PF - Mercado', 800, 900, true],
      ['PF - Saúde', 200, 0, false],
      ['PJ - Impostos (DAS/Simples)', 0, 360, false],
      ['PJ - Infra e hospedagem', 0, 140, false],
    ],
  );
});

test('avalanche: maior juros primeiro; meses para quitar como o NPER do Excel', () => {
  assert.equal(mesesParaQuitar(1000, 0, 300), 4);
  assert.equal(mesesParaQuitar(10000, 0.015, 500), 24); // NPER(1,5%; -500; 10000) = 23,9
  assert.equal(mesesParaQuitar(1000, 0.1, 100), 'parcela não cobre os juros');
  const a = avalanche([
    { credor: 'Financiamento', tipo: 'Financiamento', saldo: 10000, juros: 0.015, parcela: 500 },
    { credor: 'Quitada', tipo: 'Outro', saldo: 0, juros: 0.2, parcela: 100 },
    { credor: 'Cartão', tipo: 'Cartão (rotativo)', saldo: 3000, juros: 0.12, parcela: null },
  ]);
  assert.deepEqual(a.map((x) => [x.ordem, x.credor, x.meses]), [[1, 'Cartão', null], [2, 'Financiamento', 24]]);
  assert.equal(a[0]!.jurosMes, 360);
});
