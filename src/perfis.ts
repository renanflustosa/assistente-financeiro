import type { PerfilCsv } from './csv.ts';

/**
 * Perfis prontos de CSV por banco. Se o seu banco mudar o formato (ou não estiver aqui),
 * declare o perfil direto em contas.perfil_csv. Contribuições com novos bancos são bem-vindas.
 */
export const PERFIS: Record<string, PerfilCsv> = {
  // Extrato da conta (PF e PJ): "Data,Valor,Identificador,Descrição", valor com sinal e ponto decimal.
  'nubank-conta': {
    separador: ',',
    decimal: '.',
    formatoData: 'DD/MM/AAAA',
    colunas: { data: 'Data', valor: 'Valor', id: 'Identificador', descricao: 'Descrição' },
  },
  // Fatura do cartão: "date,title,amount", compra positiva, pagamento e estorno negativos.
  'nubank-cartao': {
    separador: ',',
    decimal: '.',
    formatoData: 'AAAA-MM-DD',
    colunas: { data: 'date', descricao: 'title', valor: 'amount' },
    inverterSinal: true,
  },
};
