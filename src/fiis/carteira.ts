export type Provento = { data: Date; valor: number };

export type Fii = {
  ticker: string;
  peso: number;
  cotas: number;
  preco: number;
  proventos: Provento[];
};

export type Regras = {
  /** DY anual mínimo aceito na compra (0.10 = 10%); define o preço teto. */
  dyMinimo: number;
  /** Meses com provento nos últimos 12 para o FII ser comprado. */
  mesesMinimos: number;
};

export type Analise = Omit<Fii, 'proventos'> & {
  proventos12m: number;
  mesesPagos: number;
  dy: number;
  precoTeto: number;
  /** Cotas a partir das quais o provento do mês compra uma cota nova. */
  numeroMagico: number;
  /** Por que não entra no aporte; ausente quando o FII é elegível. */
  bloqueio?: string;
};

export type Sugestao = Analise & { comprar: number };

const UM_ANO_MS = 365 * 24 * 60 * 60 * 1000;

const soma = (valores: number[]) => valores.reduce((a, b) => a + b, 0);
const centavos = (valor: number) => Math.round(valor * 100) / 100;

export function analisar(fii: Fii, regras: Regras, agora: Date): Analise {
  const inicio = agora.getTime() - UM_ANO_MS;
  const recentes = fii.proventos.filter((p) => p.data.getTime() > inicio && p.data <= agora);
  const proventos12m = soma(recentes.map((p) => p.valor));
  const mesesPagos = new Set(recentes.map((p) => `${p.data.getUTCFullYear()}-${p.data.getUTCMonth()}`)).size;
  const mensal = proventos12m / 12;
  // Preço teto de Bazin: acima dele o DY fica abaixo do mínimo, então espera-se o preço cair.
  const precoTeto = proventos12m / regras.dyMinimo;

  let bloqueio: string | undefined;
  if (mesesPagos < regras.mesesMinimos) bloqueio = `pagou em ${mesesPagos} dos últimos 12 meses`;
  else if (fii.preco > precoTeto) bloqueio = 'acima do preço teto';

  return {
    ticker: fii.ticker,
    peso: fii.peso,
    cotas: fii.cotas,
    preco: fii.preco,
    proventos12m,
    mesesPagos,
    dy: proventos12m / fii.preco,
    precoTeto,
    // A folga absorve o erro de ponto flutuante (10 / 0.1 vira 100.0000001).
    numeroMagico: mensal > 0 ? Math.ceil(fii.preco / mensal - 1e-9) : Infinity,
    bloqueio,
  };
}

/**
 * Compra uma cota por vez do FII elegível mais abaixo da sua meta, até o dinheiro
 * não pagar mais nenhuma cota. Assim o aporte rebalanceia sem precisar vender.
 */
export function sugerirAporte(fiis: Analise[], aporte: number): { fiis: Sugestao[]; sobra: number } {
  const pesoTotal = soma(fiis.map((f) => f.peso));
  const patrimonio = soma(fiis.map((f) => f.cotas * f.preco)) + aporte;
  const resultado: Sugestao[] = fiis.map((f) => ({ ...f, comprar: 0 }));
  const ocupacao = (f: Sugestao) => ((f.cotas + f.comprar) * f.preco) / ((f.peso / pesoTotal) * patrimonio);

  let caixa = aporte;
  for (;;) {
    const candidatos = resultado.filter((f) => !f.bloqueio && f.peso > 0 && f.preco <= caixa);
    if (candidatos.length === 0) break;
    const escolhido = candidatos.reduce((a, b) => (ocupacao(b) < ocupacao(a) ? b : a));
    escolhido.comprar++;
    caixa = centavos(caixa - escolhido.preco);
  }
  return { fiis: resultado, sobra: caixa };
}

export function rendaMensal(fiis: Sugestao[], incluirCompras: boolean): number {
  return soma(fiis.map((f) => (f.cotas + (incluirCompras ? f.comprar : 0)) * (f.proventos12m / 12)));
}
