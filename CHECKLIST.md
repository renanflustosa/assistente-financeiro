# Checklist de produção

Minimalista (80/20). `[x]` feito, `[ ]` lacuna, `n/a` não se aplica. Não há LLM no fluxo: os itens de IA ficam de fora.

## 1. Problema e requisitos

- [x] Problema, usuário e sucesso: importar extratos Nubank (PF/PJ, conta e cartão) para a planilha sem duplicar e com classificação por regra ([README](README.md)).
- n/a Orçamento de latência e custo: CLI local, sem serviço pago nem SLA.
- [x] Dados e aprovação humana: dados pessoais fora do git (`.gitignore`); `--simular` mostra a importação antes de gravar; categoria em branco fica para o usuário decidir.

## 2. Contexto e ferramentas

- [x] Só dependências necessárias: `exceljs` e `jszip`.

## 3. Evals e proteções

- [x] Testes representativos: `test/extratos.test.ts`, `test/planilha.test.ts`, `test/regras.test.ts` (`node --test`).
- [x] Sem vazamento: `config.json`, `regras.json`, extratos e `*.xlsx` no `.gitignore`.
- [x] Fallback: formato desconhecido ou campo faltando falha com erro acionável; transação sem regra fica sem categoria e é listada.

## 4. Confiabilidade e observabilidade

- [x] Entrada validada: OFX/CSV, `config.json` e `regras.json` validados com mensagem por campo (`src/ofx.ts`, `src/regras.ts`, `src/main.ts`).
- [x] Escrita segura: grava em arquivo temporário antes de substituir a planilha (`src/planilha.ts`); reimportação idempotente pelo ID da transação.
- n/a Timeouts, retries e rate limits: sem chamadas de rede.
- [ ] Falha real vira teste: extrato que quebrar a importação entra anonimizado em `test/` com o fix.

## 5. Custo e desempenho

- n/a Baseline, cache e roteamento: execução local em segundos; otimizar só se um extrato real ficar lento.
