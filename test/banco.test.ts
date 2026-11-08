import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conectar, contarIguais, criarEsquema, gravarCategorias, inserirLancamentos, inserirManual, lancamentosDaConta, lerCategorias, lerMes, semCategoria, sincronizarContas } from '../src/banco.ts';
import type { Transacao } from '../src/ofx.ts';
import { importar, reclassificar } from '../src/regras.ts';

/**
 * Integração com um MySQL de verdade. Usa um database descartável, apagado no fim:
 * TEST_MYSQL_URL=mysql://usuario:senha@127.0.0.1:3306/assistente_financeiro_teste node --test
 */
const url = process.env.TEST_MYSQL_URL;

test('MySQL: esquema, importação idempotente, reclassificação e resumo', { skip: url ? false : 'defina TEST_MYSQL_URL para rodar' }, async () => {
  const nome = new URL(url!).pathname.slice(1);
  assert.match(nome, /_teste$/, 'o database de teste precisa terminar em _teste (ele é apagado no fim)');
  const db = await criarEsquema(url!);
  try {
    await criarEsquema(url!).then((d) => d.end()); // idempotente
    await sincronizarContas(db, [
      { nome: 'Nubank PF', tipo: 'Conta' },
      { nome: 'Nubank PF Cartão', tipo: 'Cartão' },
    ]);
    await db.query("UPDATE contas SET saldo_inicial = 365.38, data_saldo = '2026-11-08' WHERE nome = 'Nubank PF'");
    await db.query("UPDATE contas SET limite = 650.01 WHERE nome = 'Nubank PF Cartão'");
    const categorias = await lerCategorias(db);
    const regras = [{ contem: 'IFOOD', categoria: 'PF - Restaurantes e delivery' }];
    const tr = (data: string, valor: number, descricao: string): Transacao => ({ data, valor, descricao });
    const extrato = [tr('2026-11-08', -10, 'Antes do saldo inicial'), tr('2026-11-09', -45.5, 'IFOOD *Pizza'), tr('2026-11-10', 1000, 'Pix recebido'), tr('2026-11-10', 1000, 'Pix recebido')];

    const r1 = importar(await lancamentosDaConta(db, 'Nubank PF', '2026-11-08', '2026-11-10'), extrato, 'Nubank PF', regras, categorias);
    await inserirLancamentos(db, r1.novos);
    const r2 = importar(await lancamentosDaConta(db, 'Nubank PF', '2026-11-08', '2026-11-10'), extrato, 'Nubank PF', regras, categorias);
    assert.equal(r2.novos.length, 0);
    assert.equal(r2.duplicados, 4);
    await assert.rejects(inserirLancamentos(db, r1.novos), /Duplicate/);

    const pendentes = await semCategoria(db);
    assert.equal(pendentes.length, 3);
    assert.equal(reclassificar(pendentes, [{ contem: 'Pix recebido', categoria: 'PF - Outras receitas' }], categorias), 2);
    await gravarCategorias(db, pendentes);
    assert.equal((await semCategoria(db)).length, 1);

    await db.query("UPDATE categorias SET planejado = 30 WHERE nome = 'PF - Restaurantes e delivery'");
    const m = await lerMes(db, '2026-11');
    assert.deepEqual(m.saldos, [{ conta: 'Nubank PF', dataSaldo: '2026-11-08', saldo: 2319.88 }]);
    assert.deepEqual(m.cartoes, [{ conta: 'Nubank PF Cartão', limite: 650.01, compras: 0 }]);
    assert.deepEqual(m.semCategoria, [{ sentido: 'Saída', quantos: 1, total: 10 }]);
    assert.deepEqual(m.orcamento, [{ categoria: 'PF - Restaurantes e delivery', motivo: 'Escolha', planejado: 30 }]);
    assert.equal(m.totais.find((x) => x.categoria === 'PF - Outras receitas')?.total, 2000);
    assert.equal(m.metaMeses, 6);

    // Lançamento manual: entra no saldo e é achado pela checagem de repetido.
    const manual = { data: '2026-11-11', conta: 'Nubank PF', categoria: 'PF - Mercado', descricao: 'Feira', valor: 80.1, id: '' };
    assert.equal(await contarIguais(db, manual), 0);
    await inserirManual(db, manual, 'Saída');
    assert.equal(await contarIguais(db, manual), 1);
    assert.equal((await lerMes(db, '2026-11')).saldos[0]!.saldo, 2239.78);
  } finally {
    await db.query(`DROP DATABASE \`${nome}\``);
    await db.end();
  }
});

test('MySQL: URL errada falha com mensagem que não expõe a senha', async () => {
  await assert.rejects(conectar('mysql://ninguem:segredo@127.0.0.1:1/x'), (e: Error) => !e.message.includes('segredo') && /Não conectou ao MySQL/.test(e.message));
});
