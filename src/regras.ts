import { createHash } from 'node:crypto';
import type { Transacao } from './ofx.ts';

export type Categoria = { nome: string; escopo: 'PF' | 'PJ'; tipo: 'Entrada' | 'Saída'; motivo: string };

/** Uma linha da aba Lancamentos. `valor` é sempre positivo: o sentido vem da categoria. */
export type Lancamento = {
  data: string; // AAAA-MM-DD
  conta: string;
  categoria: string;
  descricao: string;
  valor: number;
  /** "E-<hash>" (entrada) ou "S-<hash>" (saída) para o que veio de extrato; vazio para lançamento manual. */
  id: string;
};

/**
 * `contem`: trecho(s) da descrição, sem diferenciar maiúscula nem acento.
 * `conta`: opcional, só vale para essa conta. `ignorar`: descarta a transação (ex.: pagamento da fatura no extrato do cartão).
 */
export type Regra = { contem: string | string[]; categoria?: string; conta?: string; ignorar?: boolean };

export function normalizar(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

export function validarRegras(regras: unknown, categorias: Categoria[]): Regra[] {
  if (!Array.isArray(regras)) throw new Error('regras.json: "regras" deve ser uma lista.');
  const nomes = new Set(categorias.map((c) => c.nome));
  const erros: string[] = [];
  regras.forEach((r: Regra, i) => {
    const trechos = Array.isArray(r.contem) ? r.contem : [r.contem];
    if (trechos.length === 0 || trechos.some((t) => typeof t !== 'string' || t.trim() === '')) erros.push(`regras[${i}].contem deve ser texto ou lista de textos não vazios`);
    if (r.ignorar !== true && r.categoria === undefined) erros.push(`regras[${i}] precisa de "categoria" ou "ignorar": true`);
    if (r.categoria !== undefined && !nomes.has(r.categoria)) erros.push(`regras[${i}].categoria "${r.categoria}" não existe na aba Config da planilha`);
  });
  if (erros.length > 0) throw new Error(`regras.json inválido:\n- ${erros.join('\n- ')}`);
  return regras as Regra[];
}

export type Classificacao = { ignorar: true } | { ignorar: false; categoria: string; aviso?: string };

/** Primeira regra que casa vence. Categoria cujo Tipo contradiz o sinal da transação fica em branco, com aviso. */
export function classificar(descricao: string, saida: boolean, conta: string, regras: Regra[], categorias: Categoria[]): Classificacao {
  const desc = normalizar(descricao);
  const regra = regras.find((r) => (r.conta === undefined || r.conta === conta) && (Array.isArray(r.contem) ? r.contem : [r.contem]).some((t) => desc.includes(normalizar(t))));
  if (!regra) return { ignorar: false, categoria: '' };
  if (regra.ignorar) return { ignorar: true };
  const cat = categorias.find((c) => c.nome === regra.categoria);
  if (!cat) return { ignorar: false, categoria: '' };
  if ((cat.tipo === 'Saída') !== saida) {
    return { ignorar: false, categoria: '', aviso: `regra "${regra.categoria}" é de ${cat.tipo.toLowerCase()}, mas a transação é ${saida ? 'saída' : 'entrada'}` };
  }
  return { ignorar: false, categoria: cat.nome };
}

/** ID estável: o FITID do banco quando existe; senão um hash dos dados + a ocorrência no arquivo (duas compras iguais no mesmo dia). */
export function idDe(t: Transacao, conta: string, ocorrencia: number): string {
  const base = t.idBanco ? `${conta}|fitid|${t.idBanco}` : `${conta}|${t.data}|${t.valor.toFixed(2)}|${normalizar(t.descricao)}|${ocorrencia}`;
  return `${t.valor < 0 ? 'S' : 'E'}-${createHash('sha256').update(base).digest('hex').slice(0, 16)}`;
}

export type Resultado = {
  novos: Lancamento[];
  duplicados: number;
  ignorados: number;
  avisos: string[];
};

export function importar(existentes: Lancamento[], transacoes: Transacao[], conta: string, regras: Regra[], categorias: Categoria[]): Resultado {
  const ids = new Set(existentes.map((l) => l.id).filter(Boolean));
  const vistos = new Map<string, number>();
  const r: Resultado = { novos: [], duplicados: 0, ignorados: 0, avisos: [] };
  for (const t of transacoes) {
    const chave = `${t.data}|${t.valor.toFixed(2)}|${normalizar(t.descricao)}`;
    const ocorrencia = vistos.get(chave) ?? 0;
    vistos.set(chave, ocorrencia + 1);
    if (t.valor === 0) {
      r.ignorados++;
      continue;
    }
    const id = idDe(t, conta, ocorrencia);
    if (ids.has(id)) {
      r.duplicados++;
      continue;
    }
    const c = classificar(t.descricao, t.valor < 0, conta, regras, categorias);
    if (c.ignorar) {
      r.ignorados++;
      continue;
    }
    if (c.aviso) r.avisos.push(`${t.data} ${t.descricao} (${t.valor.toFixed(2)}): ${c.aviso}`);
    ids.add(id);
    r.novos.push({ data: t.data, conta, categoria: c.categoria, descricao: t.descricao, valor: Math.abs(t.valor), id });
  }
  return r;
}

/** Preenche a categoria dos lançamentos importados que ainda estão em branco, com as regras atuais. Devolve quantos preencheu. */
export function reclassificar(lancamentos: Lancamento[], regras: Regra[], categorias: Categoria[]): number {
  let n = 0;
  for (const l of lancamentos) {
    if (l.categoria !== '' || !/^[ES]-/.test(l.id)) continue;
    const c = classificar(l.descricao, l.id.startsWith('S-'), l.conta, regras, categorias);
    if (!c.ignorar && c.categoria !== '') {
      l.categoria = c.categoria;
      n++;
    }
  }
  return n;
}
