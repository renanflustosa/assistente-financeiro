import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gerar, ler, modeloPadrao, salvar } from '../src/planilha.ts';

const dir = mkdtempSync(join(tmpdir(), 'assistente-financeiro-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('gravar e ler de volta preserva todas as células de entrada', async () => {
  const d = modeloPadrao(2026);
  d.custoVida = 3500;
  d.metaMeses = 8;
  d.contas.push('Nubank PF');
  d.categorias.push({ nome: 'PF - Pets', escopo: 'PF', tipo: 'Saída', motivo: 'Escolha' });
  d.lancamentos.push({ data: '2026-12-31', conta: 'Nubank PF', categoria: '', descricao: 'Pet shop', valor: 120.5, id: 'S-0123456789abcdef' });
  d.planejado = { 'PF - Mercado': 800, 'PF - Pets': 100 };
  d.dividas.push({ credor: 'Banco', tipo: 'Financiamento', saldo: 10000, juros: 0.015, parcela: 500 });
  d.patrimonio[0] = [1000, 2000, 3000, 4000, 5000, 600];

  const arq = join(dir, 'controle.xlsx');
  await salvar(gerar(d), arq);
  await salvar(gerar(d), arq); // segunda gravação cria o .bak
  const lido = await ler(arq);

  const ordenados = [...d.lancamentos].sort((a, b) => a.data.localeCompare(b.data));
  assert.deepEqual(lido, { ...d, lancamentos: ordenados });
});

test('fórmulas principais apontam para as faixas certas', () => {
  const wb = gerar(modeloPadrao(2026));
  const f = (aba: string, cel: string) => (wb.getWorksheet(aba)!.getCell(cel).value as { formula?: string })?.formula;
  assert.equal(f('Lancamentos', 'F2'), 'IF($C2="","",IFERROR(INDEX(Config!$B$8:$B$60,MATCH($C2,Config!$A$8:$A$60,0)),"?"))');
  assert.equal(f('Lancamentos', 'I3001'), 'IF($A3001="","",DATE(YEAR($A3001),MONTH($A3001),1))');
  assert.equal(f('Painel', 'C6'), 'SUMIFS(Lancamentos!$E$2:$E$3001,Lancamentos!$I$2:$I$3001,C$4,Lancamentos!$F$2:$F$3001,"PJ",Lancamentos!$G$2:$G$3001,"Entrada")');
  assert.equal(f('Painel', 'D21'), 'D14-D15-D20');
  assert.equal(f('Painel', 'O22'), 'IFERROR(O20/O14,0)');
  assert.equal(f('Painel', 'C27'), 'Dividas!C26');
  assert.equal(f('Orcamento', 'D5'), 'SUMIFS(Lancamentos!$E$2:$E$3001,Lancamentos!$I$2:$I$3001,D$4,Lancamentos!$C$2:$C$3001,$A5)');
  assert.equal(f('Dividas', 'H5'), 'IF(OR(A5="",N(C5)<=0),"",COUNTIFS($D$5:$D$24,">"&D5,$C$5:$C$24,">0")+1)');
});

test('faixa de Lancamentos cresce com o volume', () => {
  const d = modeloPadrao(2026);
  d.lancamentos = Array.from({ length: 2800 }, (_, i) => ({ data: '2026-01-01', conta: 'Banco PF', categoria: '', descricao: `x${i}`, valor: 1, id: '' }));
  const ws = gerar(d).getWorksheet('Painel')!;
  assert.match((ws.getCell('C6').value as { formula: string }).formula, /\$E\$2:\$E\$4001/);
});

test('planilha sem a aba esperada dá erro claro', async () => {
  const wb = gerar(modeloPadrao(2026));
  wb.removeWorksheet(wb.getWorksheet('Dividas')!.id);
  const arq = join(dir, 'quebrada.xlsx');
  await wb.xlsx.writeFile(arq);
  await assert.rejects(ler(arq), /falta a aba "Dividas"/);
});
