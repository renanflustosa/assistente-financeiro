import mysql, { type RowDataPacket } from 'mysql2/promise';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { conectar, contarIguais, criarEsquema, existeTabela, gravarCategorias, importarCarteira, importarParametros, importarRegras, inserirLancamentos, inserirManual, lancamentosDaConta, lerCarteira, lerCategorias, lerContas, lerMes, lerRegras, semCategoria } from '../src/banco.ts';
import { MOTIVOS, TIPOS_DIVIDA } from '../src/categorias.ts';
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
    const [versoes] = await db.query<RowDataPacket[]>('SELECT versao FROM schema_migrations ORDER BY versao');
    assert.deepEqual(versoes.map((v) => v.versao), ['001_inicial', '002_familia', '003_fatura_cartao']);
    // Os ENUM das migrations são os mesmos do código; parametros com valores padrão some na 002.
    const enumDe = async (tabela: string, coluna: string) => ((await db.query<RowDataPacket[]>('SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tabela, coluna]))[0][0]!.t);
    assert.equal(await enumDe('categorias', 'motivo'), `enum(${MOTIVOS.map((m) => mysql.escape(m)).join(',')})`);
    assert.equal(await enumDe('dividas', 'tipo'), `enum(${TIPOS_DIVIDA.map((m) => mysql.escape(m)).join(',')})`);
    assert.equal(await existeTabela(db, 'parametros'), false);
    // Família com duas pessoas; cada conta é de um titular, e o titular é de uma pessoa.
    await db.query("INSERT INTO pessoas (apelido, nome, custo_vida, meta_meses) VALUES ('Eu', 'Eu', 1000, 6), ('Irmão', 'Irmão', 500, 3)");
    await db.query("INSERT INTO titulares (apelido, escopo, nome, pessoa) VALUES ('Eu', 'PF', 'Eu', 'Eu'), ('Irmão', 'PF', 'Irmão', 'Irmão')");
    await db.query(`INSERT INTO contas (nome, tipo, titular, perfil, saldo_inicial, data_saldo, limite_total) VALUES
      ('Nubank PF', 'Conta', 'Eu', 'nubank-conta', 365.38, '2026-11-08', NULL),
      ('Nubank PF Cartão', 'Cartão', 'Eu', 'nubank-cartao', NULL, NULL, 650.01),
      ('Irmão PF', 'Conta', 'Irmão', NULL, 50, '2026-11-01', NULL)`);
    assert.deepEqual((await lerContas(db)).map((c) => [c.nome, c.tipo, c.perfil]), [['Irmão PF', 'Conta', null], ['Nubank PF', 'Conta', 'nubank-conta'], ['Nubank PF Cartão', 'Cartão', 'nubank-cartao']]);
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
    await inserirManual(db, { data: '2026-11-15', conta: 'Irmão PF', categoria: 'PF - Outras receitas', descricao: 'Salário', valor: 300, id: '' }, 'Entrada');
    await db.query("INSERT INTO patrimonio (pessoa, mes, reserva) VALUES ('Eu', '2026-10-01', 100), ('Eu', '2026-11-01', 200), ('Irmão', '2026-10-01', 40)");
    const m = await lerMes(db, '2026-11');
    assert.deepEqual(m.saldos, [{ conta: 'Irmão PF', dataSaldo: '2026-11-01', saldo: 350 }, { conta: 'Nubank PF', dataSaldo: '2026-11-08', saldo: 2319.88 }]);
    assert.deepEqual(m.cartoes, [{ conta: 'Nubank PF Cartão', limiteTotal: 650.01, limiteDisponivel: 650.01, compras: 0 }]);
    assert.deepEqual(m.semCategoria, [{ sentido: 'Saída', quantos: 1, total: 10 }]);
    assert.deepEqual(m.orcamento, [{ categoria: 'PF - Restaurantes e delivery', motivo: 'Escolha', planejado: 30 }]);
    assert.equal(m.totais.find((x) => x.categoria === 'PF - Outras receitas')?.total, 2300);
    assert.equal(m.metaReserva, 7500);
    assert.deepEqual(m.reserva, { mes: '2026-10-01', valor: 240 });

    // Visão de uma pessoa: só as contas dos titulares dela.
    const eu = await lerMes(db, '2026-11', 'Eu');
    assert.equal(eu.totais.find((x) => x.categoria === 'PF - Outras receitas')?.total, 2000);
    assert.deepEqual(eu.saldos.map((s) => s.conta), ['Nubank PF']);
    assert.equal(eu.metaReserva, 6000);
    assert.deepEqual(eu.reserva, { mes: '2026-11-01', valor: 200 });
    const irmao = await lerMes(db, '2026-11', 'Irmão');
    assert.deepEqual([irmao.cartoes, irmao.semCategoria, irmao.totais.map((t) => t.total)], [[], [], [300]]);

    // Regras e carteira no banco: uma linha por trecho, na ordem; a importação não duplica.
    assert.equal(await importarRegras(db, [{ contem: ['IFOOD', 'RAPPI'], categoria: 'PF - Restaurantes e delivery' }, { contem: 'Pagamento recebido', ignorar: true }, { contem: 'Pix', conta: 'Nubank PF', categoria: 'PF - Outras receitas' }]), true);
    assert.equal(await importarRegras(db, [{ contem: 'X', ignorar: true }]), false);
    assert.deepEqual(await lerRegras(db), [
      { contem: 'IFOOD', categoria: 'PF - Restaurantes e delivery' },
      { contem: 'RAPPI', categoria: 'PF - Restaurantes e delivery' },
      { contem: 'Pagamento recebido', ignorar: true },
      { contem: 'Pix', categoria: 'PF - Outras receitas', conta: 'Nubank PF' },
    ]);
    const carteira = { aporte: 20, dyMinimo: 0.1, mesesMinimos: 11, rendaAlvo: 5000, fiis: [{ ticker: 'MXRF11', peso: 1, cotas: 0 }, { ticker: 'VGHF11', peso: 0, cotas: 1 }] };
    assert.equal(await importarCarteira(db, 'Eu', carteira), true);
    assert.equal(await importarCarteira(db, 'Eu', carteira), false);
    assert.deepEqual(await lerCarteira(db, 'Eu'), carteira);
    assert.deepEqual((await lerCarteira(db, 'Irmão')).fiis, []);

    // Lançamento manual: entra no saldo e é achado pela checagem de repetido.
    const manual = { data: '2026-11-11', conta: 'Nubank PF', categoria: 'PF - Mercado', descricao: 'Feira', valor: 80.1, id: '' };
    assert.equal(await contarIguais(db, manual), 0);
    await inserirManual(db, manual, 'Saída');
    assert.equal(await contarIguais(db, manual), 1);
    assert.equal((await lerMes(db, '2026-11', 'Eu')).saldos[0]!.saldo, 2239.78);

    // Limite disponível: parcela futura já ocupa o limite; fatura paga pela conta o libera.
    // No resumo, o gasto é só a fatura: a compra no cartão fica fora dos totais.
    const compra = (data: string, valor: number) => ({ data, conta: 'Nubank PF Cartão', categoria: 'PF - Assinaturas', descricao: `Curso ${data}`, valor, id: '' });
    await inserirManual(db, compra('2026-11-12', 100), 'Saída');
    await inserirManual(db, compra('2026-12-12', 100), 'Saída');
    await inserirManual(db, { data: '2026-11-20', conta: 'Nubank PF', categoria: 'PF - Pagamento fatura cartão', descricao: 'Pagamento de fatura', valor: 100, id: '' }, 'Saída');
    const comFatura = await lerMes(db, '2026-11');
    assert.deepEqual(comFatura.cartoes, [{ conta: 'Nubank PF Cartão', limiteTotal: 650.01, limiteDisponivel: 550.01, compras: 100 }]);
    assert.deepEqual(comFatura.totais.filter((x) => x.motivo === 'Cartão' || x.categoria === 'PF - Assinaturas').map((x) => [x.categoria, x.total]), [['PF - Pagamento fatura cartão', 100]]);
  } finally {
    await db.query(`DROP DATABASE \`${nome}\``);
    await db.end();
  }
});

test('MySQL: banco de antes das migrations é reconhecido e atualizado', { skip: url ? false : 'defina TEST_MYSQL_URL para rodar' }, async () => {
  const u = new URL(url!);
  u.pathname = u.pathname.replace(/_teste$/, '_legado_teste');
  const nome = u.pathname.slice(1);
  const servidor = await mysql.createConnection({ uri: new URL('/', u).href });
  await servidor.query(`CREATE DATABASE \`${nome}\``);
  await servidor.end();
  // Como a versão anterior deixava o banco: o esquema da 001, sem schema_migrations.
  const antigo = await mysql.createConnection({ uri: u.href, multipleStatements: true, charset: 'utf8mb4' });
  try {
    await antigo.query(readFileSync(new URL('../migrations/001_inicial.sql', import.meta.url), 'utf8'));
    await antigo.query("UPDATE parametros SET custo_vida = 3000; INSERT INTO patrimonio (mes, reserva) VALUES ('2026-10-01', 100)");
    // Fechamento sem dono: a 002 para no primeiro comando, sem mudar mais nada.
    await assert.rejects(criarEsquema(u.href), /migrations\/002_familia\.sql falhou/);
    const [[c]] = await antigo.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contas' AND COLUMN_NAME = 'limite'");
    assert.equal(c!.n, 1);
    await antigo.query('DELETE FROM patrimonio');
    const db = await criarEsquema(u.href);
    try {
      const [versoes] = await db.query<RowDataPacket[]>('SELECT versao FROM schema_migrations ORDER BY versao');
      assert.deepEqual(versoes.map((v) => v.versao), ['001_inicial', '002_familia', '003_fatura_cartao']);
      assert.deepEqual((await lerContas(db)), []);
      assert.equal(await existeTabela(db, 'parametros'), true, 'parametros com valores próprios fica para o nova copiar para a pessoa');
      await db.query("INSERT INTO pessoas (apelido, nome) VALUES ('Eu', 'Eu')");
      assert.equal(await importarParametros(db, 'Eu'), true);
      const [[p]] = await db.query<RowDataPacket[]>("SELECT custo_vida FROM pessoas WHERE apelido = 'Eu'");
      assert.equal(p!.custo_vida, 3000);
    } finally {
      await db.end();
    }
  } finally {
    await antigo.query(`DROP DATABASE \`${nome}\``);
    await antigo.end();
  }
});

test('MySQL: URL errada falha com mensagem que não expõe a senha', async () => {
  await assert.rejects(conectar('mysql://ninguem:segredo@127.0.0.1:1/x'), (e: Error) => !e.message.includes('segredo') && /Não conectou ao MySQL/.test(e.message));
});
