import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { Categoria, Lancamento } from './regras.ts';

/**
 * A planilha é regerada inteira a cada gravação: o código é a fonte do layout e das fórmulas,
 * e só as células de entrada (as que o usuário preenche) são lidas de volta e preservadas.
 */
export type Divida = { credor: string; tipo: string; saldo?: number; juros?: number; parcela?: number };

export type Dados = {
  ano: number;
  custoVida: number;
  metaMeses: number;
  categorias: Categoria[];
  contas: string[];
  lancamentos: Lancamento[];
  /** Planejado mensal por nome de categoria. */
  planejado: Record<string, number>;
  dividas: Divida[];
  /** 12 meses x [Contas PF, Contas PJ, Reserva, FIIs, Outros, Dívidas]. */
  patrimonio: (number | undefined)[][];
};

export const MOTIVOS = ['Receita', 'Essencial', 'Escolha', 'Imposto', 'Dívida', 'Poupança', 'Investimento', 'Transferência'];
export const TIPOS_DIVIDA = ['Cartão (rotativo)', 'Cheque especial', 'Empréstimo pessoal', 'Financiamento', 'Parcelamento', 'Outro'];
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

const CAT_PRIMEIRA = 8;
const CAT_ULTIMA = 60;
const CONTA_PRIMEIRA = 8;
const CONTA_ULTIMA = 30;
const DIV_PRIMEIRA = 5;
const DIV_ULTIMA = 24;

const c = (nome: string, escopo: 'PF' | 'PJ', tipo: 'Entrada' | 'Saída', motivo: string): Categoria => ({ nome, escopo, tipo, motivo });
export const CATEGORIAS_PADRAO: Categoria[] = [
  c('PJ - Faturamento de clientes', 'PJ', 'Entrada', 'Receita'),
  c('PJ - Outras receitas', 'PJ', 'Entrada', 'Receita'),
  c('PJ - Impostos (DAS/Simples)', 'PJ', 'Saída', 'Imposto'),
  c('PJ - Contador', 'PJ', 'Saída', 'Essencial'),
  c('PJ - Ferramentas e software', 'PJ', 'Saída', 'Essencial'),
  c('PJ - Infra e hospedagem', 'PJ', 'Saída', 'Essencial'),
  c('PJ - Marketing', 'PJ', 'Saída', 'Escolha'),
  c('PJ - Taxas bancárias', 'PJ', 'Saída', 'Essencial'),
  c('PJ - Pró-labore / lucros pagos', 'PJ', 'Saída', 'Transferência'),
  c('PJ - Pagamento fatura cartão', 'PJ', 'Saída', 'Transferência'),
  c('PF - Pró-labore / lucros recebidos', 'PF', 'Entrada', 'Receita'),
  c('PF - Proventos FII', 'PF', 'Entrada', 'Receita'),
  c('PF - Outras receitas', 'PF', 'Entrada', 'Receita'),
  c('PF - Moradia', 'PF', 'Saída', 'Essencial'),
  c('PF - Contas da casa (luz, água, internet)', 'PF', 'Saída', 'Essencial'),
  c('PF - Mercado', 'PF', 'Saída', 'Essencial'),
  c('PF - Transporte', 'PF', 'Saída', 'Essencial'),
  c('PF - Saúde', 'PF', 'Saída', 'Essencial'),
  c('PF - Educação e livros', 'PF', 'Saída', 'Essencial'),
  c('PF - Assinaturas', 'PF', 'Saída', 'Escolha'),
  c('PF - Restaurantes e delivery', 'PF', 'Saída', 'Escolha'),
  c('PF - Lazer', 'PF', 'Saída', 'Escolha'),
  c('PF - Compras pessoais', 'PF', 'Saída', 'Escolha'),
  c('PF - Impostos (IPVA, IPTU, IR)', 'PF', 'Saída', 'Imposto'),
  c('PF - Pagamento de dívida', 'PF', 'Saída', 'Dívida'),
  c('PF - Reserva de emergência', 'PF', 'Saída', 'Poupança'),
  c('PF - Fundo despesas anuais', 'PF', 'Saída', 'Poupança'),
  c('PF - Aporte em FII', 'PF', 'Saída', 'Investimento'),
  c('PF - Pagamento fatura cartão', 'PF', 'Saída', 'Transferência'),
];

export function modeloPadrao(ano: number): Dados {
  const ex = (dia: number, conta: string, categoria: string, descricao: string, valor: number): Lancamento => ({
    data: `${ano}-01-${String(dia).padStart(2, '0')}`,
    conta,
    categoria,
    descricao: `EXEMPLO - ${descricao} (apague)`,
    valor,
    id: '',
  });
  return {
    ano,
    custoVida: 0,
    metaMeses: 6,
    categorias: CATEGORIAS_PADRAO.map((x) => ({ ...x })),
    contas: ['Banco PF', 'Cartão PF', 'Banco PJ', 'Cartão PJ', 'Corretora', 'Dinheiro'],
    lancamentos: [
      ex(5, 'Banco PJ', 'PJ - Faturamento de clientes', 'projeto cliente X', 6000),
      ex(6, 'Banco PJ', 'PJ - Pró-labore / lucros pagos', 'pró-labore do mês', 4000),
      ex(6, 'Banco PF', 'PF - Pró-labore / lucros recebidos', 'pró-labore do mês', 4000),
      ex(7, 'Cartão PF', 'PF - Mercado', 'compra do mês', 650),
      ex(7, 'Corretora', 'PF - Aporte em FII', 'aporte mensal', 500),
    ],
    planejado: {},
    dividas: [{ credor: 'EXEMPLO - cartão (apague)', tipo: 'Cartão (rotativo)', saldo: 3000, juros: 0.12, parcela: 400 }],
    patrimonio: Array.from({ length: 12 }, () => Array<number | undefined>(6).fill(undefined)),
  };
}

// ---------------------------------------------------------------- estilo

const FONTE = 'Arial';
const BRL = '"R$" #,##0.00;[Red]-"R$" #,##0.00;"-"';
const PCT = '0.0%;[Red]-0.0%;"-"';
const cor = (argb: string) => ({ argb: `FF${argb}` });
const preenchimento = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: cor(argb) });
const F = {
  normal: { name: FONTE, size: 10 },
  negrito: { name: FONTE, size: 10, bold: true },
  titulo: { name: FONTE, size: 14, bold: true },
  cabecalho: { name: FONTE, size: 10, bold: true, color: cor('FFFFFF') },
  entrada: { name: FONTE, size: 10, color: cor('0000FF') },
  link: { name: FONTE, size: 10, color: cor('008000') },
  nota: { name: FONTE, size: 9, italic: true, color: cor('595959') },
} satisfies Record<string, Partial<ExcelJS.Font>>;
const FUNDO = { cabecalho: preenchimento('1F3864'), secao: preenchimento('D9E1F2'), entrada: preenchimento('FFFF00'), calculo: preenchimento('F2F2F2'), alerta: preenchimento('FFC7CE') };
const fina = { style: 'thin' as const, color: cor('BFBFBF') };
const BORDA: Partial<ExcelJS.Borders> = { top: fina, bottom: fina, left: fina, right: fina };

type Estilo = { font?: Partial<ExcelJS.Font>; fill?: ExcelJS.Fill; numFmt?: string; border?: boolean };

function pôr(ws: ExcelJS.Worksheet, endereco: string, valor: ExcelJS.CellValue | undefined, e: Estilo = {}) {
  const cel = ws.getCell(endereco);
  if (valor !== undefined) {
    cel.value = typeof valor === 'string' && valor.startsWith('=') ? { formula: valor.slice(1) } : valor;
  }
  cel.font = e.font ?? F.normal;
  if (e.fill) cel.fill = e.fill;
  if (e.numFmt) cel.numFmt = e.numFmt;
  if (e.border) cel.border = BORDA;
}

function cabecalho(ws: ExcelJS.Worksheet, linha: number, rotulos: string[], coluna = 1) {
  rotulos.forEach((r, i) => {
    const cel = ws.getCell(linha, coluna + i);
    cel.value = r;
    cel.font = F.cabecalho;
    cel.fill = FUNDO.cabecalho;
    cel.border = BORDA;
    cel.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
}

const col = (n: number) => String.fromCharCode(64 + n); // 1 -> A (até Z)
function larguras(ws: ExcelJS.Worksheet, ws_: Record<string, number>) {
  for (const [k, v] of Object.entries(ws_)) ws.getColumn(k).width = v;
}
function validacao(ws: ExcelJS.Worksheet, faixa: string, v: ExcelJS.DataValidation) {
  (ws as unknown as { dataValidations: { add(a: string, v: ExcelJS.DataValidation): void } }).dataValidations.add(faixa, v);
}
const lista = (formula: string): ExcelJS.DataValidation => ({ type: 'list', allowBlank: true, formulae: [formula] });

/** Data AAAA-MM-DD como Date em UTC, para o Excel não deslocar o dia pelo fuso. */
const dataUtc = (iso: string) => new Date(`${iso}T00:00:00Z`);

// ---------------------------------------------------------------- geração

export function gerar(d: Dados): ExcelJS.Workbook {
  if (d.categorias.length > CAT_ULTIMA - CAT_PRIMEIRA + 1) throw new Error(`No máximo ${CAT_ULTIMA - CAT_PRIMEIRA + 1} categorias.`);
  if (d.contas.length > CONTA_ULTIMA - CONTA_PRIMEIRA + 1) throw new Error(`No máximo ${CONTA_ULTIMA - CONTA_PRIMEIRA + 1} contas.`);
  if (d.dividas.length > DIV_ULTIMA - DIV_PRIMEIRA + 1) throw new Error(`No máximo ${DIV_ULTIMA - DIV_PRIMEIRA + 1} dívidas.`);

  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const leia = wb.addWorksheet('LEIA-ME');
  const painel = wb.addWorksheet('Painel');
  const lanc = wb.addWorksheet('Lancamentos');
  const orc = wb.addWorksheet('Orcamento');
  const div = wb.addWorksheet('Dividas');
  const pat = wb.addWorksheet('Patrimonio');
  const cfg = wb.addWorksheet('Config');

  // LEIA-ME
  pôr(leia, 'A1', 'Controle financeiro PF + PJ', { font: F.titulo });
  const texto = [
    'Como usar',
    '1. Config: ajuste o ano do painel, o custo de vida mensal PF, a meta de reserva e os nomes das suas contas (células amarelas).',
    '2. Lancamentos: o assistente-financeiro importa os extratos aqui. Lançamentos manuais: preencha Data, Conta, Categoria, Descrição/por quê e Valor (sempre positivo).',
    "   Escopo (PF/PJ), Tipo (Entrada/Saída), Motivo e Mês vêm da categoria. Um '?' indica categoria que não existe na Config; Categoria amarela = falta classificar.",
    '3. Orcamento: preencha o planejado mensal por categoria (amarelo); o realizado vem dos lançamentos. Vermelho = mês acima do planejado.',
    "4. Dividas: uma linha por dívida, saldo atualizado todo mês. A coluna 'Ordem avalanche' diz qual quitar primeiro (maior juros).",
    '5. Patrimonio: no fechamento do mês, anote os saldos de cada conta, da reserva, dos FIIs e das dívidas.',
    '6. Painel: só leitura. Mostra o que entrou, o que saiu e por quê, por mês, separado em PJ e PF.',
    '',
    'Regras de lançamento',
    "- Pró-labore: lance duas vezes. Na PJ como 'PJ - Pró-labore / lucros pagos' e na PF como 'PF - Pró-labore / lucros recebidos'.",
    '- Cartão de crédito: cada compra entra pela fatura, na categoria real. O pagamento da fatura no extrato da conta vai em',
    "  'Pagamento fatura cartão' (motivo Transferência), que não conta como gasto, para não contar a compra duas vezes.",
    '- Reserva, fundo de despesas anuais e aportes contam como Poupança/Investimento, não como gasto.',
    '- Motivo: Essencial = custo para viver/operar; Escolha = dá para cortar; Imposto; Dívida = parcela/juros;',
    '  Poupança = reserva e fundos; Investimento = FIIs; Transferência = dinheiro entre suas próprias contas.',
    `- Novas categorias: adicione na tabela da Config (até a linha ${CAT_ULTIMA}) com Escopo, Tipo e Motivo.`,
    '',
    'Planilha gerada pelo assistente-financeiro',
    '- A cada importação a planilha é regerada: os valores que você preenche são preservados, mas formatação manual, abas novas e fórmulas editadas se perdem.',
    '- A coluna J (ID) de Lancamentos evita importar a mesma transação duas vezes: não apague.',
    '- Feche a planilha antes de rodar o assistente; o arquivo anterior fica salvo como .bak.',
    '',
    'Cores',
    '- Texto azul / fundo amarelo: célula para você preencher.',
    '- Texto verde: vem de outra aba.',
    '- Fundo cinza: fórmula, não editar.',
  ];
  texto.forEach((t, i) => pôr(leia, `A${i + 3}`, t, { font: ['Como usar', 'Regras de lançamento', 'Cores', 'Planilha gerada pelo assistente-financeiro'].includes(t) ? F.negrito : F.normal }));
  larguras(leia, { A: 140 });

  // Config
  pôr(cfg, 'A1', 'Configuração', { font: F.titulo });
  const params: [string, number, string, string][] = [
    ['Ano do painel', d.ano, '0', 'Ano mostrado no Painel, Orcamento e Patrimonio. Troque em janeiro.'],
    ['Custo de vida mensal PF (R$)', d.custoVida, BRL, 'Quanto você gasta por mês para viver (Essencial). Base da meta de reserva.'],
    ['Meta de reserva (meses)', d.metaMeses, '0', 'Autônomo: entre 6 e 12 meses de custo de vida.'],
  ];
  params.forEach(([rot, v, fmt, nota], i) => {
    pôr(cfg, `A${i + 2}`, rot, { font: F.negrito });
    pôr(cfg, `B${i + 2}`, v, { font: F.entrada, fill: FUNDO.entrada, numFmt: fmt, border: true });
    pôr(cfg, `C${i + 2}`, nota, { font: F.nota });
  });
  pôr(cfg, 'A5', 'Meta de reserva (R$)', { font: F.negrito });
  pôr(cfg, 'B5', '=B3*B4', { numFmt: BRL, fill: FUNDO.calculo });
  cabecalho(cfg, 7, ['Categoria', 'Escopo', 'Tipo', 'Motivo']);
  cabecalho(cfg, 7, ['Contas'], 6);
  cabecalho(cfg, 7, ['Motivos'], 8);
  cabecalho(cfg, 7, ['Tipos de dívida'], 10);
  for (let r = CAT_PRIMEIRA; r <= CAT_ULTIMA; r++) {
    const k = d.categorias[r - CAT_PRIMEIRA];
    ['A', 'B', 'C', 'D'].forEach((cc, j) => pôr(cfg, `${cc}${r}`, k ? [k.nome, k.escopo, k.tipo, k.motivo][j] : undefined, { font: F.entrada, border: true }));
  }
  for (let r = CONTA_PRIMEIRA; r <= CONTA_ULTIMA; r++) pôr(cfg, `F${r}`, d.contas[r - CONTA_PRIMEIRA], { font: F.entrada, fill: FUNDO.entrada, border: true });
  MOTIVOS.forEach((m, i) => pôr(cfg, `H${8 + i}`, m));
  TIPOS_DIVIDA.forEach((t, i) => pôr(cfg, `J${8 + i}`, t));
  validacao(cfg, `B${CAT_PRIMEIRA}:B${CAT_ULTIMA}`, lista('"PF,PJ"'));
  validacao(cfg, `C${CAT_PRIMEIRA}:C${CAT_ULTIMA}`, lista('"Entrada,Saída"'));
  validacao(cfg, `D${CAT_PRIMEIRA}:D${CAT_ULTIMA}`, lista(`$H$8:$H$${7 + MOTIVOS.length}`));
  larguras(cfg, { A: 42, B: 10, C: 10, D: 14, E: 2, F: 28, G: 2, H: 16, I: 2, J: 22 });
  cfg.views = [{ state: 'frozen', ySplit: 7 }];

  // Lancamentos
  const lancs = [...d.lancamentos].sort((a, b) => a.data.localeCompare(b.data));
  const N = Math.max(3000, Math.ceil((lancs.length + 500) / 1000) * 1000);
  const ULT = N + 1;
  cabecalho(lanc, 1, ['Data', 'Conta', 'Categoria', 'Descrição / por quê', 'Valor (R$)', 'Escopo', 'Tipo', 'Motivo', 'Mês', 'ID']);
  const faixaCat = `Config!$A$${CAT_PRIMEIRA}:$A$${CAT_ULTIMA}`;
  for (let r = 2; r <= ULT; r++) {
    const l = lancs[r - 2];
    pôr(lanc, `A${r}`, l ? dataUtc(l.data) : undefined, { font: F.entrada, numFmt: 'DD/MM/YYYY' });
    pôr(lanc, `B${r}`, l?.conta, { font: F.entrada });
    pôr(lanc, `C${r}`, l?.categoria || undefined, { font: F.entrada });
    pôr(lanc, `D${r}`, l?.descricao, { font: F.entrada });
    pôr(lanc, `E${r}`, l?.valor, { font: F.entrada, numFmt: BRL });
    (['F', 'G', 'H'] as const).forEach((cc, j) => {
      const fonte = ['B', 'C', 'D'][j];
      pôr(lanc, `${cc}${r}`, `=IF($C${r}="","",IFERROR(INDEX(Config!$${fonte}$${CAT_PRIMEIRA}:$${fonte}$${CAT_ULTIMA},MATCH($C${r},${faixaCat},0)),"?"))`, { fill: FUNDO.calculo });
    });
    pôr(lanc, `I${r}`, `=IF($A${r}="","",DATE(YEAR($A${r}),MONTH($A${r}),1))`, { fill: FUNDO.calculo, numFmt: 'MMM/YYYY' });
    pôr(lanc, `J${r}`, l?.id || undefined, { font: { ...F.nota, italic: false } });
  }
  validacao(lanc, `B2:B${ULT}`, lista(`Config!$F$${CONTA_PRIMEIRA}:$F$${CONTA_ULTIMA}`));
  validacao(lanc, `C2:C${ULT}`, lista(faixaCat));
  validacao(lanc, `E2:E${ULT}`, { type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0], showErrorMessage: true, error: 'Valor sempre positivo; o Tipo (Entrada/Saída) vem da categoria.' });
  validacao(lanc, `A2:A${ULT}`, { type: 'date', operator: 'greaterThan', allowBlank: true, formulae: [new Date(Date.UTC(2000, 0, 1))], showErrorMessage: true, error: 'Use uma data (dd/mm/aaaa).' });
  lanc.addConditionalFormatting({ ref: `F2:H${ULT}`, rules: [{ type: 'expression', priority: 1, formulae: ['F2="?"'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: cor('FFC7CE') } } }] });
  lanc.addConditionalFormatting({ ref: `C2:C${ULT}`, rules: [{ type: 'expression', priority: 2, formulae: ['AND($A2<>"",$C2="")'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: cor('FFFF00') } } }] });
  larguras(lanc, { A: 12, B: 24, C: 40, D: 46, E: 14, F: 8, G: 9, H: 14, I: 10, J: 20 });
  lanc.views = [{ state: 'frozen', ySplit: 1 }];
  lanc.autoFilter = `A1:J${ULT}`;

  const L = (cc: string) => `Lancamentos!$${cc}$2:$${cc}$${ULT}`;
  const [VAL, ESC, TIP, MOT, MES, CAT] = ['E', 'F', 'G', 'H', 'I', 'C'].map(L) as [string, string, string, string, string, string];

  // Painel (meses em C..N, total em O)
  const MC = Array.from({ length: 12 }, (_, i) => col(3 + i));
  pôr(painel, 'A1', 'Painel financeiro', { font: F.titulo });
  pôr(painel, 'A2', 'Ano', { font: F.negrito });
  pôr(painel, 'B2', '=Config!B2', { font: F.link });
  cabecalho(painel, 4, ['', 'Indicador', ...MESES, 'Total']);
  MC.forEach((cc, i) => (painel.getCell(`${cc}4`).value = { formula: `DATE(Config!$B$2,${i + 1},1)` }));
  MC.forEach((cc) => (painel.getCell(`${cc}4`).numFmt = 'MMM'));
  const s = (cc: string, ...crit: [string, string][]) => `SUMIFS(${[VAL, MES, `${cc}$4`, ...crit.flat()].join(',')})`;
  type Linha = ['sec' | 'brl' | 'pct' | 'vazio', string, ((cc: string) => string)?];
  const linhas: Linha[] = [
    ['sec', 'PJ'],
    ['brl', 'Entradas', (x) => s(x, [ESC, '"PJ"'], [TIP, '"Entrada"'])],
    ['brl', 'Saídas operacionais', (x) => s(x, [ESC, '"PJ"'], [TIP, '"Saída"'], [MOT, '"<>Transferência"'])],
    ['brl', '   das quais impostos', (x) => s(x, [ESC, '"PJ"'], [MOT, '"Imposto"'])],
    ['brl', 'Lucro do mês', (x) => `${x}6-${x}7`],
    ['brl', 'Pró-labore / lucros pagos à PF', (x) => s(x, [CAT, '"PJ - Pró-labore / lucros pagos"'])],
    ['brl', 'Fica no caixa da PJ', (x) => `${x}9-${x}10`],
    ['vazio', ''],
    ['sec', 'PF'],
    ['brl', 'Entradas', (x) => s(x, [ESC, '"PF"'], [TIP, '"Entrada"'])],
    ['brl', 'Gastos', (x) => `SUM(${x}16:${x}19)`],
    ['brl', '   Essencial', (x) => s(x, [ESC, '"PF"'], [MOT, '"Essencial"'])],
    ['brl', '   Escolha', (x) => s(x, [ESC, '"PF"'], [MOT, '"Escolha"'])],
    ['brl', '   Imposto', (x) => s(x, [ESC, '"PF"'], [MOT, '"Imposto"'])],
    ['brl', '   Dívida', (x) => s(x, [ESC, '"PF"'], [MOT, '"Dívida"'])],
    ['brl', 'Poupança + investimento', (x) => `${s(x, [ESC, '"PF"'], [MOT, '"Poupança"'])}+${s(x, [ESC, '"PF"'], [MOT, '"Investimento"'])}`],
    ['brl', 'Sobra não alocada', (x) => `${x}14-${x}15-${x}20`],
    ['pct', 'Taxa de poupança', (x) => `IFERROR(${x}20/${x}14,0)`],
    ['pct', '% da renda em Escolha', (x) => `IFERROR(${x}17/${x}14,0)`],
    ['brl', 'Proventos de FII', (x) => s(x, [CAT, '"PF - Proventos FII"'])],
  ];
  const destaque = new Set(['Lucro do mês', 'Fica no caixa da PJ', 'Gastos', 'Sobra não alocada', 'Taxa de poupança']);
  linhas.forEach(([tipo, rotulo, fn], i) => {
    const r = 5 + i;
    pôr(painel, `B${r}`, rotulo, { font: tipo === 'sec' || destaque.has(rotulo) ? F.negrito : F.normal, fill: tipo === 'sec' ? FUNDO.secao : undefined });
    if (tipo === 'sec') for (const cc of ['A', ...MC, 'O']) painel.getCell(`${cc}${r}`).fill = FUNDO.secao;
    if ((tipo === 'brl' || tipo === 'pct') && fn) {
      const fmt = tipo === 'pct' ? PCT : BRL;
      for (const cc of MC) pôr(painel, `${cc}${r}`, `=${fn(cc)}`, { numFmt: fmt, border: true });
      pôr(painel, `O${r}`, tipo === 'pct' ? `=${fn('O')}` : `=SUM(C${r}:N${r})`, { numFmt: fmt, border: true });
    }
  });
  pôr(painel, 'B26', 'Situação atual', { font: F.negrito, fill: FUNDO.secao });
  for (const cc of ['A', ...MC, 'O']) painel.getCell(`${cc}26`).fill = FUNDO.secao;
  const resumo: [string, string, string, boolean][] = [
    ['Dívidas: saldo total', `=Dividas!C${DIV_ULTIMA + 2}`, BRL, true],
    ['Dívidas: juros estimados por mês', `=Dividas!G${DIV_ULTIMA + 2}`, BRL, true],
    ['Reserva de emergência (último fechamento)', '=IFERROR(INDEX(Patrimonio!D5:D16,SUMPRODUCT(MAX((Patrimonio!D5:D16<>"")*ROW(Patrimonio!D5:D16)))-4),0)', BRL, false],
    ['Meta de reserva', '=Config!B5', BRL, true],
    ['Progresso da reserva', '=IFERROR(C29/C30,0)', PCT, false],
  ];
  resumo.forEach(([rot, f, fmt, link], i) => {
    pôr(painel, `B${27 + i}`, rot);
    pôr(painel, `C${27 + i}`, f, { numFmt: fmt, border: true, font: link ? F.link : F.normal });
  });
  larguras(painel, { A: 2, B: 40, ...Object.fromEntries([...MC, 'O'].map((cc) => [cc, 13])) });
  painel.views = [{ state: 'frozen', xSplit: 2, ySplit: 4 }];

  // Orcamento (meses em D..O)
  const OM = Array.from({ length: 12 }, (_, i) => col(4 + i));
  pôr(orc, 'A1', 'Orçamento mensal: planejado x realizado', { font: F.titulo });
  pôr(orc, 'A2', 'Ano', { font: F.negrito });
  pôr(orc, 'B2', '=Config!B2', { font: F.link });
  cabecalho(orc, 4, ['Categoria', 'Motivo', 'Planejado mensal', ...MESES, 'Total ano', 'Planejado ano', 'Diferença']);
  OM.forEach((cc, i) => {
    orc.getCell(`${cc}4`).value = { formula: `DATE(Config!$B$2,${i + 1},1)` };
    orc.getCell(`${cc}4`).numFmt = 'MMM';
  });
  const saidas = d.categorias.filter((k) => k.tipo === 'Saída' && k.motivo !== 'Transferência');
  saidas.forEach((k, i) => {
    const r = 5 + i;
    pôr(orc, `A${r}`, k.nome);
    pôr(orc, `B${r}`, k.motivo);
    pôr(orc, `C${r}`, d.planejado[k.nome], { font: F.entrada, fill: FUNDO.entrada, numFmt: BRL, border: true });
    for (const cc of OM) pôr(orc, `${cc}${r}`, `=SUMIFS(${VAL},${MES},${cc}$4,${CAT},$A${r})`, { numFmt: BRL, border: true });
    pôr(orc, `P${r}`, `=SUM(D${r}:O${r})`, { numFmt: BRL, border: true });
    pôr(orc, `Q${r}`, `=C${r}*12`, { numFmt: BRL, border: true });
    pôr(orc, `R${r}`, `=Q${r}-P${r}`, { numFmt: BRL, border: true });
  });
  const ultOrc = 4 + saidas.length;
  pôr(orc, `A${ultOrc + 1}`, 'Total', { font: F.negrito });
  for (const cc of ['C', ...OM, 'P', 'Q', 'R']) pôr(orc, `${cc}${ultOrc + 1}`, `=SUM(${cc}5:${cc}${ultOrc})`, { numFmt: BRL, font: F.negrito, fill: FUNDO.secao });
  if (saidas.length > 0) {
    orc.addConditionalFormatting({ ref: `D5:O${ultOrc}`, rules: [{ type: 'expression', priority: 1, formulae: ['AND($C5>0,D5>$C5)'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: cor('FFC7CE') } } }] });
  }
  larguras(orc, { A: 40, B: 13, ...Object.fromEntries(['C', ...OM, 'P', 'Q', 'R'].map((cc) => [cc, 12])) });
  orc.views = [{ state: 'frozen', xSplit: 3, ySplit: 4 }];

  // Dividas
  pôr(div, 'A1', 'Dívidas: ordem de quitação (avalanche)', { font: F.titulo });
  pôr(div, 'A2', 'Atualize o saldo no fechamento de cada mês. Quite primeiro a de ordem 1; nas outras, pague só o mínimo.', { font: F.nota });
  cabecalho(div, 4, ['Credor', 'Tipo', 'Saldo atual', 'Juros % a.m.', 'Juros % a.a.', 'Parcela mensal', 'Juros/mês estimado', 'Ordem avalanche', 'Meses p/ quitar']);
  const fx = `$${DIV_PRIMEIRA}:`;
  for (let r = DIV_PRIMEIRA; r <= DIV_ULTIMA; r++) {
    const v = d.dividas[r - DIV_PRIMEIRA];
    const ent = { font: F.entrada, fill: FUNDO.entrada, border: true };
    pôr(div, `A${r}`, v?.credor, ent);
    pôr(div, `B${r}`, v?.tipo || undefined, ent);
    pôr(div, `C${r}`, v?.saldo, { ...ent, numFmt: BRL });
    pôr(div, `D${r}`, v?.juros, { ...ent, numFmt: '0.00%' });
    pôr(div, `F${r}`, v?.parcela, { ...ent, numFmt: BRL });
    const calc = { fill: FUNDO.calculo, border: true };
    pôr(div, `E${r}`, `=IF(D${r}="","",(1+D${r})^12-1)`, { ...calc, numFmt: '0.0%' });
    pôr(div, `G${r}`, `=IF(OR(C${r}="",D${r}=""),"",C${r}*D${r})`, { ...calc, numFmt: BRL });
    pôr(div, `H${r}`, `=IF(OR(A${r}="",N(C${r})<=0),"",COUNTIFS($D${fx}$D$${DIV_ULTIMA},">"&D${r},$C${fx}$C$${DIV_ULTIMA},">0")+1)`, calc);
    pôr(div, `I${r}`, `=IF(OR(N(C${r})<=0,N(F${r})<=0),"",IF(F${r}<=C${r}*D${r},"parcela não cobre os juros",IF(N(D${r})=0,ROUNDUP(C${r}/F${r},0),ROUNDUP(NPER(D${r},-F${r},C${r}),0))))`, calc);
  }
  validacao(div, `B${DIV_PRIMEIRA}:B${DIV_ULTIMA}`, lista(`Config!$J$8:$J$${7 + TIPOS_DIVIDA.length}`));
  const tot = DIV_ULTIMA + 2;
  pôr(div, `A${tot}`, 'Total', { font: F.negrito });
  for (const cc of ['C', 'F', 'G']) pôr(div, `${cc}${tot}`, `=SUM(${cc}${DIV_PRIMEIRA}:${cc}${DIV_ULTIMA})`, { numFmt: BRL, font: F.negrito, fill: FUNDO.secao });
  div.getCell(`D${DIV_PRIMEIRA}`).note = 'Taxa mensal em fração: 12% a.m. = 0,12. Está no contrato ou na fatura (CET).';
  larguras(div, { A: 30, B: 20, C: 14, D: 12, E: 12, F: 14, G: 16, H: 15, I: 24 });
  div.views = [{ state: 'frozen', ySplit: 4 }];

  // Patrimonio
  pôr(pat, 'A1', 'Patrimônio: fechamento mensal', { font: F.titulo });
  pôr(pat, 'A2', 'No último dia de cada mês, anote os saldos (amarelo). Dívidas = soma dos saldos da aba Dividas naquele dia.', { font: F.nota });
  cabecalho(pat, 4, ['Mês', 'Contas PF', 'Contas PJ', 'Reserva de emergência', 'FIIs (valor de mercado)', 'Outros investimentos', 'Dívidas', 'Patrimônio líquido', 'Reserva em meses']);
  for (let i = 0; i < 12; i++) {
    const r = 5 + i;
    pôr(pat, `A${r}`, `=DATE(Config!$B$2,${i + 1},1)`, { numFmt: 'MMM/YYYY' });
    ['B', 'C', 'D', 'E', 'F', 'G'].forEach((cc, j) => pôr(pat, `${cc}${r}`, d.patrimonio[i]?.[j], { font: F.entrada, fill: FUNDO.entrada, numFmt: BRL, border: true }));
    pôr(pat, `H${r}`, `=IF(COUNT(B${r}:G${r})=0,"",SUM(B${r}:F${r})-N(G${r}))`, { fill: FUNDO.calculo, numFmt: BRL, border: true });
    pôr(pat, `I${r}`, `=IF(OR(D${r}="",N(Config!$B$3)=0),"",D${r}/Config!$B$3)`, { fill: FUNDO.calculo, numFmt: '0.0" meses"', border: true });
  }
  larguras(pat, { A: 12, B: 14, C: 14, D: 16, E: 16, F: 14, G: 14, H: 16, I: 14 });
  pat.views = [{ state: 'frozen', xSplit: 1, ySplit: 4 }];

  return wb;
}

// ---------------------------------------------------------------- leitura

/** Valor "cru" de uma célula: resolve fórmula (resultado em cache), rich text e hyperlink. */
function cru(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date || typeof v !== 'object') return v;
  if ('result' in v) return cru(v.result as ExcelJS.CellValue);
  if ('richText' in v) return v.richText.map((t) => t.text).join('');
  if ('text' in v) return v.text;
  return undefined;
}
function texto(v: ExcelJS.CellValue): string {
  const x = cru(v);
  return x === undefined ? '' : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).trim();
}
function numero(v: ExcelJS.CellValue, onde: string): number | undefined {
  const x = cru(v);
  if (x === undefined || x === '') return undefined;
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string') {
    const n = Number(x.replace(/[R$\s.]/g, '').replace(',', '.'));
    if (x.trim() !== '' && Number.isFinite(n)) return n;
  }
  throw new Error(`${onde}: esperado número, achei "${String(x)}".`);
}
function data(v: ExcelJS.CellValue, onde: string): string {
  const x = cru(v);
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  if (typeof x === 'number') return new Date(Date.UTC(1899, 11, 30) + Math.round(x) * 86400000).toISOString().slice(0, 10);
  const m = typeof x === 'string' ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(x.trim()) : null;
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  throw new Error(`${onde}: data inválida "${String(x)}" (use dd/mm/aaaa).`);
}

/**
 * O exceljs quebra ao ler um desenho que só tem gráfico ("reading 'anchors'"). Como a planilha é regerada
 * e gráficos e imagens não sobrevivem de qualquer jeito, os desenhos são esvaziados antes da leitura.
 */
async function semDesenhos(bytes: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const vazio = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>';
  const desenhos = Object.keys(zip.files).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n));
  if (desenhos.length === 0) return bytes;
  for (const n of desenhos) zip.file(n, vazio);
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function ler(caminho: string): Promise<Dados> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load((await semDesenhos(readFileSync(caminho))) as unknown as ExcelJS.Buffer);
  } catch (e) {
    throw new Error(`Não consegui ler ${caminho} (${(e as Error).message}). Use uma planilha criada pelo assistente-financeiro ("nova"); a anterior fica em .bak.`);
  }
  const aba = (nome: string) => {
    const ws = wb.getWorksheet(nome);
    if (!ws) throw new Error(`${caminho}: falta a aba "${nome}". Ela foi renomeada?`);
    return ws;
  };
  const cfg = aba('Config');
  const lanc = aba('Lancamentos');
  const orc = aba('Orcamento');
  const div = aba('Dividas');
  const pat = aba('Patrimonio');
  const v = (ws: ExcelJS.Worksheet, e: string) => ws.getCell(e).value;

  const categorias: Categoria[] = [];
  for (let r = CAT_PRIMEIRA; r <= CAT_ULTIMA; r++) {
    const nome = texto(v(cfg, `A${r}`));
    if (!nome) continue;
    const escopo = texto(v(cfg, `B${r}`));
    const tipo = texto(v(cfg, `C${r}`));
    const motivo = texto(v(cfg, `D${r}`));
    if ((escopo !== 'PF' && escopo !== 'PJ') || (tipo !== 'Entrada' && tipo !== 'Saída') || !MOTIVOS.includes(motivo)) {
      throw new Error(`Config linha ${r} ("${nome}"): Escopo deve ser PF/PJ, Tipo Entrada/Saída e Motivo um de ${MOTIVOS.join(', ')}.`);
    }
    categorias.push({ nome, escopo, tipo, motivo });
  }
  const contas: string[] = [];
  for (let r = CONTA_PRIMEIRA; r <= CONTA_ULTIMA; r++) {
    const n = texto(v(cfg, `F${r}`));
    if (n) contas.push(n);
  }

  const lancamentos: Lancamento[] = [];
  for (let r = 2; r <= lanc.rowCount; r++) {
    const [a, b, cc, dd, e, j] = ['A', 'B', 'C', 'D', 'E', 'J'].map((x) => v(lanc, `${x}${r}`));
    if ([a, b, cc, dd, e].every((x) => texto(x) === '')) continue;
    const onde = `Lancamentos linha ${r}`;
    const valor = numero(e, `${onde}, Valor`);
    if (valor === undefined) throw new Error(`${onde}: falta o Valor.`);
    lancamentos.push({ data: data(a, `${onde}, Data`), conta: texto(b), categoria: texto(cc), descricao: texto(dd), valor: Math.abs(valor), id: texto(j) });
  }

  // Orcamento: nome da categoria na coluna A (valor fixo; planilhas antigas têm fórmula sem cache, daí o fallback pela ordem).
  const saidas = categorias.filter((k) => k.tipo === 'Saída' && k.motivo !== 'Transferência');
  const planejado: Record<string, number> = {};
  for (let r = 5; r <= orc.rowCount; r++) {
    const nome = texto(v(orc, `A${r}`)) || saidas[r - 5]?.nome || '';
    if (!nome || nome === 'Total') continue;
    const p = numero(v(orc, `C${r}`), `Orcamento linha ${r}, Planejado`);
    if (p !== undefined) planejado[nome] = p;
  }

  const dividas: Divida[] = [];
  for (let r = DIV_PRIMEIRA; r <= DIV_ULTIMA; r++) {
    const onde = `Dividas linha ${r}`;
    const credor = texto(v(div, `A${r}`));
    const item: Divida = {
      credor,
      tipo: texto(v(div, `B${r}`)),
      saldo: numero(v(div, `C${r}`), `${onde}, Saldo`),
      juros: numero(v(div, `D${r}`), `${onde}, Juros`),
      parcela: numero(v(div, `F${r}`), `${onde}, Parcela`),
    };
    if (credor || item.tipo || item.saldo !== undefined || item.juros !== undefined || item.parcela !== undefined) dividas.push(item);
  }

  const patrimonio = Array.from({ length: 12 }, (_, i) => ['B', 'C', 'D', 'E', 'F', 'G'].map((cc) => numero(v(pat, `${cc}${5 + i}`), `Patrimonio linha ${5 + i}, coluna ${cc}`)));

  const ano = numero(v(cfg, 'B2'), 'Config B2 (ano)');
  if (ano === undefined || !Number.isInteger(ano) || ano < 2000 || ano > 2100) throw new Error('Config B2: ano inválido.');
  return {
    ano,
    custoVida: numero(v(cfg, 'B3'), 'Config B3') ?? 0,
    metaMeses: numero(v(cfg, 'B4'), 'Config B4') ?? 6,
    categorias,
    contas,
    lancamentos,
    planejado,
    dividas,
    patrimonio,
  };
}

/** Grava sem deixar arquivo pela metade: escreve num temporário, guarda o anterior em .bak e troca. */
export async function salvar(wb: ExcelJS.Workbook, caminho: string): Promise<void> {
  const tmp = `${caminho}.tmp`;
  await wb.xlsx.writeFile(tmp);
  try {
    if (existsSync(caminho)) copyFileSync(caminho, `${caminho}.bak`);
    renameSync(tmp, caminho);
  } catch (e) {
    rmSync(tmp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM') throw new Error(`Não consegui gravar ${caminho}: feche a planilha no Excel e rode de novo.`);
    throw e;
  }
}
