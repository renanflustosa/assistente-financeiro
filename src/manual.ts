import { numeroBr } from './csv.ts';

/** Data do lançamento manual: DD/MM/AAAA, DD/MM (ano de `hoje`) ou AAAA-MM-DD. Devolve AAAA-MM-DD. */
export function lerData(s: string, hoje: Date = new Date()): string {
  const br = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const [a, m, d] = br ? [Number(br[3] ?? hoje.getFullYear()), Number(br[2]), Number(br[1])] : iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : [NaN, NaN, NaN];
  const data = new Date(Date.UTC(a, m - 1, d));
  if (!Number.isFinite(a) || data.getUTCFullYear() !== a || data.getUTCMonth() !== m - 1 || data.getUTCDate() !== d) {
    throw new Error(`Data inválida: "${s}" (use DD/MM, DD/MM/AAAA ou AAAA-MM-DD).`);
  }
  return data.toISOString().slice(0, 10);
}

/** Valor em reais, sempre positivo, vírgula nos centavos: "45,90", "1.234,56", "1500". */
export function lerValor(s: string): number {
  let v = NaN;
  try {
    v = numeroBr(s, ',');
  } catch {
    // cai na mensagem abaixo, que explica o formato
  }
  if (!(v > 0) || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) throw new Error(`Valor inválido: "${s}" (positivo, até 2 casas, vírgula nos centavos; o sentido vem da categoria ou de --entrada).`);
  return v;
}
