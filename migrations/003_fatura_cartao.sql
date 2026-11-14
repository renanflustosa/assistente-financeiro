-- 2026-11-14: o gasto no cartão passa a ser a fatura paga pela conta (motivo Cartão), não mais as compras.
-- As compras lançadas em contas do tipo Cartão continuam na tabela e no limite (vw_cartoes), mas saem do resumo.
-- Para voltar: UPDATE categorias SET motivo = 'Transferência' WHERE motivo = 'Cartão'; depois o MODIFY com o ENUM da 001
-- e o vw_cartoes da 002; e reverta o código.

ALTER TABLE categorias
  MODIFY motivo ENUM('Receita','Essencial','Escolha','Imposto','Dívida','Cartão','Poupança','Investimento','Transferência') NOT NULL;

UPDATE categorias SET motivo = 'Cartão' WHERE nome LIKE '% - Pagamento fatura cartão' AND tipo = 'Saída';

-- Igual ao da 002, sem exigir motivo Transferência no pagamento da fatura.
CREATE OR REPLACE VIEW vw_cartoes AS
  SELECT ct.nome AS conta, (SELECT t.pessoa FROM titulares t WHERE t.apelido = ct.titular) AS pessoa, ct.titular, ct.limite_total,
    ct.limite_total
      - COALESCE((SELECT SUM(CASE l.sentido WHEN 'Saída' THEN l.valor ELSE -l.valor END) FROM lancamentos l WHERE l.conta = ct.nome), 0)
      + COALESCE((SELECT SUM(p.valor) FROM lancamentos p JOIN contas pc ON pc.nome = p.conta
                  WHERE pc.titular = ct.titular AND pc.tipo = 'Conta' AND p.categoria LIKE '% - Pagamento fatura cartão' AND p.sentido = 'Saída'), 0)
      AS limite_disponivel
  FROM contas ct WHERE ct.tipo = 'Cartão';
