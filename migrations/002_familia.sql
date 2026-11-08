-- 2026-11-08: um database por família. Pessoas donas dos titulares, das carteiras de FIIs, dos
-- fechamentos e (opcional) das dívidas; contas, regras e carteira saem dos JSON e vão para o banco.
--
-- Se falhar no patrimonio ("foreign key constraint fails"), há fechamentos sem dono. O patrimonio vem
-- primeiro, então nada mais mudou: tire os fechamentos da frente, rode `nova` de novo e devolva-os com dono.
--   CREATE TABLE patrimonio_antigo AS SELECT * FROM patrimonio; DELETE FROM patrimonio;
--   -- node src/main.ts nova
--   INSERT INTO pessoas (apelido, nome) VALUES ('<apelido>', '<nome completo>');
--   INSERT INTO patrimonio SELECT '<apelido>', p.* FROM patrimonio_antigo p; DROP TABLE patrimonio_antigo;

CREATE TABLE IF NOT EXISTS pessoas (
  apelido VARCHAR(60) PRIMARY KEY,
  nome VARCHAR(150) NOT NULL,
  custo_vida DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Custo de vida mensal PF, base da meta de reserva',
  meta_meses TINYINT UNSIGNED NOT NULL DEFAULT 6 COMMENT 'Meta de reserva em meses de custo de vida',
  aporte_fii DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Aporte mensal padrão em FIIs',
  dy_minimo DECIMAL(5,4) NOT NULL DEFAULT 0.1 COMMENT 'DY anual mínimo para comprar FII (0.1 = 10%)',
  meses_minimos TINYINT UNSIGNED NOT NULL DEFAULT 11 COMMENT 'Meses com provento nos últimos 12 para comprar',
  renda_alvo DECIMAL(12,2) NULL COMMENT 'Renda mensal desejada com FIIs'
);

ALTER TABLE patrimonio
  ADD COLUMN pessoa VARCHAR(60) NOT NULL FIRST,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (pessoa, mes),
  ADD FOREIGN KEY (pessoa) REFERENCES pessoas (apelido) ON UPDATE CASCADE;

ALTER TABLE titulares
  ADD COLUMN pessoa VARCHAR(60) NULL COMMENT 'Dono na família (a PJ é de quem é sócio)',
  ADD FOREIGN KEY (pessoa) REFERENCES pessoas (apelido) ON UPDATE CASCADE;

-- O limite disponível passa a ser calculado em vw_cartoes.
ALTER TABLE contas
  MODIFY COLUMN nome VARCHAR(60) NOT NULL,
  CHANGE COLUMN limite limite_total DECIMAL(12,2) NULL COMMENT 'Cartão: limite total do app; o disponível sai de vw_cartoes',
  ADD COLUMN perfil VARCHAR(40) NULL COMMENT 'Como ler o CSV: nubank-conta, nubank-cartao (OFX não precisa)' AFTER tipo,
  ADD COLUMN perfil_csv JSON NULL COMMENT 'Perfil próprio de CSV, para banco sem perfil pronto' AFTER perfil;

ALTER TABLE dividas
  ADD COLUMN pessoa VARCHAR(60) NULL COMMENT 'NULL = da família' AFTER credor,
  ADD FOREIGN KEY (pessoa) REFERENCES pessoas (apelido) ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS regras (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ordem INT NOT NULL COMMENT 'A de menor ordem que casa vence: específicas antes das genéricas',
  contem VARCHAR(200) NOT NULL COMMENT 'Trecho da descrição, sem diferenciar acento nem maiúscula',
  conta VARCHAR(60) NULL COMMENT 'NULL = vale para todas as contas',
  categoria VARCHAR(80) NULL COMMENT 'Obrigatória, a não ser com ignorar',
  ignorar BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Descarta a transação (ex.: pagamento no extrato do cartão)',
  INDEX (ordem),
  FOREIGN KEY (conta) REFERENCES contas (nome) ON UPDATE CASCADE,
  FOREIGN KEY (categoria) REFERENCES categorias (nome) ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS fiis (
  pessoa VARCHAR(60) NOT NULL,
  ticker CHAR(6) NOT NULL COMMENT 'Código na B3, ex.: MXRF11',
  peso DECIMAL(6,2) NOT NULL DEFAULT 1 COMMENT 'Peso relativo na carteira; 0 = não compra mais',
  cotas INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (pessoa, ticker),
  FOREIGN KEY (pessoa) REFERENCES pessoas (apelido) ON UPDATE CASCADE
);

-- parametros (sem dono) vira pessoas.custo_vida/meta_meses. Ainda com os valores padrão, não há o que
-- guardar e a tabela some aqui; com valores seus, o `nova` copia para a pessoa e então a apaga.
SET @sql = IF((SELECT COUNT(*) FROM parametros WHERE custo_vida <> 0 OR meta_meses <> 6) = 0, 'DROP TABLE parametros', 'DO 0');
PREPARE passo FROM @sql;
EXECUTE passo;
DEALLOCATE PREPARE passo;

CREATE OR REPLACE VIEW vw_lancamentos AS
  SELECT l.id, l.data, DATE_FORMAT(l.data, '%Y-%m') AS mes, t.pessoa, l.conta, l.categoria, c.escopo, c.motivo, l.sentido, l.valor, l.descricao, l.id_transacao
  FROM lancamentos l LEFT JOIN categorias c ON c.nome = l.categoria
    LEFT JOIN contas ct ON ct.nome = l.conta LEFT JOIN titulares t ON t.apelido = ct.titular;

CREATE OR REPLACE VIEW vw_saldos AS
  SELECT ct.nome AS conta, t.pessoa, ct.titular, ct.data_saldo, ct.saldo_inicial,
    ct.saldo_inicial + COALESCE(SUM(CASE l.sentido WHEN 'Entrada' THEN l.valor ELSE -l.valor END), 0) AS saldo_atual
  FROM contas ct LEFT JOIN titulares t ON t.apelido = ct.titular LEFT JOIN lancamentos l ON l.conta = ct.nome AND l.data > ct.data_saldo
  WHERE ct.tipo = 'Conta' AND ct.saldo_inicial IS NOT NULL
  GROUP BY ct.nome, t.pessoa, ct.titular, ct.data_saldo, ct.saldo_inicial;

-- Disponível = total - compras (todas as parcelas já lançadas, inclusive as futuras) + faturas pagas
-- pelas contas do mesmo titular. Supõe o cartão sem nada em aberto antes do primeiro lançamento.
CREATE OR REPLACE VIEW vw_cartoes AS
  SELECT ct.nome AS conta, (SELECT t.pessoa FROM titulares t WHERE t.apelido = ct.titular) AS pessoa, ct.titular, ct.limite_total,
    ct.limite_total
      - COALESCE((SELECT SUM(CASE l.sentido WHEN 'Saída' THEN l.valor ELSE -l.valor END) FROM lancamentos l WHERE l.conta = ct.nome), 0)
      + COALESCE((SELECT SUM(p.valor) FROM lancamentos p JOIN contas pc ON pc.nome = p.conta JOIN categorias c ON c.nome = p.categoria
                  WHERE pc.titular = ct.titular AND pc.tipo = 'Conta' AND c.motivo = 'Transferência' AND c.nome LIKE '% - Pagamento fatura cartão' AND p.sentido = 'Saída'), 0)
      AS limite_disponivel
  FROM contas ct WHERE ct.tipo = 'Cartão';
