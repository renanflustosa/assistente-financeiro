# Checklist de produção

Minimalista (80/20). `[x]` feito, `[ ]` lacuna, `n/a` não se aplica. Não há LLM no fluxo: os itens de IA ficam de fora.

## 1. Problema e requisitos

- [x] Problema, usuário e sucesso: importar extratos Nubank (PF/PJ, conta e cartão) para o MySQL sem duplicar e com classificação por regra; sugerir o aporte mensal em FIIs rumo à `rendaAlvo` ([README](README.md)).
- n/a Orçamento de latência e custo: CLI local, sem serviço pago nem SLA; Yahoo Finance não cobra nem pede chave.
- [x] Dados e aprovação humana: dados pessoais fora do git (`.gitignore`); `--simular` mostra a importação antes de gravar; categoria em branco fica para o usuário decidir; `fiis` só sugere, a compra é do usuário.

## 2. Contexto e ferramentas

- [x] Só dependências necessárias: `mysql2`; FIIs usa `fetch` nativo.

## 3. Evals e proteções

- [x] Testes representativos: `test/extratos.test.ts`, `test/regras.test.ts`, `test/resumo.test.ts`, `test/fiis.test.ts`, `test/banco.test.ts` (`node --test`; o de MySQL roda com `TEST_MYSQL_URL` num database `_teste` descartável).
- [x] Sem vazamento: `config.json`, `regras.json`, `carteira.json` e extratos no `.gitignore`; a senha do MySQL fica só no `config.json`, e o erro de conexão mostra o host, nunca a URL (`test/banco.test.ts`).
- [x] Fallback: formato desconhecido ou campo faltando falha com erro acionável; transação sem regra fica sem categoria e é listada; ticker inexistente, HTTP com erro ou cotação ausente falham com erro que nomeia o ticker (`src/fiis/yahoo.ts`).

## 4. Confiabilidade e observabilidade

- [x] Entrada validada: OFX/CSV, `config.json`, regras e carteira (do banco ou dos JSON importados pelo `nova`), `contas.perfil_csv` e o valor do aporte validados com mensagem por campo (`src/ofx.ts`, `src/regras.ts`, `src/main.ts`, `src/fiis/aporte.ts`); resposta do Yahoo checada antes do uso.
- [x] Escrita segura: a importação grava todos os arquivos num INSERT só e a reclassificação numa transação (`src/banco.ts`); reimportação idempotente pelo ID da transação, com `UNIQUE` em `lancamentos.id_transacao`; o `nova` só aplica as migrations que faltam (`migrations/`, registradas em `schema_migrations`; banco antigo e banco novo cobertos em `test/banco.test.ts`).
- [x] Timeout: 15 s por requisição ao Yahoo (`src/fiis/yahoo.ts`); o resto não usa rede.
- [ ] Retry: uma falha transitória do Yahoo aborta o `fiis`; avaliar 1 retry com backoff só se acontecer na prática.
- [ ] Falha real vira teste: extrato ou resposta do Yahoo que quebrar o fluxo entra anonimizado em `test/` com o fix.

## 5. Custo e desempenho

- n/a Baseline, cache e roteamento: execução local em segundos e poucas requisições por mês; otimizar só se um extrato real ficar lento.
