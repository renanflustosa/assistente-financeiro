# assistente-financeiro

CLI que importa extratos bancários (OFX ou CSV) para um banco MySQL de controle financeiro PF + PJ e classifica cada lançamento por regras simples. Tudo roda na sua máquina, sem acessar banco nem passar senha a terceiros: você baixa o extrato no app do banco e o assistente faz o resto.

O `resumo` mostra, por mês, o que entrou, o que saiu e por quê (Essencial, Escolha, Imposto, Dívida, Poupança, Investimento), separado em PJ e PF, além de orçamento, saldo das contas, dívidas (ordem de quitação avalanche) e reserva de emergência.

O módulo de [FIIs](#fiis) diz em quais fundos imobiliários pôr o aporte do mês, para uma carteira de renda mensal.

## Uso

Requer Node 24 ou mais recente e um MySQL 8 (local serve); não há etapa de build.

```bash
npm install
cp config.example.json config.json    # só a URL do MySQL
cp regras.example.json regras.json    # regras iniciais; ajuste as suas antes do nova
node src/main.ts nova                 # cria o database, as tabelas e as categorias padrão e importa o regras.json
node src/main.ts importar extratos/nubank-pf-2026-11.csv --conta "Nubank PF"
node src/main.ts importar extratos/fatura-2026-11.csv --conta "Nubank PF Cartão" --simular
node src/main.ts lancar 10/11 45,90 "iFood" --conta "Nubank PF Cartão" --categoria restaurantes
node src/main.ts regra "BAR DO ZE" "Lazer"   # cria a regra e já classifica o que estava em branco
node src/main.ts atualizar            # reaplica as regras depois de editar a tabela regras
node src/main.ts resumo 2026-11       # resumo do mês da família (sem mês: o atual)
node src/main.ts resumo --pessoa Ana  # só as contas da Ana
```

Antes de importar ou lançar, cadastre a família no banco (veja [Família](#família)): as pessoas, os titulares e as contas.

Depois de cada importação, o assistente lista as descrições que ficaram sem categoria. Crie uma regra para elas ou preencha `lancamentos.categoria` direto no banco.

Reimportar o mesmo extrato, ou um período que se sobrepõe, não duplica nada: cada transação ganha um ID (`lancamentos.id_transacao`, único), feito do identificador do banco ou de um hash da data, do valor e da descrição.

`config.json` (a senha do MySQL), `regras.json`, `carteira.json` e os extratos ficam fora do git porque guardam os seus dados reais. Depois do `nova`, os dados ficam no banco e os dois JSON podem ser apagados.

## Família

Um database por família: quem tem acesso a ele vê tudo de todos. A tabela `pessoas` diz de quem é cada coisa, e o `resumo` mostra a família inteira ou, com `--pessoa`, uma pessoa só.

```sql
INSERT INTO pessoas (apelido, nome) VALUES ('Ana', 'Ana Souza'), ('Beto', 'Roberto Souza');
INSERT INTO titulares (apelido, escopo, nome, documento, pessoa) VALUES
  ('Ana', 'PF', 'Ana Souza', NULL, 'Ana'),
  ('Ana ME', 'PJ', 'Ana Souza Tecnologia', NULL, 'Ana');
INSERT INTO contas (nome, titular, banco, tipo, perfil) VALUES
  ('Nubank Ana', 'Ana', 'Nubank', 'Conta', 'nubank-conta'),
  ('Nubank Ana Cartão', 'Ana', 'Nubank', 'Cartão', 'nubank-cartao');
```

- **Dono**: o lançamento é da pessoa do titular da conta (a PJ é de quem é sócio). Dívidas (`dividas.pessoa`, NULL = da família), fechamentos (`patrimonio`), reserva e carteira de FIIs têm a pessoa direto.
- **Compartilhado**: categorias, orçamento (`categorias.planejado`, só na visão da família) e regras valem para todos.
- **Nuvem**: o mesmo esquema roda num MySQL gerenciado; troque a URL do `config.json` e crie um usuário MySQL por pessoa com acesso ao database. Como todos veem tudo, não há filtro por linha a configurar.

Bancos criados antes de 2026-11 (contas no `config.json`, `parametros` sem dono): o `nova` aplica a `migrations/002_familia.sql`, passa contas, regras e carteira para o banco e diz o que falta. Se o banco tiver uma pessoa só, carteira e parâmetros vão para ela; com mais de uma, rode `nova --pessoa <apelido>`.

## Lançamento manual

Sem extrato, lance cada movimentação com `lancar <data> <valor> "<descrição>" --conta "<conta>"`:

- **Data**: `DD/MM` (ano atual), `DD/MM/AAAA` ou `AAAA-MM-DD`. **Valor**: positivo, vírgula nos centavos (`45,90`, `1.234,56`).
- **Sentido**: vem da `--categoria` (nome ou trecho único). Sem categoria, é saída, ou entrada com `--entrada`, e as regras da tabela `regras` tentam classificar.
- **Repetido**: lançamento com a mesma data, conta, valor e descrição é recusado; use `--repetir` quando for outro gasto igual. `--simular` mostra sem gravar.
- **Não misture com importação na mesma conta e período**: o lançamento manual não tem o ID do extrato, então importar o CSV daquele período duplica tudo.
- **Saldo**: só bate com o do app se todas as movimentações da conta desde `data_saldo` forem lançadas (Pix, tarifas, rendimentos). No cartão, lance as compras; o pagamento da fatura entra só na conta, em "Pagamento fatura cartão".

## Como baixar o extrato (Nubank)

- **Conta (PF ou PJ)**: no app, Extrato, ícone de exportar, CSV. Colunas `Data,Valor,Identificador,Descrição`.
- **Cartão**: no app, Cartão, Faturas, escolha a fatura, Exportar fatura, CSV. Colunas `date,title,amount`.

Outros bancos: OFX funciona sem configuração. Para CSV, declare um perfil (abaixo).

## config.json

| Campo | O que é |
|---|---|
| `mysql` | URL do banco: `mysql://usuario:senha@host:porta/database`. Caracteres especiais da senha vão codificados (`@` = `%40`). O `nova` cria o database se o usuário tiver permissão |
É o único campo: contas, regras e carteira ficam no banco.

## Perfil do CSV

`contas.perfil` diz como ler o CSV da conta: `nubank-conta` ou `nubank-cartao`. Opcional para OFX. Outro banco: deixe `perfil` NULL e ponha o perfil próprio em `contas.perfil_csv`:

```sql
UPDATE contas SET perfil_csv = '{"separador": ";", "decimal": ",", "formatoData": "DD/MM/AAAA", "pularLinhas": 0,
  "colunas": {"data": "Data", "descricao": "Histórico", "valor": "Valor", "id": "Documento"}, "inverterSinal": false}'
WHERE nome = 'Banco X';
```

Use `valor` (com sinal, negativo = saída) ou o par `entrada`/`saida`. `inverterSinal` serve para faturas de cartão, que listam compras como valores positivos. Contribuições com perfis de outros bancos são bem-vindas em `src/perfis.ts`.

## Regras

Ficam na tabela `regras`, uma linha por trecho. `node src/main.ts regra "<trecho>" "<categoria>"` acrescenta uma no fim; para mudar a ordem ou apagar, edite por SQL e rode `atualizar`.

```sql
INSERT INTO regras (ordem, contem, conta, categoria, ignorar) VALUES
  (10, 'Pagamento recebido', NULL, NULL, TRUE),
  (20, 'Pagamento de fatura', 'Nubank PF', 'PF - Pagamento fatura cartão', FALSE),
  (30, 'IFOOD', NULL, 'PF - Restaurantes e delivery', FALSE);
```

O `regras.json` (formato do `regras.example.json`, com `contem` podendo ser uma lista de trechos) é importado pelo `nova` só enquanto a tabela está vazia.

1. **Casamento**: `contem` é um trecho procurado na descrição, sem diferenciar acento nem maiúscula.
2. **Ordem**: vale a menor `ordem`; a primeira regra que casa vence. Ponha as específicas antes das genéricas (ex.: `AMAZON WEB SERVICES` antes de `AMAZON`).
3. **Conta**: `conta` limita a regra a uma conta, útil quando o mesmo texto significa coisas diferentes na PF e na PJ.
4. **Ignorar**: `ignorar: true` descarta a transação. Use no "Pagamento recebido" da fatura, que é o espelho do pagamento já lançado na conta.
5. **Sinal**: se a categoria é de Saída e a transação é uma entrada (um estorno, por exemplo), ela fica sem categoria e o assistente avisa.

As categorias são as da tabela `categorias`; o assistente recusa uma regra com categoria que não existe lá. No `regras.example.json`, troque `SEU NOME COMPLETO` e `SUA EMPRESA LTDA` pelos nomes que aparecem nas transferências de pró-labore.

## O banco

O esquema está em [`migrations/`](migrations/), um arquivo SQL por versão (`001_inicial.sql`, `002_familia.sql`…). `node src/main.ts nova` aplica, em ordem, as que ainda não constam na tabela `schema_migrations` e nunca apaga dados; rode de novo depois de atualizar o assistente. O que o CLI não cobre, edite por SQL (MySQL Workbench, DBeaver ou o cliente `mysql`).

Para mudar o esquema, crie a próxima migration (`003_<assunto>.sql`) com `ALTER`/`CREATE` e nunca edite uma que já foi publicada: bancos que já a aplicaram não rodam de novo. O MySQL não desfaz DDL em transação, então ponha primeiro o comando que pode falhar e explique no topo do arquivo como seguir se ele falhar.

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
| `lancamentos` | Um por transação: `data`, `conta`, `categoria` (NULL = falta classificar), `descricao`, `valor` (sempre positivo), `sentido` (Entrada/Saída), `id_transacao`. Lançamento manual: `id_transacao` NULL |
| `categorias` | `nome`, `escopo` (PF/PJ), `tipo` (Entrada/Saída), `motivo` e `planejado` (orçamento mensal). Crie as suas com INSERT |
| `pessoas` | A família: `apelido`, `nome`, `custo_vida` mensal PF e `meta_meses` da reserva, e os parâmetros dos FIIs (`aporte_fii`, `dy_minimo`, `meses_minimos`, `renda_alvo`) |
| `contas` | `nome` (até 60 caracteres), `tipo` (Conta/Cartão), `titular`, `banco`, `perfil`/`perfil_csv`, `saldo_inicial` + `data_saldo` (saldo no fim desse dia) e, no cartão, `limite_total` (o limite total do app; o disponível é calculado) |
| `titulares` | Quem é o dono de cada conta: `apelido`, `escopo`, `nome`, `documento` (CPF/CNPJ só dígitos) e a `pessoa` |
| `regras` | Classificação automática (veja [Regras](#regras)) |
| `fiis` | Carteira de cada pessoa: `ticker`, `peso`, `cotas` |
| `cartoes` | Cartões físicos e virtuais de cada conta de cartão (`final`, `nome`, `tipo` Físico/Virtual, `variante`). Só cadastro: a fatura do Nubank não diz qual cartão fez a compra |
| `dividas` | Uma linha por dívida; atualize `saldo` no fechamento do mês. `juros_mes` em fração (12% a.m. = 0.12). `pessoa` NULL = da família |
| `patrimonio` | Fechamento mensal por pessoa (`pessoa`, `mes` = dia 1): contas PF/PJ, reserva, FIIs, outros, dívidas |

Views para consulta, todas com a coluna `pessoa`: `vw_lancamentos` (lançamento + escopo, motivo e mês), `vw_saldos` (saldo atual = `saldo_inicial` + lançamentos depois de `data_saldo`) e `vw_cartoes` (limite disponível = `limite_total` − compras lançadas no cartão, inclusive parcelas futuras, + faturas pagas pelas contas do mesmo titular; supõe o cartão sem nada em aberto antes do primeiro lançamento). O saldo só bate com o do app se todo extrato da conta desde `data_saldo` foi importado e nenhuma regra `ignorar` descarta transações dessa conta.

Regras de lançamento:

- **Cartão**: compras entram pela fatura, na categoria real; o pagamento da fatura no extrato da conta vai em "Pagamento fatura cartão", que é uma Transferência e não conta como gasto. Assim nada é contado duas vezes.
- **Pró-labore**: sai na PJ como "PJ - Pró-labore / lucros pagos" e entra na PF como "PF - Pró-labore / lucros recebidos".
- **Motivo**: Essencial = custo para viver/operar; Escolha = dá para cortar; Imposto; Dívida = parcela/juros; Poupança = reserva e fundos; Investimento = FIIs; Transferência = dinheiro entre suas próprias contas.

## FIIs

`node src/main.ts fiis` sugere em quais FIIs pôr o aporte do mês, para uma carteira de longo prazo focada em renda mensal. Ele nunca sugere venda: o rebalanceamento acontece só pelos aportes. A carteira é de uma pessoa: com mais de uma na família, passe `--pessoa`.

```bash
node src/main.ts fiis                  # usa o aporte_fii da pessoa
node src/main.ts fiis 1500 --pessoa Ana # aporte deste mês
```

```sql
INSERT INTO fiis (pessoa, ticker, peso, cotas) VALUES ('Ana', 'MXRF11', 1, 0), ('Ana', 'HGLG11', 2, 0);
UPDATE fiis SET cotas = cotas + 11 WHERE pessoa = 'Ana' AND ticker = 'MXRF11'; -- depois de comprar
```

| Coluna | O que é |
|---|---|
| `pessoas.aporte_fii` | Valor padrão do aporte mensal em R$ |
| `pessoas.dy_minimo` | DY anual mínimo para comprar (`0.1` = 10%). Define o preço teto |
| `pessoas.meses_minimos` | Meses com provento nos últimos 12 para o FII poder ser comprado (`11` tolera um provento com data-com na borda da janela) |
| `pessoas.renda_alvo` | Opcional: renda mensal desejada na aposentadoria, em R$ |
| `fiis.ticker` | Código na B3, ex.: `MXRF11` |
| `fiis.peso` | Peso relativo na carteira (`1` para todos = pesos iguais; `2` = o dobro) |
| `fiis.cotas` | Cotas que a pessoa já tem |

Um `carteira.json` no formato do `carteira.example.json` é importado pelo `nova` para a pessoa que ainda não tem FIIs. Os FIIs dos exemplos servem só para mostrar o formato; não são recomendação.

1. **Dados**: cotação e proventos dos últimos 12 meses vêm do Yahoo Finance, que não pede chave.
2. **Filtro**: um FII só entra no aporte se pagou provento em pelo menos `mesesMinimos` meses e se o preço está até o **preço teto de Bazin** (`proventos 12m / dyMinimo`). Acima do teto, o DY fica abaixo do mínimo e vale esperar o preço cair.
3. **Aporte**: compra uma cota por vez do FII elegível mais abaixo da meta, proporcionalmente ao peso, até o dinheiro não pagar mais nenhuma cota. O que sobrar fica para o próximo mês.
4. **Saída**: além das compras, mostra a renda mensal estimada (média dos últimos 12 meses), o **número mágico** de cada FII (a partir de quantas cotas o provento do mês compra uma cota nova) e o progresso até a `rendaAlvo`.

Proventos passados não garantem os futuros. A escolha dos FIIs e dos pesos continua sendo sua; a ferramenta só automatiza a decisão de cada mês.

## Checks

```bash
node --test                          # testes (extratos, regras, resumo, FIIs; MySQL com TEST_MYSQL_URL)
node node_modules/typescript/bin/tsc # type-check
```

## Licença

[MIT](LICENSE)
