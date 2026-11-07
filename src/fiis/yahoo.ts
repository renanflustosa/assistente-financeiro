import type { Provento } from './carteira.ts';

type Resposta = {
  chart?: {
    result?: {
      meta?: { regularMarketPrice?: number };
      events?: { dividends?: Record<string, { amount: number; date: number }> };
    }[];
  };
};

/** Cotação atual e proventos dos últimos 2 anos de um ticker da B3, via Yahoo Finance (sem chave). */
export async function cotar(ticker: string): Promise<{ preco: number; proventos: Provento[] }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.SA?range=2y&interval=1mo&events=div`;
  // Sem User-Agent de navegador o Yahoo responde 429.
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw new Error(`${ticker}: ticker não encontrado no Yahoo Finance`);
  if (!res.ok) throw new Error(`${ticker}: Yahoo Finance respondeu HTTP ${res.status}`);

  const resultado = ((await res.json()) as Resposta).chart?.result?.[0];
  const preco = resultado?.meta?.regularMarketPrice;
  if (typeof preco !== 'number' || preco <= 0) throw new Error(`${ticker}: Yahoo Finance não retornou cotação`);

  const proventos = Object.values(resultado?.events?.dividends ?? {}).map((d) => ({
    data: new Date(d.date * 1000),
    valor: d.amount,
  }));
  return { preco, proventos };
}
