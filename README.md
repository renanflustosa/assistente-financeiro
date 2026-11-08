# assistente-financeiro

CLI que importa extratos bancários (OFX ou CSV) para um banco MySQL de controle financeiro PF + PJ e classifica cada lançamento por regras simples. Tudo roda na sua máquina, sem acessar banco nem passar senha a terceiros: você baixa o extrato no app do banco e o assistente faz o resto.

O `resumo` mostra, por mês, o que entrou, o que saiu e por quê (Essencial, Escolha, Imposto, Dívida, Poupança, Investimento), separado em PJ e PF, além de orçamento, saldo das contas, dívidas (ordem de quitação avalanche) e reserva de emergência.

O módulo de [FIIs](#fiis) diz em quais fundos imobiliários pôr o aporte do mês, para uma carteira de renda mensal.

## Uso

Requer Node 24 ou mais recente e um MySQL 8 (local serve); não há etapa de build.

```bash
npm install
cp config.example.json config.json    # URL do MySQL e contas
cp regras.example.json regras.json    # regras de classificação; ajuste as suas
node src/main.ts nova                 # cria o database, as tabelas e as categorias padrão
node src/main.ts importar extratos/nubank-pf-2026-11.csv --conta "Nubank PF"
node src/main.ts importar extratos/fatura-2026-11.csv --conta "Nubank PF Cartão" --simular
node src/main.ts lancar 10/11 45,90 "iFood" --conta "Nubank PF Cartão" --categoria restaurantes
node src/main.ts regra "BAR DO ZE" "Lazer"   # cria a regra e já classifica o que estava em branco
node src/main.ts atualizar            # reaplica as regras depois de editar o regras.json
node src/main.ts resumo 2026-11       # resumo do mês (sem mês: o atual)
```

Depois de cada importação, o assistente lista as descrições que ficaram sem categoria. Crie uma regra para elas ou preencha `lancamentos.categoria` direto no banco.

Reimportar o mesmo extrato, ou um período que se sobrepõe, não duplica nada: cada transação ganha um ID (`lancamentos.id_transacao`, único), feito do identificador do banco ou de um hash da data, do valor e da descrição.

`config.json`, `regras.json`, `carteira.json` e os extratos ficam fora do git porque guardam os seus dados reais (e o `config.json`, a senha do MySQL).

## Lançamento manual

Sem extrato, lance cada movimentação com `lancar <data> <valor> "<descrição>" --conta "<conta>"`:

- **Data**: `DD/MM` (ano atual), `DD/MM/AAAA` ou `AAAA-MM-DD`. **Valor**: positivo, vírgula nos centavos (`45,90`, `1.234,56`).
- **Sentido**: vem da `--categoria` (nome ou trecho único). Sem categoria, é saída, ou entrada com `--entrada`, e as regras do `regras.json` tentam classificar.
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
| `contas` | Uma entrada por conta; o nome é a chave da tabela `contas` (até 60 caracteres) |
| `contas.<nome>.perfil` | Como ler o CSV dessa conta: `nubank-conta`, `nubank-cartao` ou um perfil próprio. Opcional para OFX. Perfil com `inverterSinal` marca a conta como Cartão |

Perfil próprio de CSV:

```json
"Banco X": {
  "perfil": {
    "separador": ";",
    "decimal": ",",
    "formatoData": "DD/MM/AAAA",
    "pularLinhas": 0,
    "colunas": { "data": "Data", "descricao": "Histórico", "valor": "Valor", "id": "Documento" },
    "inverterSinal": false
  }
}
```

Use `valor` (com sinal, negativo = saída) ou o par `entrada`/`saida`. `inverterSinal` serve para faturas de cartão, que listam compras como valores positivos. Contribuições com perfis de outros bancos são bem-vindas em `src/perfis.ts`.

## regras.json

```json
{ "regras": [
  { "contem": "Pagamento recebido", "ignorar": true },
  { "contem": "Pagamento de fatura", "conta": "Nubank PF", "categoria": "PF - Pagamento fatura cartão" },
  { "contem": ["IFOOD", "RAPPI"], "categoria": "PF - Restaurantes e delivery" }
] }
```

1. **Casamento**: `contem` é um trecho (ou lista de trechos) procurado na descrição, sem diferenciar acento nem maiúscula.
2. **Ordem**: a primeira regra que casa vence. Ponha as específicas antes das genéricas (ex.: `AMAZON WEB SERVICES` antes de `AMAZON`).
3. **Conta**: `conta` limita a regra a uma conta, útil quando o mesmo texto significa coisas diferentes na PF e na PJ.
4. **Ignorar**: `ignorar: true` descarta a transação. Use no "Pagamento recebido" da fatura, que é o espelho do pagamento já lançado na conta.
5. **Sinal**: se a categoria é de Saída e a transação é uma entrada (um estorno, por exemplo), ela fica sem categoria e o assistente avisa.

As categorias são as da tabela `categorias`; o assistente recusa uma regra com categoria que não existe lá. No `regras.example.json`, troque `SEU NOME COMPLETO` e `SUA EMPRESA LTDA` pelos nomes que aparecem nas transferências de pró-labore.

## O banco

`node src/main.ts nova` cria o que falta e nunca apaga dados; rode de novo depois de atualizar o assistente. O que o CLI não cobre, edite por SQL (MySQL Workbench, DBeaver ou o cliente `mysql`).

| Tabela | O que guarda |
|---|---|
| `lancamentos` | Um por transação: `data`, `conta`, `categoria` (NULL = falta classificar), `descricao`, `valor` (sempre positivo), `sentido` (Entrada/Saída), `id_transacao`. Lançamento manual: `id_transacao` NULL |
| `categorias` | `nome`, `escopo` (PF/PJ), `tipo` (Entrada/Saída), `motivo` e `planejado` (orçamento mensal). Crie as suas com INSERT |
| `contas` | Criadas a partir do `config.json`. Preencha `titular`, `banco`, `saldo_inicial` + `data_saldo` (saldo no fim desse dia) e, no cartão, `limite` |
| `titulares` | Quem é o dono de cada conta: `apelido`, `escopo`, `nome`, `documento` (CPF/CNPJ só dígitos) |
| `cartoes` | Cartões físicos e virtuais de cada conta de cartão (`final`, `nome`, `tipo` Físico/Virtual, `variante`). Só cadastro: a fatura do Nubank não diz qual cartão fez a compra |
| `dividas` | Uma linha por dívida; atualize `saldo` no fechamento do mês. `juros_mes` em fração (12% a.m. = 0.12) |
| `patrimonio` | Fechamento mensal (`mes` = dia 1): contas PF/PJ, reserva, FIIs, outros, dívidas |
| `parametros` | `custo_vida` mensal PF e `meta_meses` da reserva |

Views para consulta: `vw_lancamentos` (lançamento + escopo, motivo e mês) e `vw_saldos` (saldo atual = `saldo_inicial` + lançamentos depois de `data_saldo`). O saldo só bate com o do app se todo extrato da conta desde `data_saldo` foi importado e nenhuma regra `ignorar` descarta transações dessa conta.

Regras de lançamento:

- **Cartão**: compras entram pela fatura, na categoria real; o pagamento da fatura no extrato da conta vai em "Pagamento fatura cartão", que é uma Transferência e não conta como gasto. Assim nada é contado duas vezes.
- **Pró-labore**: sai na PJ como "PJ - Pró-labore / lucros pagos" e entra na PF como "PF - Pró-labore / lucros recebidos".
- **Motivo**: Essencial = custo para viver/operar; Escolha = dá para cortar; Imposto; Dívida = parcela/juros; Poupança = reserva e fundos; Investimento = FIIs; Transferência = dinheiro entre suas próprias contas.

## FIIs

`node src/main.ts fiis` sugere em quais FIIs pôr o aporte do mês, para uma carteira de longo prazo focada em renda mensal. Ele nunca sugere venda: o rebalanceamento acontece só pelos aportes. Não precisa do `config.json` nem do MySQL.

```bash
cp carteira.example.json carteira.json # depois preencha com a sua carteira real
node src/main.ts fiis                  # usa o aporte do carteira.json
node src/main.ts fiis 1500             # aporte deste mês
```

Depois de comprar, atualize `cotas` no `carteira.json`. Ele fica fora do git porque guarda a sua posição real.

| Campo do `carteira.json` | O que é |
|---|---|
| `aporte` | Valor padrão do aporte mensal em R$ |
| `dyMinimo` | DY anual mínimo para comprar (`0.1` = 10%). Define o preço teto |
| `mesesMinimos` | Meses com provento nos últimos 12 para o FII poder ser comprado (`11` tolera um provento com data-com na borda da janela) |
| `rendaAlvo` | Opcional: renda mensal desejada na aposentadoria, em R$ |
| `fiis[].ticker` | Código na B3, ex.: `MXRF11` |
| `fiis[].peso` | Peso relativo na carteira (`1` para todos = pesos iguais; `2` = o dobro) |
| `fiis[].cotas` | Cotas que você já tem |

Os FIIs do exemplo servem só para mostrar o formato; não são recomendação.

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
