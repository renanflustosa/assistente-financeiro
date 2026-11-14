import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { readdirSync, readFileSync } from 'node:fs';
import { CATEGORIAS_PADRAO } from './categorias.ts';
import type { Carteira } from './fiis/aporte.ts';
import type { Categoria, Lancamento, Regra } from './regras.ts';
import type { Divida, Total } from './resumo.ts';

/**
 * Persistência em MySQL. O banco é a fonte dos dados (pessoas, contas, regras, carteira de FIIs,
 * lançamentos, orçamento, dívidas, patrimônio); edite direto por SQL o que o CLI não cobre.
 * Um database por família: todos que acessam veem tudo, e `pessoas` diz de quem é cada coisa.
 * O esquema está em migrations/ (um arquivo SQL por versão); `nova` aplica as que faltam sem apagar dados.
 */
export type Banco = Connection;

/** Lançamentos de uma pessoa: os das contas dos titulares dela. */
const DA_PESSOA = 'l.conta IN (SELECT ct.nome FROM contas ct JOIN titulares t ON t.apelido = ct.titular WHERE t.pessoa = ?)';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

/** Comandos de um arquivo de migration: sem as linhas de comentário, separados por `;` no fim da linha. */
function comandos(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Aplica, em ordem, os arquivos `migrations/NNN_nome.sql` que ainda não estão em `schema_migrations`.
 * DDL no MySQL não tem transação: se um comando falhar, os anteriores do arquivo ficam, e o comentário
 * no topo do arquivo diz como seguir.
 */
async function migrar(db: Banco): Promise<void> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (versao VARCHAR(100) PRIMARY KEY, aplicada_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const arquivos = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_\w+\.sql$/.test(f)).sort();
  const [linhas] = await db.query<RowDataPacket[]>('SELECT versao FROM schema_migrations');
  const feitas = new Set(linhas.map((l) => l.versao as string));
  if (feitas.size === 0 && (await existeTabela(db, 'lancamentos'))) {
    // Banco criado antes das migrations: está na 001, ou já na 002 se tiver a tabela pessoas.
    const base = arquivos.slice(0, (await existeTabela(db, 'pessoas')) ? 2 : 1).map((f) => f.slice(0, -4));
    await db.query('INSERT INTO schema_migrations (versao) VALUES ?', [base.map((v) => [v])]);
    for (const v of base) feitas.add(v);
  }
  for (const arquivo of arquivos) {
    const versao = arquivo.slice(0, -4);
    if (feitas.has(versao)) continue;
    for (const sql of comandos(readFileSync(new URL(arquivo, MIGRATIONS), 'utf8'))) {
      try {
        await db.query(sql);
      } catch (e) {
        throw new Error(`A migration migrations/${arquivo} falhou: ${(e as Error).message}. Veja o comentário no topo do arquivo e rode nova de novo.`);
      }
    }
    await db.query('INSERT INTO schema_migrations (versao) VALUES (?)', [versao]);
  }
}

function opcoes(url: string): mysql.ConnectionOptions {
  return { uri: url, charset: 'utf8mb4', decimalNumbers: true, dateStrings: true, timezone: 'Z' };
}

export async function conectar(url: string): Promise<Banco> {
  try {
    return await mysql.createConnection(opcoes(url));
  } catch (e) {
    throw new Error(`Não conectou ao MySQL (${new URL(url).host}): ${(e as Error).message}. Confira "mysql" no config.json e se o servidor está no ar; o banco é criado com: node src/main.ts nova`);
  }
}

/** Cria o database (se faltar), aplica as migrations que faltam e as categorias padrão. Não apaga dados. */
export async function criarEsquema(url: string): Promise<Banco> {
  const u = new URL(url);
  const nome = decodeURIComponent(u.pathname.slice(1));
  if (!/^\w+$/.test(nome)) throw new Error(`Nome do database inválido na URL do MySQL: "${nome}" (use letras, números e _).`);
  u.pathname = '/';
  const servidor = await conectar(u.toString());
  try {
    await servidor.query(`CREATE DATABASE IF NOT EXISTS \`${nome}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await servidor.end();
  }
  const db = await conectar(url);
  try {
    await migrar(db);
    await db.query('INSERT IGNORE INTO categorias (nome, escopo, tipo, motivo) VALUES ?', [CATEGORIAS_PADRAO.map((c) => [c.nome, c.escopo, c.tipo, c.motivo])]);
    return db;
  } catch (e) {
    // Conexão aberta segura o processo vivo: fecha antes de propagar o erro.
    await db.end();
    throw e;
  }
}

export type Conta = { nome: string; tipo: 'Conta' | 'Cartão'; perfil: string | null; perfilCsv: unknown };

export async function lerContas(db: Banco): Promise<Conta[]> {
  const [linhas] = await db.query<RowDataPacket[]>('SELECT nome, tipo, perfil, perfil_csv AS perfilCsv FROM contas ORDER BY nome');
  return linhas as Conta[];
}

export async function lerPessoas(db: Banco): Promise<string[]> {
  const [linhas] = await db.query<RowDataPacket[]>('SELECT apelido FROM pessoas ORDER BY apelido');
  return linhas.map((p) => p.apelido as string);
}

/** Na ordem em que são testadas. Cada linha tem um trecho; categoria e conta já passaram pela chave estrangeira. */
export async function lerRegras(db: Banco): Promise<Regra[]> {
  const [linhas] = await db.query<RowDataPacket[]>('SELECT contem, conta, categoria, ignorar FROM regras ORDER BY ordem, id');
  return linhas.map((r) => ({ contem: r.contem, ...(r.categoria ? { categoria: r.categoria } : {}), ...(r.conta ? { conta: r.conta } : {}), ...(r.ignorar ? { ignorar: true } : {}) }));
}

/** Uma linha por trecho, todos com a ordem da regra; entram no fim da lista, depois das que já existem. */
export async function inserirRegras(db: Banco, regras: Regra[]): Promise<void> {
  if (regras.length === 0) return;
  const [[r]] = await db.query<RowDataPacket[]>('SELECT COALESCE(MAX(ordem), 0) AS ultima FROM regras');
  const linhas = regras.flatMap((g, i) => (Array.isArray(g.contem) ? g.contem : [g.contem]).map((t) => [(r!.ultima as number) + (i + 1) * 10, t, g.conta ?? null, g.categoria ?? null, g.ignorar === true]));
  await db.query('INSERT INTO regras (ordem, contem, conta, categoria, ignorar) VALUES ?', [linhas]);
}

export async function lerCarteira(db: Banco, pessoa: string): Promise<Carteira> {
  const [[p]] = await db.query<RowDataPacket[]>('SELECT aporte_fii AS aporte, dy_minimo AS dyMinimo, meses_minimos AS mesesMinimos, renda_alvo AS rendaAlvo FROM pessoas WHERE apelido = ?', [pessoa]);
  if (!p) throw new Error(`Pessoa "${pessoa}" não existe na tabela pessoas.`);
  const [fiis] = await db.query<RowDataPacket[]>('SELECT ticker, peso, cotas FROM fiis WHERE pessoa = ? ORDER BY ticker', [pessoa]);
  return { aporte: p.aporte, dyMinimo: p.dyMinimo, mesesMinimos: p.mesesMinimos, ...(p.rendaAlvo === null ? {} : { rendaAlvo: p.rendaAlvo }), fiis: fiis as Carteira['fiis'] };
}

// ---------------------------------------------------------------- importação única dos JSON antigos

/** Até 2026-11 as contas ficavam no config.json. Completa o perfil sem sobrescrever o que já está no banco. */
export async function importarContas(db: Banco, contas: (Omit<Conta, 'perfilCsv'> & { perfilCsv: object | null })[]): Promise<void> {
  if (contas.length === 0) return;
  await db.query(
    'INSERT INTO contas (nome, tipo, perfil, perfil_csv) VALUES ? AS n ON DUPLICATE KEY UPDATE perfil = COALESCE(contas.perfil, n.perfil), perfil_csv = COALESCE(contas.perfil_csv, n.perfil_csv)',
    [contas.map((c) => [c.nome, c.tipo, c.perfil, c.perfilCsv === null ? null : JSON.stringify(c.perfilCsv)])],
  );
}

/** Só com a tabela vazia, para não duplicar regras a cada `nova`. Devolve se importou. */
export async function importarRegras(db: Banco, regras: Regra[]): Promise<boolean> {
  const [[r]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM regras');
  if (r!.n > 0 || regras.length === 0) return false;
  await inserirRegras(db, regras);
  return true;
}

/** Só se a pessoa ainda não tem FIIs no banco. Devolve se importou. */
export async function importarCarteira(db: Banco, pessoa: string, c: Carteira): Promise<boolean> {
  const [[r]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM fiis WHERE pessoa = ?', [pessoa]);
  if (r!.n > 0) return false;
  await db.beginTransaction();
  try {
    await db.execute('UPDATE pessoas SET aporte_fii = ?, dy_minimo = ?, meses_minimos = ?, renda_alvo = ? WHERE apelido = ?', [c.aporte, c.dyMinimo, c.mesesMinimos, c.rendaAlvo ?? null, pessoa]);
    await db.query('INSERT INTO fiis (pessoa, ticker, peso, cotas) VALUES ?', [c.fiis.map((f) => [pessoa, f.ticker, f.peso, f.cotas])]);
    await db.commit();
    return true;
  } catch (e) {
    await db.rollback();
    throw e;
  }
}

export async function existeTabela(db: Banco, nome: string): Promise<boolean> {
  const [t] = await db.query<RowDataPacket[]>('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [nome]);
  return t.length > 0;
}

/** A antiga tabela `parametros` (uma linha, sem dono) vai para a pessoa e some. Devolve se havia. */
export async function importarParametros(db: Banco, pessoa: string): Promise<boolean> {
  if (!(await existeTabela(db, 'parametros'))) return false;
  await db.execute('UPDATE pessoas p JOIN parametros x ON x.id = 1 SET p.custo_vida = x.custo_vida, p.meta_meses = x.meta_meses WHERE p.apelido = ?', [pessoa]);
  await db.query('DROP TABLE parametros');
  return true;
}

export async function lerCategorias(db: Banco): Promise<Categoria[]> {
  const [linhas] = await db.query<RowDataPacket[]>('SELECT nome, escopo, tipo, motivo FROM categorias ORDER BY nome');
  if (linhas.length === 0) throw new Error('A tabela categorias está vazia. Rode: node src/main.ts nova');
  return linhas as Categoria[];
}

type LinhaLancamento = RowDataPacket & { data: string; conta: string; categoria: string | null; descricao: string; valor: number; id_transacao: string | null };
const paraLancamento = (l: LinhaLancamento): Lancamento => ({ data: l.data, conta: l.conta, categoria: l.categoria ?? '', descricao: l.descricao, valor: l.valor, id: l.id_transacao ?? '' });
const COLUNAS = 'data, conta, categoria, descricao, valor, id_transacao';

/** Lançamentos da conta no período: base da deduplicação, já que o ID de cada transação inclui a data. */
export async function lancamentosDaConta(db: Banco, conta: string, de: string, ate: string): Promise<Lancamento[]> {
  const [linhas] = await db.query<LinhaLancamento[]>(`SELECT ${COLUNAS} FROM lancamentos WHERE conta = ? AND data BETWEEN ? AND ?`, [conta, de, ate]);
  return linhas.map(paraLancamento);
}

export async function semCategoria(db: Banco): Promise<Lancamento[]> {
  const [linhas] = await db.query<LinhaLancamento[]>(`SELECT ${COLUNAS} FROM lancamentos WHERE categoria IS NULL ORDER BY data`);
  return linhas.map(paraLancamento);
}

/** Importados vêm com ID "E-..." ou "S-...", que carrega o sinal original da transação. */
function sentidoDe(l: Lancamento): 'Entrada' | 'Saída' {
  if (l.id.startsWith('E-')) return 'Entrada';
  if (l.id.startsWith('S-')) return 'Saída';
  throw new Error(`Lançamento sem ID de extrato: ${l.data} ${l.descricao}`);
}

export async function inserirLancamentos(db: Banco, novos: Lancamento[]): Promise<void> {
  if (novos.length === 0) return;
  const linhas = novos.map((l) => [l.data, l.conta, l.categoria || null, l.descricao, l.valor, sentidoDe(l), l.id]);
  await db.query('INSERT INTO lancamentos (data, conta, categoria, descricao, valor, sentido, id_transacao) VALUES ?', [linhas]);
}

/** Lançamento digitado (sem extrato): `id_transacao` fica NULL, então não há deduplicação automática. */
export async function inserirManual(db: Banco, l: Lancamento, sentido: 'Entrada' | 'Saída'): Promise<void> {
  await db.execute('INSERT INTO lancamentos (data, conta, categoria, descricao, valor, sentido) VALUES (?, ?, ?, ?, ?, ?)', [l.data, l.conta, l.categoria || null, l.descricao, l.valor, sentido]);
}

/** Quantos lançamentos já têm a mesma data, conta, valor e descrição (mensagem mandada duas vezes). */
export async function contarIguais(db: Banco, l: Lancamento): Promise<number> {
  const [[r]] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM lancamentos WHERE data = ? AND conta = ? AND valor = ? AND descricao = ?', [l.data, l.conta, l.valor, l.descricao]);
  return (r?.n as number) ?? 0;
}

/** Grava a categoria dos importados que estavam em branco (o ID do extrato identifica a linha). */
export async function gravarCategorias(db: Banco, lancamentos: Lancamento[]): Promise<void> {
  const classificados = lancamentos.filter((l) => l.categoria !== '' && l.id !== '');
  if (classificados.length === 0) return;
  await db.beginTransaction();
  try {
    for (const l of classificados) await db.execute('UPDATE lancamentos SET categoria = ? WHERE id_transacao = ? AND categoria IS NULL', [l.categoria, l.id]);
    await db.commit();
  } catch (e) {
    await db.rollback();
    throw e;
  }
}

// ---------------------------------------------------------------- resumo do mês

export type DadosMes = {
  totais: Total[];
  orcamento: { categoria: string; motivo: string; planejado: number }[];
  semCategoria: { sentido: 'Entrada' | 'Saída'; quantos: number; total: number }[];
  saldos: { conta: string; dataSaldo: string; saldo: number }[];
  cartoes: { conta: string; limiteTotal: number | null; limiteDisponivel: number | null; compras: number }[];
  dividas: Divida[];
  /** Soma de custo_vida × meta_meses das pessoas consideradas. */
  metaReserva: number;
  /** Último fechamento de cada pessoa até o mês, somado; `mes` é o mais antigo deles. */
  reserva?: { mes: string; valor: number };
};

/** `mes` em AAAA-MM. Sem `pessoa`, é a visão da família: soma todas as pessoas. */
export async function lerMes(db: Banco, mes: string, pessoa?: string): Promise<DadosMes> {
  const de = `${mes}-01`;
  const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<RowDataPacket[]>(sql, params))[0] as T[];
  const noMes = 'l.data >= ? AND l.data < DATE_ADD(?, INTERVAL 1 MONTH)';
  // O gasto no cartão é a fatura paga pela conta: compras lançadas no cartão ficam fora dos totais, senão contariam duas vezes.
  const daConta = " AND l.conta IN (SELECT nome FROM contas WHERE tipo = 'Conta')";
  // Filtro opcional: o mesmo trecho de SQL e o parâmetro que ele pede, vazios na visão da família.
  const so = (sql: string): [string, unknown[]] => (pessoa === undefined ? ['', []] : [` AND ${sql}`, [pessoa]]);
  const [lanc, pLanc] = so(DA_PESSOA);
  const [dono, pDono] = so('pessoa = ?');
  const [metas] = await q<{ meta: number }>(`SELECT COALESCE(SUM(custo_vida * meta_meses), 0) AS meta FROM pessoas WHERE TRUE${so('apelido = ?')[0]}`, pDono);
  const reservas = await q<{ mes: string; reserva: number }>(
    `SELECT p.mes, p.reserva FROM patrimonio p
     WHERE p.mes = (SELECT MAX(x.mes) FROM patrimonio x WHERE x.pessoa = p.pessoa AND x.mes <= ? AND x.reserva IS NOT NULL)${so('p.pessoa = ?')[0]}`,
    [de, ...pDono],
  );
  return {
    totais: await q<Total>(
      `SELECT c.escopo, c.tipo, c.motivo, c.nome AS categoria, SUM(l.valor) AS total
       FROM lancamentos l JOIN categorias c ON c.nome = l.categoria WHERE ${noMes}${daConta}${lanc} GROUP BY c.nome, c.escopo, c.tipo, c.motivo`,
      [de, de, ...pLanc],
    ),
    orcamento: await q('SELECT nome AS categoria, motivo, planejado FROM categorias WHERE planejado > 0 ORDER BY nome'),
    semCategoria: await q(`SELECT l.sentido, COUNT(*) AS quantos, SUM(l.valor) AS total FROM lancamentos l WHERE l.categoria IS NULL AND ${noMes}${daConta}${lanc} GROUP BY l.sentido`, [de, de, ...pLanc]),
    saldos: await q(`SELECT conta, data_saldo AS dataSaldo, saldo_atual AS saldo FROM vw_saldos WHERE TRUE${dono} ORDER BY conta`, pDono),
    cartoes: await q(
      `SELECT v.conta, v.limite_total AS limiteTotal, v.limite_disponivel AS limiteDisponivel, COALESCE(SUM(CASE l.sentido WHEN 'Saída' THEN l.valor ELSE -l.valor END), 0) AS compras
       FROM vw_cartoes v LEFT JOIN lancamentos l ON l.conta = v.conta AND ${noMes} WHERE TRUE${so('v.pessoa = ?')[0]}
       GROUP BY v.conta, v.limite_total, v.limite_disponivel ORDER BY v.conta`,
      [de, de, ...pDono],
    ),
    dividas: await q(`SELECT credor, tipo, saldo, juros_mes AS juros, parcela FROM dividas WHERE saldo > 0${dono}`, pDono),
    metaReserva: metas?.meta ?? 0,
    ...(reservas.length > 0 ? { reserva: { mes: reservas.map((r) => r.mes).sort()[0]!, valor: Math.round(reservas.reduce((s, r) => s + r.reserva, 0) * 100) / 100 } } : {}),
  };
}
