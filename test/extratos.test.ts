import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lerCsv, numeroBr } from '../src/csv.ts';
import { decodificarOfx, lerOfx } from '../src/ofx.ts';
import { PERFIS } from '../src/perfis.ts';

test('OFX 1.x (SGML) em windows-1252, com FITID, NAME e MEMO', () => {
  const texto = [
    'OFXHEADER:100',
    'CHARSET:1252',
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261105120000[-3:BRT]<TRNAMT>-42,90<FITID>abc1<NAME>PADARIA SÃO JOSÉ<MEMO>Compra no débito</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261106<TRNAMT>1500.00<FITID>abc2<MEMO>Pix recebido &amp; obrigado</STMTTRN>',
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  ].join('\n');
  const bytes = Uint8Array.from([...texto].map((c) => c.charCodeAt(0))); // latin1 == 1252 para estes caracteres
  const t = lerOfx(decodificarOfx(bytes));
  assert.deepEqual(t, [
    { data: '2026-11-05', valor: -42.9, descricao: 'PADARIA SÃO JOSÉ - Compra no débito', idBanco: 'abc1' },
    { data: '2026-11-06', valor: 1500, descricao: 'Pix recebido & obrigado', idBanco: 'abc2' },
  ]);
});

test('OFX que diz 1252 mas vem em UTF-8 é lido certo', () => {
  const bytes = new TextEncoder().encode('CHARSET:1252\n<OFX><STMTTRN><DTPOSTED>20260101<TRNAMT>-1<NAME>AÇAÍ</STMTTRN></OFX>');
  assert.equal(lerOfx(decodificarOfx(bytes))[0]?.descricao, 'AÇAÍ');
});

test('arquivo que não é OFX dá erro claro', () => {
  assert.throws(() => lerOfx('Data,Valor\n'), /não parece OFX/);
});

test('CSV da conta Nubank: valor com sinal e Identificador', () => {
  const csv = '﻿Data,Valor,Identificador,Descrição\n05/11/2026,-89.90,id-1,"Compra no débito - SUPERMERCADO X, LOJA 2"\n06/11/2026,4000.00,id-2,Transferência recebida pelo Pix - EMPRESA LTDA\n';
  assert.deepEqual(lerCsv(csv, PERFIS['nubank-conta']!), [
    { data: '2026-11-05', valor: -89.9, descricao: 'Compra no débito - SUPERMERCADO X, LOJA 2', idBanco: 'id-1' },
    { data: '2026-11-06', valor: 4000, descricao: 'Transferência recebida pelo Pix - EMPRESA LTDA', idBanco: 'id-2' },
  ]);
});

test('CSV da fatura Nubank: compra positiva vira saída, pagamento vira entrada', () => {
  const csv = 'date,title,amount\r\n2026-11-02,Ifood *Restaurante,54.30\r\n2026-11-10,Pagamento recebido,-1200.00\r\n';
  assert.deepEqual(lerCsv(csv, PERFIS['nubank-cartao']!), [
    { data: '2026-11-02', valor: -54.3, descricao: 'Ifood *Restaurante' },
    { data: '2026-11-10', valor: 1200, descricao: 'Pagamento recebido' },
  ]);
});

test('CSV genérico com ; , vírgula decimal e colunas de entrada/saída', () => {
  const csv = 'Extrato\nData;Histórico;Crédito;Débito\n1/2/26;Salário;1.234,56;\n03/02/2026;Luz;;R$ 150,00\n';
  const t = lerCsv(csv, { pularLinhas: 1, colunas: { data: 'Data', descricao: 'Histórico', entrada: 'Crédito', saida: 'Débito' } });
  assert.deepEqual(t, [
    { data: '2026-02-01', valor: 1234.56, descricao: 'Salário' },
    { data: '2026-02-03', valor: -150, descricao: 'Luz' },
  ]);
});

test('CSV: coluna faltando e valor inválido citam o problema e a linha', () => {
  assert.throws(() => lerCsv('a,b\n1,2\n', PERFIS['nubank-conta']!), /Coluna "Data" não está no cabeçalho/);
  assert.throws(() => lerCsv('Data,Valor,Identificador,Descrição\n05/11/2026,abc,1,x\n', PERFIS['nubank-conta']!), /Linha 2 do CSV: Valor inválido/);
});

test('numeroBr entende parênteses, sinal no fim e espaço inseparável', () => {
  assert.equal(numeroBr('(1.000,50)', ','), -1000.5);
  assert.equal(numeroBr('25,00-', ','), -25);
  assert.equal(numeroBr('R$ 1.234,00', ','), 1234);
  assert.equal(numeroBr('1,234.5', '.'), 1234.5);
});
