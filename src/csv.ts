import type { Transacao } from './ofx.ts';

/**
 * Como ler o CSV de um banco. As colunas são os nomes do cabeçalho do arquivo.
 * Use `valor` (com sinal) ou o par `entrada`/`saida` (os dois positivos).
 */
export type PerfilCsv = {
  separador?: string; // padrão: detecta ; ou ,
  decimal?: ',' | '.'; // padrão: ','
  formatoData?: 'DD/MM/AAAA' | 'AAAA-MM-DD'; // padrão: 'DD/MM/AAAA'
  pularLinhas?: number; // linhas antes do cabeçalho
  colunas: { data: string; descricao: string; valor?: string; entrada?: string; saida?: string; id?: string };
  /** Fatura de cartão costuma listar a compra como valor positivo: inverte para virar saída. */
  inverterSinal?: boolean;
};

/** Divide o texto em linhas de campos, respeitando aspas ("a;b" e aspas duplicadas ""). */
export function dividirCsv(texto: string, separador: string): string[][] {
  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === separador) {
      linha.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo);
      if (linha.some((v) => v.trim() !== '')) linhas.push(linha);
      linha = [];
      campo = '';
    } else campo += c;
  }
  linha.push(campo);
  if (linha.some((v) => v.trim() !== '')) linhas.push(linha);
  return linhas;
}

export function numeroBr(s: string, decimal: ',' | '.'): number {
  let t = s.replace(/[R$\s]/g, '').replace(/\u00A0/g, '');
  const negativo = /^\(.*\)$/.test(t) || t.endsWith('-');
  t = t.replace(/[()]/g, '').replace(/-$/, '');
  t = decimal === ',' ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  const n = Number(t);
  if (t === '' || !Number.isFinite(n)) throw new Error(`Valor inválido no CSV: "${s}"`);
  return negativo ? -Math.abs(n) : n;
}

function dataCsv(s: string, formato: 'DD/MM/AAAA' | 'AAAA-MM-DD'): string {
  const t = s.trim();
  const m = formato === 'DD/MM/AAAA' ? /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t) : /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) throw new Error(`Data inválida no CSV: "${s}" (formato esperado ${formato})`);
  const [a, b, c] = [m[1]!, m[2]!, m[3]!];
  const [ano, mes, dia] = formato === 'DD/MM/AAAA' ? [c.length === 2 ? `20${c}` : c, b, a] : [a, b, c];
  return `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
}

export function lerCsv(texto: string, perfil: PerfilCsv): Transacao[] {
  const semBom = texto.replace(/^\uFEFF/, '');
  const corpo = semBom.split(/\r?\n/).slice(perfil.pularLinhas ?? 0).join('\n');
  const primeira = corpo.split('\n', 1)[0] ?? '';
  const sep = perfil.separador ?? ((primeira.match(/;/g)?.length ?? 0) >= (primeira.match(/,/g)?.length ?? 0) ? ';' : ',');
  const [cabecalho, ...linhas] = dividirCsv(corpo, sep);
  if (!cabecalho) throw new Error('CSV vazio.');
  const nomes = cabecalho.map((h) => h.trim().toLowerCase());
  const indice = (col: string | undefined) => {
    if (col === undefined) return undefined;
    const i = nomes.indexOf(col.trim().toLowerCase());
    if (i < 0) throw new Error(`Coluna "${col}" não está no cabeçalho do CSV (${cabecalho.join(sep)}).`);
    return i;
  };
  const c = perfil.colunas;
  if ((c.valor === undefined) === (c.entrada === undefined && c.saida === undefined)) {
    throw new Error('Perfil CSV: informe "valor" ou o par "entrada"/"saida" em colunas.');
  }
  const iData = indice(c.data)!;
  const iDesc = indice(c.descricao)!;
  const [iValor, iEntrada, iSaida, iId] = [indice(c.valor), indice(c.entrada), indice(c.saida), indice(c.id)];
  const decimal = perfil.decimal ?? ',';
  const formato = perfil.formatoData ?? 'DD/MM/AAAA';

  return linhas.map((l, n) => {
    const campo = (i: number | undefined) => (i === undefined ? '' : (l[i] ?? '').trim());
    try {
      let valor: number;
      if (iValor !== undefined) valor = numeroBr(campo(iValor), decimal);
      else {
        const e = campo(iEntrada);
        const s = campo(iSaida);
        valor = (e ? Math.abs(numeroBr(e, decimal)) : 0) - (s ? Math.abs(numeroBr(s, decimal)) : 0);
      }
      if (perfil.inverterSinal) valor = -valor;
      const id = campo(iId);
      return { data: dataCsv(campo(iData), formato), valor, descricao: campo(iDesc) || '(sem descrição)', ...(id ? { idBanco: id } : {}) };
    } catch (e) {
      throw new Error(`Linha ${n + 2 + (perfil.pularLinhas ?? 0)} do CSV: ${(e as Error).message}`);
    }
  });
}
