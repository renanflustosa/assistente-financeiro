import type { Categoria } from './regras.ts';

export const MOTIVOS = ['Receita', 'Essencial', 'Escolha', 'Imposto', 'Dívida', 'Poupança', 'Investimento', 'Transferência'];
export const TIPOS_DIVIDA = ['Cartão (rotativo)', 'Cheque especial', 'Empréstimo pessoal', 'Financiamento', 'Parcelamento', 'Outro'];

const c = (nome: string, escopo: 'PF' | 'PJ', tipo: 'Entrada' | 'Saída', motivo: string): Categoria => ({ nome, escopo, tipo, motivo });

/** Inseridas pelo `nova` quando a tabela categorias ainda não as tem; depois disso a tabela é a fonte. */
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
