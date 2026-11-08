# assistente-financeiro

CLI de controle financeiro PF + PJ sobre um MySQL local. Você lança as movimentações ou importa o extrato que baixou do seu banco (OFX ou CSV), e o assistente classifica cada lançamento por regras simples. Tudo roda na sua máquina: nada acessa o seu banco nem pede senha dele.

O `resumo` mostra, por mês, o que entrou, o que saiu e por quê (Essencial, Escolha, Imposto, Dívida, Poupança, Investimento), separado em PJ e PF, além de orçamento, saldo das contas, dívidas (ordem de quitação avalanche) e reserva de emergência. O módulo de [FIIs](#fiis) diz em quais fundos imobiliários pôr o aporte do mês.

## Uso

Requer Node 24 ou mais recente e um MySQL 8 (local serve); não há etapa de build.

```bash
npm install
cp config.example.json config.json   # URL do MySQL
cp regras.example.json regras.json   # opcional: regras iniciais, importadas pelo nova
node src/main.ts nova                # cria o database, as tabelas e as categorias padrão
```

O `config.json` tem só a URL do banco, `mysql://usuario:senha@host:porta/database`, com caracteres especiais da senha codificados (`@` = `%40`). Ele, os `*.json` de dados e os extratos ficam fora do git.

Cadastre a família (veja [Família](#família)) e use:

```bash
node src/main.ts lancar 10/11 45,90 "iFood" --conta "Cartão Ana" --categoria restaurantes
node src/main.ts importar extratos/2026-11.ofx --conta "Conta Ana" --simular   # sem --simular, grava
node src/main.ts regra "BAR DO ZE" "Lazer"   # cria a regra e classifica o que estava em branco
node src/main.ts atualizar                   # reaplica as regras depois de editar a tabela regras
node src/main.ts resumo 2026-11              # mês da família (sem mês: o atual)
node src/main.ts resumo --pessoa Ana         # só as contas da Ana
```

Depois de cada importação, o assistente lista as descrições que ficaram sem categoria: crie uma regra ou preencha `lancamentos.categoria` no banco. Reimportar um período não duplica nada, porque cada transação tem um ID único (`lancamentos.id_transacao`).

## Família

Um database por família: quem tem acesso vê tudo de todos. A tabela `pessoas` diz de quem é cada coisa, e o `resumo` mostra a família inteira ou, com `--pessoa`, uma pessoa só.

```sql
INSERT INTO pessoas (apelido, nome) VALUES ('Ana', 'Ana Souza'), ('Beto', 'Roberto Souza');
INSERT INTO titulares (apelido, escopo, nome, documento, pessoa) VALUES
  ('Ana', 'PF', 'Ana Souza', NULL, 'Ana'),
  ('Ana ME', 'PJ', 'Ana Souza Tecnologia', NULL, 'Ana');
INSERT INTO contas (nome, titular, banco, tipo) VALUES
  ('Conta Ana', 'Ana', 'Banco X', 'Conta'),
  ('Cartão Ana', 'Ana', 'Banco X', 'Cartão');
```

- **Dono**: o lançamento é da pessoa do titular da conta (a PJ é de quem é sócio). Dívidas (`pessoa` NULL = da família), fechamentos mensais e carteira de FIIs têm a pessoa direto.
- **Compartilhado**: categorias, orçamento e regras valem para todos.
- **Nuvem**: o mesmo esquema roda num MySQL gerenciado; troque a URL e crie um usuário MySQL por pessoa.

## Lançamento manual

`lancar <data> <valor> "<descrição>" --conta "<conta>"`:

- **Data**: `DD/MM` (ano atual), `DD/MM/AAAA` ou `AAAA-MM-DD`. **Valor**: positivo, vírgula nos centavos (`45,90`, `1.234,56`).
- **Sentido**: vem da `--categoria` (nome ou trecho único). Sem categoria, é saída (ou entrada com `--entrada`) e as regras tentam classificar.
- **Repetido**: a mesma data, conta, valor e descrição é recusada; use `--repetir` para outro gasto igual. `--simular` mostra sem gravar.
- **Não misture** lançamento manual e importação na mesma conta e período: o manual não tem o ID do extrato, então a importação duplicaria.
- **Saldo**: só bate com o do banco se todas as movimentações desde `contas.data_saldo` forem lançadas. No cartão, lance as compras; o pagamento da fatura entra só na conta, em "Pagamento fatura cartão".

## Extratos

Baixe o extrato no app ou no internet banking do seu banco. **OFX** funciona com qualquer banco, sem configuração. **CSV** varia de banco para banco, então a conta precisa de um perfil: um pronto (`contas.perfil`, os de [`src/perfis.ts`](src/perfis.ts)) ou o seu, em `contas.perfil_csv`:

```sql
UPDATE contas SET perfil_csv = '{"separador": ";", "decimal": ",", "formatoData": "DD/MM/AAAA", "pularLinhas": 0,
  "colunas": {"data": "Data", "descricao": "Histórico", "valor": "Valor", "id": "Documento"}, "inverterSinal": false}'
WHERE nome = 'Conta Ana';
```

Use `valor` (com sinal, negativo = saída) ou o par `entrada`/`saida`. `inverterSinal` serve para faturas de cartão que listam compras como valores positivos. Perfis de outros bancos são bem-vindos em `src/perfis.ts`.

## Regras

Ficam na tabela `regras`. `regra "<trecho>" "<categoria>"` acrescenta uma no fim; para mudar a ordem ou apagar, edite por SQL e rode `atualizar`.

```sql
INSERT INTO regras (ordem, contem, conta, categoria, ignorar) VALUES
  (10, 'Pagamento recebido', NULL, NULL, TRUE),
  (20, 'Pagamento de fatura', 'Conta Ana', 'PF - Pagamento fatura cartão', FALSE),
  (30, 'IFOOD', NULL, 'PF - Restaurantes e delivery', FALSE);
```

1. **Casamento**: `contem` é um trecho da descrição, sem diferenciar acento nem maiúscula.
2. **Ordem**: a primeira que casa (menor `ordem`) vence. Ponha as específicas antes das genéricas (`AMAZON WEB SERVICES` antes de `AMAZON`).
3. **Conta**: `conta` limita a regra a uma conta, para quando o mesmo texto significa coisas diferentes na PF e na PJ.
4. **Ignorar**: descarta a transação. Use no "Pagamento recebido" da fatura, espelho do pagamento já lançado na conta.
5. **Sinal**: categoria de Saída numa entrada (um estorno) deixa o lançamento sem categoria, com aviso.

A categoria precisa existir na tabela `categorias`. No `regras.example.json`, troque `SEU NOME COMPLETO` e `SUA EMPRESA LTDA` pelos nomes das transferências de pró-labore.

## O banco

O esquema está em [`migrations/`](migrations/), um arquivo SQL por versão (`001_inicial.sql`, `002_familia.sql`…). O `nova` aplica as que ainda não constam em `schema_migrations` e nunca apaga dados; rode de novo depois de atualizar o assistente (banco de versão anterior com mais de uma pessoa: `nova --pessoa <apelido>` diz de quem são os dados antigos). O que o CLI não cobre, edite por SQL (Workbench, DBeaver ou o cliente `mysql`).

Para mudar o esquema, crie a próxima migration (`003_<assunto>.sql`) e nunca edite uma publicada. O MySQL não desfaz DDL, então ponha primeiro o comando que pode falhar e explique no topo do arquivo como seguir se ele falhar.

```mermaid
erDiagram
  pessoas ||--o{ titulares : "é dona de"
  pessoas ||--o{ fiis : carteira
  pessoas ||--o{ patrimonio : fechamentos
  pessoas |o--o{ dividas : deve
  titulares ||--o{ contas : tem
  contas ||--o{ cartoes : "cartões físicos e virtuais"
  contas ||--o{ lancamentos : ""
  categorias |o--o{ lancamentos : classifica
  contas |o--o{ regras : "limita a"
  categorias |o--o{ regras : "aplica"
```

| Tabela | O que guarda |
|---|---|
| `lancamentos` | Uma transação: `data`, `conta`, `categoria` (NULL = falta classificar), `descricao`, `valor` (sempre positivo), `sentido` (Entrada/Saída), `id_transacao` (NULL no manual) |
| `categorias` | `nome`, `escopo` (PF/PJ), `tipo` (Entrada/Saída), `motivo` e `planejado` (orçamento mensal) |
| `pessoas` | `apelido`, `nome`, `custo_vida` e `meta_meses` da reserva, e os parâmetros dos [FIIs](#fiis) |
| `titulares` | Dono de cada conta: `apelido`, `escopo`, `nome`, `documento` (CPF/CNPJ só dígitos), `pessoa` |
| `contas` | `nome`, `tipo` (Conta/Cartão), `titular`, `banco`, perfil do CSV, `saldo_inicial` + `data_saldo` (saldo no fim desse dia) e, no cartão, `limite_total` |
| `cartoes` | Cartões físicos e virtuais de uma conta de cartão (`final`, `nome`, `tipo`, `variante`), só cadastro |
| `regras` | Classificação automática ([Regras](#regras)) |
| `fiis` | Carteira de cada pessoa: `ticker`, `peso`, `cotas` |
| `dividas` | Uma linha por dívida; atualize `saldo` no fechamento. `juros_mes` em fração (12% a.m. = 0.12) |
| `patrimonio` | Fechamento mensal por pessoa (`mes` = dia 1): contas PF/PJ, reserva, FIIs, outros, dívidas |

Views, todas com a coluna `pessoa`: `vw_lancamentos` (lançamento com escopo, motivo e mês), `vw_saldos` (`saldo_inicial` + lançamentos depois de `data_saldo`) e `vw_cartoes` (limite disponível = `limite_total` − compras lançadas, inclusive parcelas futuras, + faturas pagas).

Como lançar sem contar nada duas vezes:

- **Cartão**: a compra entra no cartão, na categoria real; o pagamento da fatura sai da conta em "Pagamento fatura cartão", uma Transferência, que não conta como gasto.
- **Pró-labore**: sai na PJ como "PJ - Pró-labore / lucros pagos" e entra na PF como "PF - Pró-labore / lucros recebidos".
- **Motivo**: Essencial = custo para viver/operar; Escolha = dá para cortar; Imposto; Dívida = parcela/juros; Poupança = reserva e fundos; Investimento = FIIs; Transferência = entre suas próprias contas.

## FIIs

`node src/main.ts fiis` sugere em quais FIIs pôr o aporte do mês, para uma carteira de longo prazo focada em renda mensal. Nunca sugere venda: o rebalanceamento é só pelos aportes. Com mais de uma pessoa na família, passe `--pessoa`.

```bash
node src/main.ts fiis                   # usa o aporte_fii da pessoa
node src/main.ts fiis 1500 --pessoa Ana # aporte deste mês
```

```sql
INSERT INTO fiis (pessoa, ticker, peso, cotas) VALUES ('Ana', 'MXRF11', 1, 0), ('Ana', 'HGLG11', 2, 0);
UPDATE fiis SET cotas = cotas + 11 WHERE pessoa = 'Ana' AND ticker = 'MXRF11'; -- depois de comprar
```

| Coluna | O que é |
|---|---|
| `pessoas.aporte_fii` | Aporte mensal padrão em R$ |
| `pessoas.dy_minimo` | DY anual mínimo para comprar (`0.1` = 10%); define o preço teto |
| `pessoas.meses_minimos` | Meses com provento nos últimos 12 para poder comprar (`11` tolera um provento na borda da janela) |
| `pessoas.renda_alvo` | Opcional: renda mensal desejada, em R$ |
| `fiis.peso` | Peso relativo (`1` para todos = pesos iguais; `2` = o dobro; `0` = não compra mais) |
| `fiis.cotas` | Cotas que a pessoa já tem |

1. **Dados**: cotação e proventos dos últimos 12 meses vêm do Yahoo Finance, sem chave.
2. **Filtro**: o FII só entra se pagou provento em pelo menos `meses_minimos` meses e o preço está até o **preço teto de Bazin** (`proventos 12m / dy_minimo`).
3. **Aporte**: compra uma cota por vez do FII elegível mais abaixo da meta pelo peso, até o dinheiro não pagar mais nenhuma. A sobra fica para o mês seguinte.
4. **Saída**: as compras, a renda mensal estimada, o **número mágico** de cada FII (quantas cotas fazem o provento do mês comprar uma cota nova) e o progresso até a `renda_alvo`.

Os FIIs dos exemplos só mostram o formato, não são recomendação. Proventos passados não garantem os futuros.

## Checks

```bash
node --test                          # testes (os de MySQL rodam com TEST_MYSQL_URL)
node node_modules/typescript/bin/tsc # type-check
```

## Licença

[MIT](LICENSE)
