/** Uma transação como veio do extrato: valor com sinal (negativo = saída). */
export type Transacao = {
  data: string; // AAAA-MM-DD
  valor: number;
  descricao: string;
  /** Identificador do banco (FITID no OFX), quando existe. */
  idBanco?: string;
};

/** Decodifica o arquivo respeitando o CHARSET do cabeçalho OFX; bancos brasileiros costumam usar 1252. */
export function decodificarOfx(bytes: Uint8Array): string {
  const cabecalho = new TextDecoder('latin1').decode(bytes.subarray(0, 600));
  const xml = /encoding="([^"]+)"/i.exec(cabecalho)?.[1];
  const sgml = /CHARSET:\s*(\S+)/i.exec(cabecalho)?.[1];
  const charset = (xml ?? (sgml && /^\d+$/.test(sgml) ? `windows-${sgml}` : sgml) ?? 'utf-8').toLowerCase();
  // Cabeçalho mentiroso é comum (diz 1252 e manda UTF-8). Texto 1252 com acento quase nunca é UTF-8 válido,
  // então UTF-8 estrito vem primeiro; 1252 decodifica qualquer byte e por isso não serve de teste.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder(charset === 'none' || charset === 'utf-8' ? 'windows-1252' : charset).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes); // rótulo desconhecido (ex.: USASCII)
    }
  }
}

/** Valor de uma tag no OFX 1.x (SGML, sem fechamento) ou 2.x (XML). */
function tag(bloco: string, nome: string): string | undefined {
  const m = new RegExp(`<${nome}>([^<\\r\\n]*)`, 'i').exec(bloco);
  const v = m?.[1]?.trim();
  return v ? decodificarEntidades(v) : undefined;
}

function decodificarEntidades(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** OFX usa ponto decimal pela especificação, mas há bancos que mandam vírgula. */
function numeroOfx(s: string): number {
  const limpo = s.replace(/\s/g, '');
  const n = Number(limpo.includes(',') && !limpo.includes('.') ? limpo.replace(',', '.') : limpo.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error(`Valor inválido no OFX: "${s}"`);
  return n;
}

function dataOfx(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (!m) throw new Error(`Data inválida no OFX: "${s}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function lerOfx(texto: string): Transacao[] {
  const blocos = texto.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0] ?? b);
  if (blocos.length === 0 && !/<OFX>/i.test(texto)) throw new Error('Arquivo não parece OFX: não há tag <OFX>.');
  return blocos.map((b, i) => {
    const valor = tag(b, 'TRNAMT');
    const data = tag(b, 'DTPOSTED');
    if (valor === undefined || data === undefined) throw new Error(`Transação ${i + 1} do OFX sem TRNAMT ou DTPOSTED.`);
    const descricao = [tag(b, 'NAME'), tag(b, 'MEMO')].filter((v, j, a) => v && a.indexOf(v) === j).join(' - ');
    return { data: dataOfx(data), valor: numeroOfx(valor), descricao: descricao || '(sem descrição)', idBanco: tag(b, 'FITID') };
  });
}
