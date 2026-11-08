import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { CATEGORIAS_PADRAO, MOTIVOS, TIPOS_DIVIDA } from './categorias.ts';
import type { Categoria, Lancamento } from './regras.ts';
import type { Divida, Total } from './resumo.ts';

/**
 * Persistência em MySQL. O banco é a fonte dos dados (categorias, contas, lançamentos, orçamento,
 * dívidas, patrimônio); edite direto por SQL o que o CLI não cobre. O esquema é idempotente:
 * `nova` cria o que falta sem apagar nada.
 */
export type Banco = Connection;

const lista = (xs: string[]) => xs.map((x) => mysql.escape(x)).join(',');

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS parametros (
    id TINYINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    custo_vida DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Custo de vida mensal PF, base da meta de reserva',
    meta_meses TINYINT UNSIGNED NOT NULL DEFAULT 6 COMMENT 'Meta de reserva em meses de custo de vida'
  )`,
  `INSERT IGNORE INTO parametros (id) VALUES (1)`,
  `CREATE TABLE IF NOT EXISTS titulares (
    apelido VARCHAR(60) PRIMARY KEY,
    escopo ENUM('PF','PJ') NOT NULL,
    nome VARCHAR(150) NOT NULL COMMENT 'Nome completo ou razão social',
    documento VARCHAR(14) NULL COMMENT 'CPF ou CNPJ, só dígitos'
  )`,
  `CREATE TABLE IF NOT EXISTS contas (
    nome VARCHAR(60) PRIMARY KEY COMMENT 'O mesmo nome do config.json',
    titular VARCHAR(60) NULL,
    banco VARCHAR(60) NULL,
    tipo ENUM('Conta','Cartão') NOT NULL DEFAULT 'Conta',
    saldo_inicial DECIMAL(12,2) NULL COMMENT 'Conta: saldo no fim do dia data_saldo; vw_saldos soma os lançamentos posteriores',
    data_saldo DATE NULL,
    limite DECIMAL(12,2) NULL COMMENT 'Cartão: limite total',
    FOREIGN KEY (titular) REFERENCES titulares (apelido) ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cartoes (
    conta VARCHAR(60) NOT NULL,
    final CHAR(4) NOT NULL COMMENT 'Últimos 4 dígitos',
    nome VARCHAR(60) NOT NULL COMMENT 'Ex.: Físico, ou o apelido do cartão virtual',
    tipo ENUM('Físico','Virtual') NOT NULL DEFAULT 'Físico',
    variante VARCHAR(40) NULL COMMENT 'Ex.: Gold, Micro Business',
    PRIMARY KEY (conta, final),
    FOREIGN KEY (conta) REFERENCES contas (nome) ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS categorias (
    nome VARCHAR(80) PRIMARY KEY,
    escopo ENUM('PF','PJ') NOT NULL,
    tipo ENUM('Entrada','Saída') NOT NULL,
    motivo ENUM(${lista(MOTIVOS)}) NOT NULL,
    planejado DECIMAL(12,2) NULL COMMENT 'Orçamento mensal (categorias de Saída)'
  )`,
  `CREATE TABLE IF NOT EXISTS lancamentos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    data DATE NOT NULL,
    conta VARCHAR(60) NOT NULL,
    categoria VARCHAR(80) NULL COMMENT 'NULL = falta classificar',
    descricao VARCHAR(500) NOT NULL,
    valor DECIMAL(12,2) NOT NULL CHECK (valor > 0) COMMENT 'Sempre positivo; o sentido diz se entrou ou saiu',
    sentido ENUM('Entrada','Saída') NOT NULL,
    id_transacao VARCHAR(20) NULL UNIQUE COMMENT 'E-/S-<hash> do extrato, evita importar duas vezes; NULL em lançamento manual',
    INDEX (conta, data),
    INDEX (data),
    FOREIGN KEY (conta) REFERENCES contas (nome) ON UPDATE CASCADE,
    FOREIGN KEY (categoria) REFERENCES categorias (nome) ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS dividas (
    credor VARCHAR(80) PRIMARY KEY,
    tipo ENUM(${lista(TIPOS_DIVIDA)}) NOT NULL,
    saldo DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Atualize no fechamento de cada mês',
    juros_mes DECIMAL(7,4) NULL COMMENT 'Taxa mensal em fração: 12% a.m. = 0.12 (CET do contrato ou da fatura)',
    parcela DECIMAL(12,2) NULL
  )`,
  `CREATE TABLE IF NOT EXISTS patrimonio (
    mes DATE PRIMARY KEY COMMENT 'Dia 1 do mês do fechamento',
    contas_pf DECIMAL(12,2) NULL,
    contas_pj DECIMAL(12,2) NULL,
    reserva DECIMAL(12,2) NULL,
    fiis DECIMAL(12,2) NULL COMMENT 'Valor de mercado',
    outros DECIMAL(12,2) NULL,
    dividas DECIMAL(12,2) NULL
  )`,
  `CREATE OR REPLACE VIEW vw_lancamentos AS
    SELECT l.id, l.data, DATE_FORMAT(l.data, '%Y-%m') AS mes, l.conta, l.categoria, c.escopo, c.motivo, l.sentido, l.valor, l.descricao, l.id_transacao
    FROM lancamentos l LEFT JOIN categorias c ON c.nome = l.categoria`,
  `CREATE OR REPLACE VIEW vw_saldos AS
    SELECT ct.nome AS conta, ct.titular, ct.data_saldo, ct.saldo_inicial,
      ct.saldo_inicial + COALESCE(SUM(CASE l.sentido WHEN 'Entrada' THEN l.valor ELSE -l.valor END), 0) AS saldo_atual
    FROM contas ct LEFT JOIN lancamentos l ON l.conta = ct.nome AND l.data > ct.data_saldo
    WHERE ct.tipo = 'Conta' AND ct.saldo_inicial IS NOT NULL
    GROUP BY ct.nome, ct.titular, ct.data_saldo, ct.saldo_inicial`,
];

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

/** Cria o database (se faltar), as tabelas e as categorias padrão. Não altera o que já existe. */
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
    for (const sql of ESQUEMA) await db.query(sql);
    await db.query('INSERT IGNORE INTO categorias (nome, escopo, tipo, motivo) VALUES ?', [CATEGORIAS_PADRAO.map((c) => [c.nome, c.escopo, c.tipo, c.motivo])]);
    return db;
  } catch (e) {
    // Conexão aberta segura o processo vivo: fecha antes de propagar o erro.
    await db.end();
    throw e;
  }
}

/** As contas do config.json precisam existir na tabela contas (chave estrangeira dos lançamentos). */
export async function sincronizarContas(db: Banco, contas: { nome: string; tipo: 'Conta' | 'Cartão' }[]): Promise<void> {
  if (contas.length === 0) return;
  await db.query('INSERT IGNORE INTO contas (nome, tipo) VALUES ?', [contas.map((c) => [c.nome, c.tipo])]);
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
  cartoes: { conta: string; limite: number | null; compras: number }[];
  dividas: Divida[];
  custoVida: number;
  metaMeses: number;
  reserva?: { mes: string; valor: number };
};

/** `mes` em AAAA-MM. */
export async function lerMes(db: Banco, mes: string): Promise<DadosMes> {
  const de = `${mes}-01`;
  const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<RowDataPacket[]>(sql, params))[0] as T[];
  const noMes = 'l.data >= ? AND l.data < DATE_ADD(?, INTERVAL 1 MONTH)';
  const [parametros] = await q<{ custo_vida: number; meta_meses: number }>('SELECT custo_vida, meta_meses FROM parametros WHERE id = 1');
  const [reserva] = await q<{ mes: string; reserva: number }>('SELECT mes, reserva FROM patrimonio WHERE mes <= ? AND reserva IS NOT NULL ORDER BY mes DESC LIMIT 1', [de]);
  return {
    totais: await q<Total>(
      `SELECT c.escopo, c.tipo, c.motivo, c.nome AS categoria, SUM(l.valor) AS total
       FROM lancamentos l JOIN categorias c ON c.nome = l.categoria WHERE ${noMes} GROUP BY c.nome, c.escopo, c.tipo, c.motivo`,
      [de, de],
    ),
    orcamento: await q('SELECT nome AS categoria, motivo, planejado FROM categorias WHERE planejado > 0 ORDER BY nome'),
    semCategoria: await q(`SELECT l.sentido, COUNT(*) AS quantos, SUM(l.valor) AS total FROM lancamentos l WHERE l.categoria IS NULL AND ${noMes} GROUP BY l.sentido`, [de, de]),
    saldos: await q('SELECT conta, data_saldo AS dataSaldo, saldo_atual AS saldo FROM vw_saldos ORDER BY conta'),
    cartoes: await q(
      `SELECT ct.nome AS conta, ct.limite, COALESCE(SUM(CASE l.sentido WHEN 'Saída' THEN l.valor ELSE -l.valor END), 0) AS compras
       FROM contas ct LEFT JOIN lancamentos l ON l.conta = ct.nome AND ${noMes} WHERE ct.tipo = 'Cartão' GROUP BY ct.nome, ct.limite ORDER BY ct.nome`,
      [de, de],
    ),
    dividas: await q('SELECT credor, tipo, saldo, juros_mes AS juros, parcela FROM dividas WHERE saldo > 0'),
    custoVida: parametros?.custo_vida ?? 0,
    metaMeses: parametros?.meta_meses ?? 0,
    ...(reserva ? { reserva: { mes: reserva.mes, valor: reserva.reserva } } : {}),
  };
}
