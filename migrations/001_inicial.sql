-- Esquema da primeira versão (até 2026-11-08): contas e parâmetros sem dono, um fechamento por mês.
-- Banco criado antes das migrations já está neste ponto: o `nova` só registra esta versão, sem rodar.

CREATE TABLE IF NOT EXISTS parametros (
  id TINYINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  custo_vida DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Custo de vida mensal PF, base da meta de reserva',
  meta_meses TINYINT UNSIGNED NOT NULL DEFAULT 6 COMMENT 'Meta de reserva em meses de custo de vida'
);

INSERT IGNORE INTO parametros (id) VALUES (1);

CREATE TABLE IF NOT EXISTS titulares (
  apelido VARCHAR(60) PRIMARY KEY,
  escopo ENUM('PF','PJ') NOT NULL,
  nome VARCHAR(150) NOT NULL COMMENT 'Nome completo ou razão social',
  documento VARCHAR(14) NULL COMMENT 'CPF ou CNPJ, só dígitos'
);

CREATE TABLE IF NOT EXISTS contas (
  nome VARCHAR(60) PRIMARY KEY COMMENT 'O mesmo nome do config.json',
  titular VARCHAR(60) NULL,
  banco VARCHAR(60) NULL,
  tipo ENUM('Conta','Cartão') NOT NULL DEFAULT 'Conta',
  saldo_inicial DECIMAL(12,2) NULL COMMENT 'Conta: saldo no fim do dia data_saldo; vw_saldos soma os lançamentos posteriores',
  data_saldo DATE NULL,
  limite DECIMAL(12,2) NULL COMMENT 'Cartão: limite total',
  FOREIGN KEY (titular) REFERENCES titulares (apelido) ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS cartoes (
  conta VARCHAR(60) NOT NULL,
  final CHAR(4) NOT NULL COMMENT 'Últimos 4 dígitos',
  nome VARCHAR(60) NOT NULL COMMENT 'Ex.: Físico, ou o apelido do cartão virtual',
  tipo ENUM('Físico','Virtual') NOT NULL DEFAULT 'Físico',
  variante VARCHAR(40) NULL COMMENT 'Ex.: Gold, Micro Business',
  PRIMARY KEY (conta, final),
  FOREIGN KEY (conta) REFERENCES contas (nome) ON UPDATE CASCADE
);

-- Os valores dos ENUM de motivo e de tipo de dívida são os de src/categorias.ts (o teste confere).
CREATE TABLE IF NOT EXISTS categorias (
  nome VARCHAR(80) PRIMARY KEY,
  escopo ENUM('PF','PJ') NOT NULL,
  tipo ENUM('Entrada','Saída') NOT NULL,
  motivo ENUM('Receita','Essencial','Escolha','Imposto','Dívida','Poupança','Investimento','Transferência') NOT NULL,
  planejado DECIMAL(12,2) NULL COMMENT 'Orçamento mensal (categorias de Saída)'
);

CREATE TABLE IF NOT EXISTS lancamentos (
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
);

CREATE TABLE IF NOT EXISTS dividas (
  credor VARCHAR(80) PRIMARY KEY,
  tipo ENUM('Cartão (rotativo)','Cheque especial','Empréstimo pessoal','Financiamento','Parcelamento','Outro') NOT NULL,
  saldo DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Atualize no fechamento de cada mês',
  juros_mes DECIMAL(7,4) NULL COMMENT 'Taxa mensal em fração: 12% a.m. = 0.12 (CET do contrato ou da fatura)',
  parcela DECIMAL(12,2) NULL
);

CREATE TABLE IF NOT EXISTS patrimonio (
  mes DATE PRIMARY KEY COMMENT 'Dia 1 do mês do fechamento',
  contas_pf DECIMAL(12,2) NULL,
  contas_pj DECIMAL(12,2) NULL,
  reserva DECIMAL(12,2) NULL,
  fiis DECIMAL(12,2) NULL COMMENT 'Valor de mercado',
  outros DECIMAL(12,2) NULL,
  dividas DECIMAL(12,2) NULL
);

CREATE OR REPLACE VIEW vw_lancamentos AS
  SELECT l.id, l.data, DATE_FORMAT(l.data, '%Y-%m') AS mes, l.conta, l.categoria, c.escopo, c.motivo, l.sentido, l.valor, l.descricao, l.id_transacao
  FROM lancamentos l LEFT JOIN categorias c ON c.nome = l.categoria;

CREATE OR REPLACE VIEW vw_saldos AS
  SELECT ct.nome AS conta, ct.titular, ct.data_saldo, ct.saldo_inicial,
    ct.saldo_inicial + COALESCE(SUM(CASE l.sentido WHEN 'Entrada' THEN l.valor ELSE -l.valor END), 0) AS saldo_atual
  FROM contas ct LEFT JOIN lancamentos l ON l.conta = ct.nome AND l.data > ct.data_saldo
  WHERE ct.tipo = 'Conta' AND ct.saldo_inicial IS NOT NULL
  GROUP BY ct.nome, ct.titular, ct.data_saldo, ct.saldo_inicial;
