/** Cálculos do resumo do mês (o que antes eram as fórmulas do Painel, Orcamento e Dividas da planilha). */

/** Soma dos lançamentos classificados do mês, por categoria. */
export type Total = { escopo: 'PF' | 'PJ'; tipo: 'Entrada' | 'Saída'; motivo: string; categoria: string; total: number };

export type Divida = { credor: string; tipo: string; saldo: number; juros: number | null; parcela: number | null };

export function painel(t: Total[]) {
  const soma = (f: (x: Total) => boolean) => t.filter(f).reduce((s, x) => s + x.total, 0);
  const pj = (x: Total) => x.escopo === 'PJ';
  const pf = (x: Total) => x.escopo === 'PF';
  const pjEntradas = soma((x) => pj(x) && x.tipo === 'Entrada');
  const pjSaidas = soma((x) => pj(x) && x.tipo === 'Saída' && x.motivo !== 'Transferência');
  const proLabore = soma((x) => x.categoria === 'PJ - Pró-labore / lucros pagos');
  const pfEntradas = soma((x) => pf(x) && x.tipo === 'Entrada');
  const motivo = (m: string) => soma((x) => pf(x) && x.motivo === m);
  const gastos = { essencial: motivo('Essencial'), escolha: motivo('Escolha'), imposto: motivo('Imposto'), divida: motivo('Dívida') };
  const totalGastos = gastos.essencial + gastos.escolha + gastos.imposto + gastos.divida;
  const poupanca = motivo('Poupança') + motivo('Investimento');
  const fracao = (x: number) => (pfEntradas > 0 ? x / pfEntradas : 0);
  return {
    pj: {
      entradas: pjEntradas,
      saidasOperacionais: pjSaidas,
      impostos: soma((x) => pj(x) && x.motivo === 'Imposto'),
      lucro: pjEntradas - pjSaidas,
      proLabore,
      ficaNoCaixa: pjEntradas - pjSaidas - proLabore,
    },
    pf: {
      entradas: pfEntradas,
      gastos: totalGastos,
      ...gastos,
      poupanca,
      sobra: pfEntradas - totalGastos - poupanca,
      taxaPoupanca: fracao(poupanca),
      pctEscolha: fracao(gastos.escolha),
      proventosFii: soma((x) => x.categoria === 'PF - Proventos FII'),
    },
  };
}

/** Planejado x realizado das categorias com orçamento ou com gasto no mês. Transferências não entram. */
export function orcamento(t: Total[], planejado: { categoria: string; motivo: string; planejado: number }[]) {
  const linhas = new Map<string, { categoria: string; motivo: string; planejado: number; realizado: number }>();
  for (const p of planejado) linhas.set(p.categoria, { ...p, realizado: 0 });
  for (const x of t) {
    if (x.tipo !== 'Saída' || x.motivo === 'Transferência') continue;
    const l = linhas.get(x.categoria) ?? { categoria: x.categoria, motivo: x.motivo, planejado: 0, realizado: 0 };
    l.realizado += x.total;
    linhas.set(x.categoria, l);
  }
  return [...linhas.values()].map((l) => ({ ...l, diferenca: l.planejado - l.realizado, estourou: l.planejado > 0 && l.realizado > l.planejado })).sort((a, b) => a.categoria.localeCompare(b.categoria));
}

/** Meses para quitar com parcela fixa (NPER), ou o motivo de não quitar. */
export function mesesParaQuitar(saldo: number, juros: number, parcela: number): number | 'parcela não cobre os juros' {
  if (parcela <= saldo * juros) return 'parcela não cobre os juros';
  if (juros === 0) return Math.ceil(saldo / parcela);
  return Math.ceil(-Math.log(1 - (juros * saldo) / parcela) / Math.log(1 + juros));
}

/** Avalanche: quite primeiro a de maior juros; nas outras, só o mínimo. */
export function avalanche(dividas: Divida[]) {
  return dividas
    .filter((d) => d.saldo > 0)
    .sort((a, b) => (b.juros ?? 0) - (a.juros ?? 0))
    .map((d, i) => ({
      ordem: i + 1,
      ...d,
      jurosMes: d.juros === null ? null : d.saldo * d.juros,
      jurosAno: d.juros === null ? null : (1 + d.juros) ** 12 - 1,
      meses: d.parcela && d.parcela > 0 ? mesesParaQuitar(d.saldo, d.juros ?? 0, d.parcela) : null,
    }));
}
