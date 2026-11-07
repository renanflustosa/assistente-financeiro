import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analisar, rendaMensal, sugerirAporte, type Analise, type Fii } from '../src/fiis/carteira.ts';

const agora = new Date('2026-10-24T12:00:00Z');
const regras = { dyMinimo: 0.1, mesesMinimos: 11 };

/** Provento fixo pago todo dia 5 nos `meses` meses anteriores a `agora`. */
function mensais(valor: number, meses = 12) {
  return Array.from({ length: meses }, (_, i) => ({ data: new Date(Date.UTC(2026, 9 - i, 5)), valor }));
}

function fii(parcial: Partial<Fii> & Pick<Fii, 'ticker' | 'preco'>): Fii {
  return { peso: 1, cotas: 0, proventos: mensais(0.1), ...parcial };
}

test('analisar calcula proventos, DY, teto e número mágico', () => {
  const a = analisar(fii({ ticker: 'AAAA11', preco: 10 }), regras, agora);
  assert.equal(a.mesesPagos, 12);
  assert.ok(Math.abs(a.proventos12m - 1.2) < 1e-9);
  assert.ok(Math.abs(a.dy - 0.12) < 1e-9);
  assert.ok(Math.abs(a.precoTeto - 12) < 1e-9);
  assert.equal(a.numeroMagico, 100);
  assert.equal(a.bloqueio, undefined);
});

test('analisar ignora proventos com mais de 12 meses', () => {
  const antigos = [{ data: new Date('2025-09-05T00:00:00Z'), valor: 5 }];
  const a = analisar(fii({ ticker: 'AAAA11', preco: 10, proventos: [...mensais(0.1), ...antigos] }), regras, agora);
  assert.ok(Math.abs(a.proventos12m - 1.2) < 1e-9);
});

test('analisar bloqueia FII acima do teto ou que falhou pagamentos', () => {
  assert.equal(analisar(fii({ ticker: 'CARO11', preco: 13 }), regras, agora).bloqueio, 'acima do preço teto');
  const irregular = analisar(fii({ ticker: 'IRRE11', preco: 5, proventos: mensais(0.1, 6) }), regras, agora);
  assert.equal(irregular.bloqueio, 'pagou em 6 dos últimos 12 meses');
});

const analisados = (...fiis: Fii[]): Analise[] => fiis.map((f) => analisar(f, regras, agora));

test('sugerirAporte compra o FII mais abaixo da meta, só cotas inteiras', () => {
  const { fiis, sobra } = sugerirAporte(
    analisados(fii({ ticker: 'CHEI11', preco: 10, cotas: 100 }), fii({ ticker: 'VAZI11', preco: 10 })),
    105,
  );
  assert.deepEqual(fiis.map((f) => f.comprar), [0, 10]);
  assert.equal(sobra, 5);
});

test('sugerirAporte respeita os pesos ao dividir o aporte', () => {
  const { fiis } = sugerirAporte(
    analisados(fii({ ticker: 'DOIS11', preco: 10, peso: 2 }), fii({ ticker: 'UMUM11', preco: 10, peso: 1 })),
    300,
  );
  assert.deepEqual(fiis.map((f) => f.comprar), [20, 10]);
});

test('sugerirAporte não compra FII bloqueado e investe o resto nos elegíveis', () => {
  const { fiis, sobra } = sugerirAporte(
    analisados(fii({ ticker: 'CARO11', preco: 13 }), fii({ ticker: 'BARA11', preco: 10, cotas: 50 })),
    100,
  );
  assert.deepEqual(fiis.map((f) => f.comprar), [0, 10]);
  assert.equal(sobra, 0);
});

test('sugerirAporte com aporte menor que qualquer cota não compra nada', () => {
  const { fiis, sobra } = sugerirAporte(analisados(fii({ ticker: 'AAAA11', preco: 10 })), 9.99);
  assert.equal(fiis[0]?.comprar, 0);
  assert.equal(sobra, 9.99);
});

test('rendaMensal soma o provento médio mensal antes e depois das compras', () => {
  const { fiis } = sugerirAporte(analisados(fii({ ticker: 'AAAA11', preco: 10, cotas: 10 })), 100);
  assert.ok(Math.abs(rendaMensal(fiis, false) - 1) < 1e-9);
  assert.ok(Math.abs(rendaMensal(fiis, true) - 2) < 1e-9);
});
